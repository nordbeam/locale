import test from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'svelte/store';
import { createSvelteI18n } from '../packages/locale/dist/svelte.js';
import { compiled } from './helpers.mjs';

const catalogs = {
  en: { greeting: 'Hello {name}', items: '{count, plural, one {# item} other {# items}}' },
  fr: { greeting: 'Bonjour {name}', items: '{count, plural, one {# article} other {# articles}}' },
  de: { greeting: 'Hallo {name}', items: '{count, plural, one {# Artikel} other {# Artikel}}' },
};

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

// Gate every locale behind a deferred so tests choose the completion order.
async function gatedProject(t) {
  const project = await compiled(t, { baseLocale: 'en', catalogs });
  const generated = await project.load('index.js');
  const gates = new Map();
  const gate = locale => {
    const next = deferred();
    gates.set(locale, next);
    return next;
  };
  const gated = async locale => {
    await gates.get(locale)?.promise;
    return generated.loadLocale(locale);
  };
  return { ...generated, gated, release: locale => gates.get(locale)?.resolve(), gate };
}

test('stores expose the current locale synchronously and subscribe with the Svelte contract', async t => {
  const { loadLocale, selectMessages, gated } = await gatedProject(t);
  const initial = await loadLocale('en');
  const i18n = createSvelteI18n({ initial, loadLocale });
  const seen = [];
  const unsubscribe = i18n.locale.subscribe(value => seen.push(value));
  assert.deepEqual(seen, ['en']);
  assert.equal(get(i18n.messages).greeting({ name: 'Ada' }), 'Hello Ada');
  assert.equal(get(i18n.pending), false);
  unsubscribe();
  assert.equal(typeof selectMessages, 'function');
  assert.equal(typeof gated, 'function');
});

test('setLocale to a cold locale exposes pending while the previous messages stay visible', async t => {
  const { loadLocale, gated, release, gate } = await gatedProject(t);
  const initial = await loadLocale('en');
  const i18n = createSvelteI18n({ initial, loadLocale: gated });
  const pending = [];
  const messages = [];
  const unsubscribePending = i18n.pending.subscribe(value => pending.push(value));
  const unsubscribeMessages = i18n.messages.subscribe(value => messages.push(value.greeting({ name: 'Ada' })));
  gate('fr');
  const switching = i18n.setLocale('fr');
  assert.deepEqual(pending, [false, true]);
  assert.equal(get(i18n.locale), 'en');
  assert.equal(get(i18n.messages).greeting({ name: 'Ada' }), 'Hello Ada');
  release('fr');
  assert.equal(await switching, true);
  assert.equal(get(i18n.locale), 'fr');
  assert.equal(get(i18n.messages).greeting({ name: 'Ada' }), 'Bonjour Ada');
  assert.deepEqual(pending, [false, true, false]);
  assert.deepEqual(messages, ['Hello Ada', 'Bonjour Ada']);
  unsubscribePending();
  unsubscribeMessages();
});

test('a warm locale switches without exposing pending', async t => {
  const { loadLocale } = await gatedProject(t);
  const i18n = createSvelteI18n({ initial: await loadLocale('en'), loadLocale });
  await i18n.preload('fr');
  const pending = [];
  i18n.pending.subscribe(value => pending.push(value));
  assert.equal(await i18n.setLocale('fr'), true);
  assert.equal(get(i18n.messages).greeting({ name: 'Ada' }), 'Bonjour Ada');
  assert.deepEqual(pending, [false]);
});

test('a superseded switch resolves false and the last requested locale wins', async t => {
  const { loadLocale, gated, release, gate } = await gatedProject(t);
  const i18n = createSvelteI18n({ initial: await loadLocale('en'), loadLocale: gated });
  const pending = [];
  i18n.pending.subscribe(value => pending.push(value));
  gate('fr');
  gate('de');
  const first = i18n.setLocale('fr');
  const last = i18n.setLocale('de');
  release('fr');
  assert.equal(await first, false);
  assert.equal(get(i18n.locale), 'en', 'a superseded load never commits');
  assert.equal(get(i18n.pending), true, 'the newest request still owns pending');
  release('de');
  assert.equal(await last, true);
  assert.equal(get(i18n.locale), 'de');
  assert.equal(get(i18n.messages).greeting({ name: 'Ada' }), 'Hallo Ada');
  assert.equal(get(i18n.pending), false);
  assert.deepEqual(pending, [false, true, false]);
});

test('an earlier request finishing after the newest request does not clear pending or change the locale', async t => {
  const { loadLocale, gated, release, gate } = await gatedProject(t);
  const i18n = createSvelteI18n({ initial: await loadLocale('en'), loadLocale: gated });
  gate('fr');
  gate('de');
  const first = i18n.setLocale('fr');
  const last = i18n.setLocale('de');
  release('de');
  assert.equal(await last, true);
  release('fr');
  assert.equal(await first, false);
  assert.equal(get(i18n.locale), 'de');
  assert.equal(get(i18n.pending), false);
});

test('a failed cold switch rejects, clears pending and keeps the previous locale', async t => {
  const { loadLocale } = await gatedProject(t);
  const i18n = createSvelteI18n({
    initial: await loadLocale('en'),
    loadLocale: async locale => {
      if (locale === 'fr') throw new Error('offline');
      return loadLocale(locale);
    },
  });
  await assert.rejects(i18n.setLocale('fr'), /offline/);
  assert.equal(get(i18n.pending), false);
  assert.equal(get(i18n.locale), 'en');
});

test('select stores keep the previous selection until the next locale is ready', async t => {
  const { loadLocale, selectMessages, gated, release, gate } = await gatedProject(t);
  const i18n = createSvelteI18n({ initial: await loadLocale('en'), loadLocale: gated });
  const selectGreeting = selectMessages('greeting');
  const greetingLoader = async locale => { await gated(locale); return selectGreeting(locale); };
  const greeting = i18n.select(greetingLoader);
  assert.equal(get(greeting), undefined, 'a cold selection is not available synchronously');
  await i18n.preload('en', greetingLoader);
  const seen = [];
  const unsubscribe = greeting.subscribe(value => seen.push(value?.greeting({ name: 'Ada' })));
  assert.deepEqual(seen, ['Hello Ada']);
  gate('fr');
  const switching = i18n.setLocale('fr');
  assert.equal(get(greeting)?.greeting({ name: 'Ada' }), 'Hello Ada', 'the previous selection stays visible');
  release('fr');
  assert.equal(await switching, true);
  // A selection loads on its own schedule, so wait for the same cached load.
  await i18n.preload('fr', greetingLoader);
  assert.deepEqual(seen, ['Hello Ada', 'Bonjour Ada']);
  unsubscribe();
});

test('select loaders are cached per locale and per instance', async t => {
  const { loadLocale, selectMessages } = await gatedProject(t);
  const selectGreeting = selectMessages('greeting');
  let calls = 0;
  const counted = async locale => { calls += 1; return selectGreeting(locale); };
  const first = createSvelteI18n({ initial: await loadLocale('en'), loadLocale });
  const second = createSvelteI18n({ initial: await loadLocale('en'), loadLocale });
  await first.preload('fr', counted);
  await first.preload('fr', counted);
  assert.equal(calls, 1);
  await second.preload('fr', counted);
  assert.equal(calls, 2, 'another instance does not share cached selections');
});
