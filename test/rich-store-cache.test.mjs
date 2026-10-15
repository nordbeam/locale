import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocaleStore } from '../dist/index.js';

const state = locale => ({ locale, messages: { hello: () => locale } });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function counting(load = async locale => state(locale)) {
  const calls = [];
  const loadLocale = locale => { calls.push(locale); return load(locale); };
  return { calls, loadLocale };
}

test('switching back to a loaded locale resolves without calling the loader again', async () => {
  const { calls, loadLocale } = counting();
  const store = createLocaleStore({ initial: state('en'), loadLocale });
  const seen = [];
  store.subscribe(() => seen.push(store.getSnapshot().locale));
  assert.equal(await store.setLocale('fr'), true);
  assert.equal(await store.setLocale('en'), true);
  assert.equal(await store.setLocale('fr'), true);
  assert.equal(await store.setLocale('fr'), true);
  assert.deepEqual(calls, ['fr']);
  assert.deepEqual(seen, ['fr', 'en', 'fr']);
  assert.equal(store.getMessages().hello(), 'fr');
});

test('the initial locale is seeded into the cache', async () => {
  const { calls, loadLocale } = counting();
  const store = createLocaleStore({ initial: state('en'), loadLocale });
  await store.setLocale('fr');
  assert.equal(await store.setLocale('en'), true);
  assert.equal(store.getSnapshot().locale, 'en');
  assert.deepEqual(calls, ['fr']);
});

test('a cached switch still resolves asynchronously and replaces the snapshot', async () => {
  const { loadLocale } = counting();
  const store = createLocaleStore({ initial: state('en'), loadLocale });
  await store.setLocale('fr');
  const switching = store.setLocale('en');
  assert.equal(store.getSnapshot().locale, 'fr');
  assert.equal(await switching, true);
  assert.equal(store.getSnapshot().locale, 'en');
  assert.equal(Object.isFrozen(store.getSnapshot()), true);
});

test('preload fills the cache without switching the current snapshot', async () => {
  const { calls, loadLocale } = counting();
  const store = createLocaleStore({ initial: state('en'), loadLocale });
  const before = store.getSnapshot();
  await store.preload('fr');
  assert.equal(store.getSnapshot(), before);
  assert.equal(store.getMessages().hello(), 'en');
  assert.deepEqual(calls, ['fr']);
  assert.equal(await store.setLocale('fr'), true);
  assert.equal(store.getMessages().hello(), 'fr');
  assert.deepEqual(calls, ['fr']);
});

test('preload of the current or an already loaded locale does not call the loader', async () => {
  const { calls, loadLocale } = counting();
  const store = createLocaleStore({ initial: state('en'), loadLocale });
  await store.preload('en');
  await store.preload('fr');
  await store.preload('fr');
  assert.deepEqual(calls, ['fr']);
});

test('preload and setLocale share one in-flight load', async () => {
  const fr = deferred();
  const { calls, loadLocale } = counting(() => fr.promise);
  const store = createLocaleStore({ initial: state('en'), loadLocale });
  const preloading = store.preload('fr');
  const switching = store.setLocale('fr');
  fr.resolve(state('fr'));
  await preloading;
  assert.equal(await switching, true);
  assert.deepEqual(calls, ['fr']);
  assert.equal(store.getMessages().hello(), 'fr');
});

test('invalidate(locale) drops one cached locale and keeps the current snapshot', async () => {
  const { calls, loadLocale } = counting();
  const store = createLocaleStore({ initial: state('en'), loadLocale });
  await store.setLocale('fr');
  await store.preload('de');
  const snapshot = store.getSnapshot();
  store.invalidate('fr');
  assert.equal(store.getSnapshot(), snapshot);
  await store.setLocale('en');
  await store.setLocale('fr');
  await store.setLocale('de');
  assert.deepEqual(calls, ['fr', 'de', 'fr']);
});

test('invalidate() without a locale drops every cached entry, including the initial one', async () => {
  const { calls, loadLocale } = counting();
  const store = createLocaleStore({ initial: state('en'), loadLocale });
  await store.setLocale('fr');
  store.invalidate();
  assert.equal(store.getSnapshot().locale, 'fr');
  await store.setLocale('en');
  await store.setLocale('fr');
  assert.deepEqual(calls, ['fr', 'en', 'fr']);
  assert.equal(store.getMessages().hello(), 'fr');
});

test('invalidating the current locale does not change the snapshot until another locale is applied', async () => {
  const { calls, loadLocale } = counting();
  const store = createLocaleStore({ initial: state('en'), loadLocale });
  const snapshot = store.getSnapshot();
  store.invalidate('en');
  assert.equal(await store.setLocale('en'), true);
  assert.equal(store.getSnapshot(), snapshot);
  assert.deepEqual(calls, []);
});

test('a rejected load is not cached: the next request calls the loader again', async () => {
  let attempts = 0;
  const { calls, loadLocale } = counting(async locale => {
    if (locale === 'fr' && ++attempts === 1) throw new Error('offline');
    return state(locale);
  });
  const store = createLocaleStore({ initial: state('en'), loadLocale });
  await assert.rejects(store.setLocale('fr'), /offline/);
  assert.equal(store.getSnapshot().locale, 'en');
  assert.equal(await store.setLocale('fr'), true);
  assert.equal(store.getMessages().hello(), 'fr');
  assert.deepEqual(calls, ['fr', 'fr']);
});

test('a rejected preload is not cached and rejects its caller', async () => {
  let attempts = 0;
  const { calls, loadLocale } = counting(async locale => {
    if (++attempts === 1) throw new Error('offline');
    return state(locale);
  });
  const store = createLocaleStore({ initial: state('en'), loadLocale });
  await assert.rejects(store.preload('fr'), /offline/);
  await store.preload('fr');
  assert.equal(await store.setLocale('fr'), true);
  assert.deepEqual(calls, ['fr', 'fr']);
});

test('a loader returning another locale rejects and is not cached', async () => {
  let attempts = 0;
  const { calls, loadLocale } = counting(async locale => state(++attempts === 1 ? 'de' : locale));
  const store = createLocaleStore({ initial: state('en'), loadLocale });
  await assert.rejects(store.setLocale('fr'), /Locale loader returned de for fr/);
  assert.equal(await store.setLocale('fr'), true);
  assert.deepEqual(calls, ['fr', 'fr']);
});

test('a superseded cached switch still returns false while the newest request wins', async () => {
  const fr = deferred(), de = deferred();
  const pending = { fr, de };
  const { calls, loadLocale } = counting(locale => pending[locale].promise);
  const store = createLocaleStore({ initial: state('en'), loadLocale });
  const first = store.setLocale('fr');
  const last = store.setLocale('de');
  de.resolve(state('de'));
  assert.equal(await last, true);
  fr.resolve(state('fr'));
  assert.equal(await first, false);
  assert.equal(store.getMessages().hello(), 'de');
  assert.equal(await store.setLocale('en'), true);
  assert.equal(await store.setLocale('fr'), true);
  assert.deepEqual(calls, ['fr', 'de']);
  assert.equal(store.getMessages().hello(), 'fr');
});

test('a superseded failure after a cached switch does not surface', async () => {
  const fr = deferred();
  const { loadLocale } = counting(locale => locale === 'fr' ? fr.promise : Promise.resolve(state(locale)));
  const store = createLocaleStore({ initial: state('en'), loadLocale });
  const obsolete = store.setLocale('fr');
  assert.equal(await store.setLocale('en'), true);
  fr.reject(new Error('old request failed'));
  assert.equal(await obsolete, false);
  assert.equal(store.getSnapshot().locale, 'en');
});

test('invalidating an in-flight locale does not cache its result', async () => {
  const fr = deferred();
  const { calls, loadLocale } = counting(() => fr.promise);
  const store = createLocaleStore({ initial: state('en'), loadLocale });
  const switching = store.setLocale('fr');
  store.invalidate('fr');
  fr.resolve(state('fr'));
  assert.equal(await switching, true);
  await store.setLocale('en');
  await store.setLocale('fr');
  assert.deepEqual(calls, ['fr', 'fr']);
});
