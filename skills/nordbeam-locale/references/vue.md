# Vue 3 (Vite)

Package entries: `@nordbeam/locale/vue` (adapter), `nordbeam-locale/vite` (build plugin). Locale state lives on each Vue app that installs the plugin; there is no global current locale.

## Setup

```sh
npm install vue
npm install --save-dev @vitejs/plugin-vue
npx nordbeam-locale init --framework vue
```

Install `@vitejs/plugin-vue` first: init writes `vite.config.ts` (with `vue()` and `nordbeamLocale()`) only when the plugin is declared in `package.json` and no Vite config exists; otherwise it prints a note and you add both plugins yourself. An existing config is preserved. Init also creates `src/i18n/vue.ts`:

```ts
import { createVueI18n } from '@nordbeam/locale/vue';
import { baseLocale, loadLocale } from './index';
import messages from './locales/en';

export const i18n = createVueI18n({ initial: { locale: baseLocale, messages }, loadLocale });
```

(The scaffold imports the base locale statically so the instance exists synchronously; top-level `await` would fail Vite's default build targets.)

## Use

```ts
// src/main.ts
import { createApp } from 'vue';
import { i18n } from './i18n/vue.js';
import App from './App.vue';

createApp(App).use(i18n).mount('#app');
```

```vue
<script setup lang="ts">
import { i18n } from './i18n/vue.js';

const { messages, locale, pending, setLocale } = i18n.useI18n();
</script>

<template>
  <p :lang="locale">{{ messages.greeting({ name: 'Ada' }) }}</p>
  <button :disabled="pending" @click="setLocale('de')">Deutsch</button>
</template>
```

- The composables are methods on the instance (`i18n.useI18n()`, `i18n.useMessages()`), not standalone imports; types for `Locale` and `Messages` are inferred from `loadLocale`.
- `useI18n()` returns `{ locale, messages, pending, setLocale, preload }`. `locale` and `pending` are read-only refs; `messages` is a shallow ref, so in script read `messages.value.greeting(...)` and in templates `messages.greeting(...)`.
- `setLocale(locale)` keeps the previous locale visible until the new one is loaded and resolves `false` when a newer call superseded it. `preload(locale)` warms a locale.
- Calling a composable outside `setup()` or without `app.use(i18n)` throws a Nordbeam Locale error.
- Rich messages return an array; build nodes in the slot callbacks, for example `h('a', { href: '/terms' }, children)`.

## Selected loaders

```ts
import { selectMessages } from './i18n/index.js';
const loadCart = selectMessages('cart', 'checkoutTotal');

// async setup(); call useMessages synchronously, before any await, and wrap the component in <Suspense>
const cart = await i18n.useMessages(loadCart);
// cart.value.cart({ count: 2 })
```

Put `selectMessages(...)` calls in a `.ts` module and import them into the component; the Vite plugin analyses `.js`/`.ts` modules, not raw `.vue` files, and falls back to the full catalog otherwise.

## SSR

Create one instance per request and pick the locale before the app is created; never call `setLocale` during server rendering:

```ts
const i18n = createVueI18n({ initial: await loadLocale(locale), loadLocale });
const app = createSSRApp(App);
app.use(i18n);
const html = await renderToString(app);
```

Reference page: https://github.com/nordbeam/locale/blob/main/docs/reference/vue.md
