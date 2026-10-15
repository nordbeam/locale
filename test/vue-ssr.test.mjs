import test from 'node:test';
import assert from 'node:assert/strict';
import { createSSRApp, defineComponent, h, Suspense } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { createVueI18n } from '../dist/vue.js';
import { compiled } from './helpers.mjs';

const catalogs = {
  en: { greeting: 'Hello {name}', cart: '{count, plural, one {# item} other {# items}}' },
  fr: { greeting: 'Bonjour {name}', cart: '{count, plural, one {# article} other {# articles}}' },
  ar: { greeting: 'مرحبا {name}', cart: '{count, plural, other {# عنصر}}' },
};

async function project(t) {
  const generated = await compiled(t, { baseLocale: 'en', catalogs });
  return generated.load('index.js');
}

test('SSR renders the per-request locale and concurrent renders do not leak', async t => {
  const { loadLocale } = await project(t);
  async function render(locale) {
    const i18n = createVueI18n({ initial: await loadLocale(locale), loadLocale });
    const app = createSSRApp(defineComponent({
      setup() {
        const { messages, locale } = i18n.useI18n();
        return () => h('p', { lang: locale.value }, [
          messages.value.greeting({ name: 'Ada' }),
          ' / ',
          messages.value.cart({ count: 2 }),
        ]);
      },
    }));
    app.use(i18n);
    return renderToString(app);
  }
  const [en, fr, ar] = await Promise.all([render('en'), render('fr'), render('ar')]);
  assert.equal(en, '<p lang="en">Hello Ada / 2 items</p>');
  assert.equal(fr, '<p lang="fr">Bonjour Ada / 2 articles</p>');
  assert.equal(ar, '<p lang="ar">مرحبا Ada / 2 عنصر</p>');
});

test('SSR async selected loaders resolve under Suspense for each request', async t => {
  const { loadLocale, selectMessages } = await project(t);
  const loadCart = selectMessages('cart');
  async function render(locale) {
    const i18n = createVueI18n({ initial: await loadLocale(locale), loadLocale });
    const Cart = defineComponent({
      async setup() {
        const cart = await i18n.useMessages(loadCart);
        return () => h('p', cart.value.cart({ count: 1 }));
      },
    });
    const app = createSSRApp({ render: () => h(Suspense, null, { default: () => h(Cart) }) });
    app.use(i18n);
    return renderToString(app);
  }
  const [en, fr] = await Promise.all([render('en'), render('fr')]);
  assert.equal(en, '<p>1 item</p>');
  assert.equal(fr, '<p>1 article</p>');
});

test('SSR without the installed plugin fails with a clear error', async t => {
  const { loadLocale } = await project(t);
  const i18n = createVueI18n({ initial: await loadLocale('en'), loadLocale });
  const bare = createSSRApp(defineComponent({ setup() { i18n.useI18n(); return () => h('p'); } }));
  await assert.rejects(renderToString(bare), /app\.use\(i18n\)/);
});
