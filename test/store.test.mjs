import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocaleStore } from '../dist/index.js';

const state = locale => ({ locale, messages: { hello: () => locale } });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('a superseded load failure does not surface after a newer selection', async () => {
  const pending = deferred();
  const store = createLocaleStore({ initial: state('en'), loadLocale: locale => locale === 'fr' ? pending.promise : Promise.resolve(state(locale)) });
  const obsolete = store.setLocale('fr');
  await store.setLocale('de');
  pending.reject(new Error('old request failed'));
  assert.equal(await obsolete, false);
  assert.equal(store.getSnapshot().locale, 'de');
});

test('the latest locale request wins; subscribers see only applied changes', async () => {
  const fr = deferred(), de = deferred();
  const pending = { fr, de };
  const store = createLocaleStore({ initial: state('en'), loadLocale: locale => pending[locale].promise });
  const seen = [];
  const unsubscribe = store.subscribe(() => seen.push(store.getSnapshot().locale));
  const first = store.setLocale('fr');
  const last = store.setLocale('de');
  assert.equal(store.getSnapshot().locale, 'en');
  de.resolve(state('de'));
  assert.equal(await last, true);
  fr.resolve(state('fr'));
  assert.equal(await first, false);
  assert.equal(store.getSnapshot().messages.hello(), 'de');
  assert.equal(store.getMessages().hello(), 'de');
  assert.deepEqual(seen, ['de']);
  unsubscribe();
  await store.setLocale('fr');
  assert.deepEqual(seen, ['de']);
});

test('selecting the current locale cancels an in-flight switch', async () => {
  const fr = deferred();
  const store = createLocaleStore({ initial: state('en'), loadLocale: () => fr.promise });
  const change = store.setLocale('fr');
  assert.equal(await store.setLocale('en'), true);
  fr.resolve(state('fr'));
  assert.equal(await change, false);
  assert.equal(store.getSnapshot().locale, 'en');
});

test('load failures preserve the previous snapshot and stores are isolated', async () => {
  const initial = state('en');
  const store = createLocaleStore({ initial, loadLocale: async locale => { if (locale === 'fr') throw new Error('offline'); return state(locale); } });
  const other = createLocaleStore({ initial, loadLocale: async locale => state(locale) });
  const snapshot = store.getSnapshot();
  await assert.rejects(store.setLocale('fr'), /offline/);
  assert.equal(store.getSnapshot(), snapshot);
  await store.setLocale('de');
  assert.equal(other.getSnapshot().locale, 'en');
  assert.equal(initial.locale, 'en');
  assert.equal(Object.isFrozen(snapshot), true);
});

test('messages are available synchronously after bootstrap and follow applied locale changes', async () => {
  const store = createLocaleStore({ initial: state('en'), loadLocale: async locale => state(locale) });
  assert.equal(store.getMessages().hello(), 'en');
  await store.setLocale('fr');
  assert.equal(store.getMessages().hello(), 'fr');
});
