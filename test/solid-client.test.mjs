import test from 'node:test';
import assert from 'node:assert/strict';
import { createComponent, createEffect, createRoot } from 'solid-js';
import { createSolidI18n } from '../packages/locale/dist/solid.js';
import { compiled, waitFor } from './helpers.mjs';

// Reactivity needs Solid's client build, so run this file with
// `node --conditions=browser --test test/solid-client.test.mjs`.
const browserCondition = process.execArgv.includes('--conditions=browser') || process.env.NODE_OPTIONS?.includes('--conditions=browser');
const browserTest = (name, fn) => test(name, { skip: browserCondition ? false : 'run with --conditions=browser' }, fn);

const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};

async function fixture(t) {
  const project = await compiled(t, {
    baseLocale: 'en',
    catalogs: {
      en: { greeting: 'Hello {name}', items: '{count, plural, one {# item} other {# items}}', price: 'Price {amount}' },
      fr: { greeting: 'Bonjour {name}', items: '{count, plural, one {# article} other {# articles}}', price: 'Prix {amount}' },
      de: { greeting: 'Hallo {name}', items: '{count, plural, one {# Element} other {# Elemente}}', price: 'Preis {amount}' },
    },
  });
  const { loadLocale, selectMessages } = await project.load('index.js');
  // Cold loads wait on a gate so tests can observe pending and superseded switches.
  const holds = new Map();
  const gated = load => async locale => {
    await holds.get(locale)?.promise;
    return load(locale);
  };
  return {
    en: await loadLocale('en'),
    loadLocale: gated(loadLocale),
    loadPrice: gated(selectMessages('price')),
    hold(locale) { const hold = deferred(); holds.set(locale, hold); return hold; },
  };
}

// Runs fn inside a Provider owned by a fresh root, so hooks see the instance.
function mount(i18n, fn) {
  let result;
  let dispose;
  createRoot(d => {
    dispose = d;
    createComponent(i18n.Provider, { get children() { result = fn(); return null; } });
  });
  return { result, dispose };
}

browserTest('setLocale shows pending while a cold locale loads and re-runs readers once per commit', async t => {
  const { en, loadLocale, hold } = await fixture(t);
  const i18n = createSolidI18n({ initial: en, loadLocale });
  const seen = [];
  const pendings = [];
  const { result: state, dispose } = mount(i18n, () => {
    const state = i18n.useI18n();
    createEffect(() => { seen.push([state.locale(), state.messages().greeting({ name: 'Ada' })]); });
    createEffect(() => { pendings.push(state.pending()); });
    return state;
  });
  t.after(dispose);

  const gate = hold('fr');
  const switching = state.setLocale('fr');
  assert.equal(state.pending(), true);
  assert.equal(state.locale(), 'en');
  assert.equal(state.messages().greeting({ name: 'Ada' }), 'Hello Ada');
  gate.resolve();

  assert.equal(await switching, true);
  assert.equal(state.pending(), false);
  assert.equal(state.locale(), 'fr');
  assert.equal(state.messages().greeting({ name: 'Ada' }), 'Bonjour Ada');
  assert.deepEqual(seen, [['en', 'Hello Ada'], ['fr', 'Bonjour Ada']]);
  assert.deepEqual(pendings, [false, true, false]);
});

browserTest('superseded switches end on the last requested locale and clear pending only then', async t => {
  const { en, loadLocale, hold } = await fixture(t);
  const i18n = createSolidI18n({ initial: en, loadLocale });
  const { result: state, dispose } = mount(i18n, () => i18n.useI18n());
  t.after(dispose);

  const fr = hold('fr');
  const de = hold('de');
  const first = state.setLocale('fr');
  const second = state.setLocale('de');
  assert.equal(state.pending(), true);

  fr.resolve();
  assert.equal(await first, false);
  assert.equal(state.locale(), 'en');
  assert.equal(state.pending(), true);

  de.resolve();
  assert.equal(await second, true);
  assert.equal(state.locale(), 'de');
  assert.equal(state.messages().greeting({ name: 'Ada' }), 'Hallo Ada');
  assert.equal(state.pending(), false);
});

browserTest('a warm locale commits without pending, and setLocale to the current locale is a no-op commit', async t => {
  const { en, loadLocale } = await fixture(t);
  const i18n = createSolidI18n({ initial: en, loadLocale });
  const { result: state, dispose } = mount(i18n, () => i18n.useI18n());
  t.after(dispose);

  await state.preload('fr');
  const pendings = [];
  t.after(mount(i18n, () => createEffect(() => { pendings.push(i18n.useI18n().pending()); })).dispose);
  assert.equal(await state.setLocale('fr'), true);
  assert.equal(state.locale(), 'fr');
  assert.equal(await state.setLocale('fr'), true);
  assert.deepEqual(pendings, [false]);
});

browserTest('useMessages keeps the previous selection while the next locale loads', async t => {
  const { en, loadLocale, loadPrice, hold } = await fixture(t);
  const i18n = createSolidI18n({ initial: en, loadLocale });
  const seen = [];
  const { result: sel, dispose } = mount(i18n, () => {
    const state = i18n.useI18n();
    const sel = i18n.useMessages(loadPrice);
    createEffect(() => { seen.push(sel()?.price({ amount: 3 })); });
    return { state, sel };
  });
  t.after(dispose);

  await waitFor(() => sel.sel()?.price !== undefined, 'selected messages did not load');
  assert.equal(sel.sel().price({ amount: 3 }), 'Price 3');

  const gate = hold('fr');
  const switching = sel.state.setLocale('fr');
  assert.equal(sel.sel().price({ amount: 3 }), 'Price 3');
  gate.resolve();
  await switching;

  await waitFor(() => sel.sel()?.price({ amount: 3 }) === 'Prix 3', 'selected messages did not switch');
  assert.deepEqual(seen, [undefined, 'Price 3', 'Prix 3']);
});

browserTest('hooks outside a Provider throw a clear error', async t => {
  const { en, loadLocale } = await fixture(t);
  const i18n = createSolidI18n({ initial: en, loadLocale });
  createRoot(dispose => {
    t.after(dispose);
    assert.throws(() => i18n.useI18n(), /matching i18n\.Provider/);
  });
});
