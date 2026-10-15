# Solid adapter — `@nordbeam/locale/solid`

SolidJS bindings for generated locale modules. Each instance owns its own
locale state, so create one per app, or one per request on the server.

```ts
import { createSolidI18n } from '@nordbeam/locale/solid';
import { loadLocale } from './i18n/index.js';

export const i18n = createSolidI18n({
  initial: await loadLocale('en'),
  loadLocale,
});
```

## Provider and hooks

```tsx
<i18n.Provider>
  <App />
</i18n.Provider>
```

- `i18n.useI18n()` returns `{ locale, messages, pending, setLocale, preload }`.
  `locale`, `messages` and `pending` are Solid accessors: call them to read.
- `setLocale(locale)` keeps the current locale visible while a cold catalog
  loads, sets `pending()` to `true` during that load, and resolves to `false`
  when a newer request superseded it. Warm locales commit without `pending`.
- `preload(locale)` loads a catalog into the instance cache ahead of time.
- `i18n.useMessages(loader)` returns `Accessor<Selected | undefined>` for a
  selected loader such as `selectMessages('price')`. It reloads when the
  committed locale changes and keeps the previous value while the next one
  loads.

Calling a hook outside the matching `Provider` throws
`Nordbeam Locale: wrap this component in its matching i18n.Provider.`

## Server rendering

Create the instance inside the request handler so locale state never crosses
requests:

```ts
import { renderToString } from 'solid-js/web';

export function render(locale: 'en' | 'fr') {
  const i18n = createSolidI18n({ initial: /* loaded for this request */, loadLocale });
  return renderToString(() => <i18n.Provider><App /></i18n.Provider>);
}
```

Read `useI18n().messages()` during render. `useMessages` is backed by
`createResource`, and its value (message functions) cannot be serialized into
Solid's hydration data, so do not render it on the server. Use
`useI18n().messages()` for server-rendered text.

## Selected loaders

```ts
import { selectMessages } from './i18n/index.js';

const loadPrice = selectMessages('price.label', 'price.amount');
const price = i18n.useMessages(loadPrice);
```

Selected loaders are cached per loader and locale within an instance.

## SolidStart

Use one instance per request in the server entry and the same module-level
instance pattern on the client. The adapter has no SolidStart-specific
dependency; it only needs `solid-js` at runtime.

## Testing

The reactivity tests need Solid's client build:

```sh
node --conditions=browser --test test/solid-client.test.mjs
node --test test/solid-ssr.test.mjs
```

## Init

`nordbeam-locale init --framework solid` creates `src/i18n/solid.ts`, which
exports `i18n` from `createSolidI18n` with the base locale. Wrap the application
once in `<i18n.Provider>`. When `vite-plugin-solid` is in `package.json` and no
Vite config exists, init also creates `vite.config.ts` with `solid()` and
`nordbeamLocale()`. An existing config is preserved, and re-running init never
replaces the adapter.
