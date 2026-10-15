import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, effectScope } from 'vue';
import { createVueI18n } from '../dist/vue.js';
import { compiled } from './helpers.mjs';

const catalogs = {
  en: { greeting: 'Hello {name}', cart: '{count, plural, one {# item} other {# items}}' },
  fr: { greeting: 'Bonjour {name}', cart: '{count, plural, one {# article} other {# articles}}' },
  ar: { greeting: 'مرحبا {name}', cart: '{count, plural, other {# عنصر}}' },
};
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

async function project(t) {
  const generated = await compiled(t, { baseLocale: 'en', catalogs });
  return generated.load('index.js');
}

// app.runWithContext gives composables an injection context without mounting.
function mountComposables(app, i18n, use) {
  const scope = effectScope();
  const value = scope.run(() => app.runWithContext(() => use(i18n)));
  return { value, stop: () => scope.stop() };
}

test('composables outside setup or without an installed plugin fail with clear errors', async t => {
  const { loadLocale } = await project(t);
  const i18n = createVueI18n({ initial: await loadLocale('en'), loadLocale });
  assert.throws(() => i18n.useMessages(), /inside setup\(\) or another composable/);
  const app = createApp({ render: () => null });
  assert.throws(() => mountComposables(app, i18n, instance => instance.useI18n()).value, /app\.use\(i18n\)/);
});

test('one plugin instance installed in two apps keeps separate locale state', async t => {
  const { loadLocale } = await project(t);
  const i18n = createVueI18n({ initial: await loadLocale('en'), loadLocale });
  const first = createApp({ render: () => null });
  const second = createApp({ render: () => null });
  first.use(i18n);
  second.use(i18n);
  const a = mountComposables(first, i18n, instance => instance.useI18n());
  const b = mountComposables(second, i18n, instance => instance.useI18n());
  await b.value.setLocale('fr');
  assert.equal(a.value.locale.value, 'en');
  assert.equal(b.value.locale.value, 'fr');
  a.stop();
  b.stop();
});

test('setLocale exposes pending while a cold locale loads, then commits locale and messages', async t => {
  const { loadLocale } = await project(t);
  const gate = deferred();
  const i18n = createVueI18n({
    initial: await loadLocale('en'),
    loadLocale: async locale => { if (locale === 'fr') await gate.promise; return loadLocale(locale); },
  });
  const app = createApp({ render: () => null });
  app.use(i18n);
  const { value: { locale, messages, pending, setLocale }, stop } = mountComposables(app, i18n, instance => instance.useI18n());

  const switching = setLocale('fr');
  assert.equal(pending.value, true);
  assert.equal(locale.value, 'en');
  assert.equal(messages.value.greeting({ name: 'Ada' }), 'Hello Ada');
  gate.resolve();
  assert.equal(await switching, true);
  assert.equal(pending.value, false);
  assert.equal(locale.value, 'fr');
  assert.equal(messages.value.greeting({ name: 'Ada' }), 'Bonjour Ada');
  stop();
});

test('a superseded switch resolves false and the last requested locale wins', async t => {
  const { loadLocale } = await project(t);
  const gates = { fr: deferred(), ar: deferred() };
  const started = [];
  const i18n = createVueI18n({
    initial: await loadLocale('en'),
    loadLocale: async locale => { started.push(locale); await gates[locale]?.promise; return loadLocale(locale); },
  });
  const app = createApp({ render: () => null });
  app.use(i18n);
  const { value: { locale, pending, setLocale }, stop } = mountComposables(app, i18n, instance => instance.useI18n());

  const toFrench = setLocale('fr');
  await tick();
  const toArabic = setLocale('ar');
  await tick();
  assert.deepEqual(started, ['fr', 'ar']);
  gates.fr.resolve();
  assert.equal(await toFrench, false);
  assert.equal(pending.value, true);
  assert.equal(locale.value, 'en');
  gates.ar.resolve();
  assert.equal(await toArabic, true);
  assert.equal(locale.value, 'ar');
  assert.equal(pending.value, false);
  stop();
});

test('selected loaders reload on locale switches and keep the old value until the new one is ready', async t => {
  const { loadLocale, selectMessages } = await project(t);
  const loadCart = selectMessages('cart');
  const gate = deferred();
  const i18n = createVueI18n({
    initial: await loadLocale('en'),
    loadLocale: async locale => { if (locale === 'fr') await gate.promise; return loadLocale(locale); },
  });
  const selected = async locale => { if (locale === 'fr') await gate.promise; return loadCart(locale); };
  const app = createApp({ render: () => null });
  app.use(i18n);
  const main = mountComposables(app, i18n, instance => instance.useI18n());
  const cart = await mountComposables(app, i18n, instance => instance.useMessages(selected)).value;
  assert.equal(cart.value.cart({ count: 2 }), '2 items');

  const switching = main.value.setLocale('fr');
  await tick();
  assert.equal(main.value.locale.value, 'en');
  assert.equal(cart.value.cart({ count: 2 }), '2 items');
  gate.resolve();
  assert.equal(await switching, true);
  await tick();
  assert.equal(main.value.locale.value, 'fr');
  assert.equal(cart.value.cart({ count: 2 }), '2 articles');
  main.stop();
});
