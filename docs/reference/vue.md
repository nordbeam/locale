# Vue adapter — `@nordbeam/locale/vue`

Vue 3 adapter for generated locale modules. Locale state lives on each Vue app
that installs the plugin, so there is no global current locale and server
renders can use one instance per request.

```bash
npm install @nordbeam/locale vue
```

```ts
import { createVueI18n } from '@nordbeam/locale/vue';
import { createSSRApp } from 'vue';
import { loadLocale, selectMessages } from './i18n/index.js';

const i18n = createVueI18n({ initial: await loadLocale('en'), loadLocale });
const app = createSSRApp(App);
app.use(i18n);
```

`createVueI18n({ initial, loadLocale })` returns:

- `install(app)` — the plugin. Each app gets its own store seeded from `initial`.
- `useI18n()` — `{ locale, messages, pending, setLocale, preload }` for `setup()`.
- `useMessages()` — the current `messages` as a `Readonly<ShallowRef<Messages>>`.
- `useMessages(loader)` — a selected loader's messages, as a promise (see below).

The composables are methods on the instance, not standalone exports. `Locale`
and `Messages` are inferred from `loadLocale`, so there is no generic to repeat
at each call site and no way to pass the wrong messages type.

```ts
const { locale, messages, pending, setLocale, preload } = i18n.useI18n();

messages.value.greeting({ name: 'Ada' });
await setLocale('fr'); // false if a newer switch superseded this one
```

- `locale` and `pending` are read-only refs.
- `messages` is a shallow ref. Message functions are never made deeply reactive.
- `pending` is true from the start of a `setLocale` call until the newest call
  settles. The previous locale stays visible while the next one loads.
- `preload(locale)` warms the catalogs for a locale before switching to it.

Calling a composable outside `setup()` or without `app.use(i18n)` throws a
Nordbeam Locale error.

## Selected loaders

Pass a loader from `selectMessages(...)` to load only the messages a component
uses:

```ts
const loadCart = selectMessages('cart', 'checkoutTotal');

export default defineComponent({
  async setup() {
    const cart = await i18n.useMessages(loadCart);
    return () => h('p', cart.value.cart({ count: 2 }));
  },
});
```

`useMessages(loader)` must be called synchronously in `setup()`, before any
`await`, so the reload watcher binds to the component. Wrap async setup in
`<Suspense>`. The returned ref reloads when the locale changes. During a switch,
`setLocale` loads mounted selections first, so messages and selections change
together. The previous value stays until the new one is ready.

## SSR

Create one instance per request, or one instance and one app per request. Each
app gets a fresh store:

```ts
const i18n = createVueI18n({ initial: await loadLocale(locale), loadLocale });
const app = createSSRApp(App);
app.use(i18n);
const html = await renderToString(app);
```

Do not call `setLocale` during server rendering. Pick the locale before the
app is created.

## Vite

`@nordbeam/locale/vite` infers selections from `loadLocale` and `selectMessages`
calls in `.js`/`.ts` modules. A raw `.vue` file is skipped. Calls inside
`<script>` blocks are only analyzed if the Vue plugin passes them to Vite's
transform hook under a script id. If selections fall back to the full catalog,
move the loader into a `.ts` module and import it into the component.

## Init

`nordbeam-locale init --framework vue` creates `src/i18n/vue.ts`, which exports
`i18n` and calls `createVueI18n` with the base locale. Register it once in the
entry file with `app.use(i18n)`. When `@vitejs/plugin-vue` is in `package.json`
and no Vite config exists, init also creates `vite.config.ts` with `vue()` and
`nordbeamLocale()`. An existing config is preserved. Re-running init reports the
files as existing and never replaces them.
