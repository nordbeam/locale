# Vite + React

Package entries: `@nordbeam/locale/vite` (build plugin), `@nordbeam/locale/react` (client adapter), `@nordbeam/locale/react/rich` (rich text, also re-exported from `/react`). Supports React 18 and 19 and Vite 6, 7 and 8.

## Setup

```sh
npx nordbeam-locale init --framework vite-react
```

Creates `nordbeam-locale.config.json`, `messages/en.json`, `src/i18n/client.ts` and the generated modules; creates `vite.config.ts` only when no Vite config exists. If a config exists it is preserved, so add the plugin yourself:

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nordbeamLocale } from '@nordbeam/locale/vite';

export default defineConfig({ plugins: [react(), nordbeamLocale()] });
```

The plugin reads `nordbeam-locale.config.json` at the Vite root, generates before imports resolve, and regenerates on catalog edits. Options (for example `selectionFallback: 'off' | 'error'`, `preloadManifest: true`) are in https://github.com/nordbeam/locale/blob/main/docs/reference/vite.md

The scaffold `src/i18n/client.ts` is yours to edit:

```ts
import { createClientI18n } from '@nordbeam/locale/react';
import { loadLocale } from './index.js';

export const i18n = createClientI18n(loadLocale);
export { loadLocale };
```

Keep this factory at module scope: it owns the locale state for the app.

## Provider and hooks

```tsx
// src/App.tsx
import { i18n } from './i18n/client.js';

function Greeting() {
  const { messages: m, locale, setLocale, pending } = i18n.useI18n();
  return <>
    <p lang={locale}>{m.greeting({ name: 'Ada' })}</p>
    <button disabled={pending} onClick={() => setLocale('de')}>Deutsch</button>
  </>;
}

export function App() {
  return <i18n.Provider initialLocale="en"><Greeting /></i18n.Provider>;
}
```

- `Provider` props: `initialLocale` (read on mount only, like `useState`), `fallback` (shown while the first catalog loads; the provider owns the Suspense boundary), `preload` (a list of likely locales to fetch after hydration).
- `useI18n()` returns `{ locale, messages, setLocale, pending }`. Narrower hooks re-render less: `useMessages()`, `useLocale()`, `useSetLocale()` (stable setter, no re-render on a switch), `usePending()`.
- `setLocale(locale)` commits a cached locale immediately and keeps the current language visible while a cold locale loads, using a React transition automatically. It returns nothing to await (unlike the Vue, Svelte and Solid adapters); read `pending` for progress. No `useState`, `startTransition` or cache check is needed.
- `i18n.preload('fr')`, `i18n.isLoaded('fr')` and `i18n.invalidate('fr')` are available for intent prefetching and recovery. A rejected load reaches the nearest error boundary.
- `Locale` is a string-literal union from the generated module; type a `<select>` handler with `event.target.value as Locale` (`import type { Locale } from './i18n/index.js'`) and render options from `locales`.

## Switcher with direction

```tsx
import { i18n } from './i18n/client.js';
import { locales } from './i18n/index.js';
import type { Locale } from './i18n/index.js';

export function LocaleSwitcher() {
  const { locale, setLocale, pending } = i18n.useI18n();
  return (
    <select value={locale} disabled={pending} onChange={event => void setLocale(event.target.value as Locale)}>
      {locales.map(item => <option key={item} value={item}>{item}</option>)}
    </select>
  );
}
```

Set `document.documentElement.lang` and `dir` in an effect keyed on `locale` if the app supports right-to-left languages.

## Rich text

```tsx
import { rich } from '@nordbeam/locale/react/rich';

// "terms": "Read our <link>terms</link> and <b>privacy policy</b>."
<p>{rich(m.terms, { link: children => <a href="/terms">{children}</a>, b: children => <strong>{children}</strong> })}</p>
```

Each tag in the message is a required, typed slot callback; a missing or extra slot is a type error. `rich` adds React keys.

## Bundle selection

Under Vite, a literal call such as `const { messages: m } = await loadLocale('fr'); m.greeting(...)` is narrowed to the messages it uses in production. If the plugin cannot prove usage it warns with the location and the smallest remedy; the safe fallback is the full catalog. Fix the warning with an explicit selection at the boundary, kept at module scope:

```tsx
import { selectMessages } from './i18n/index.js';

const loadPrice = selectMessages('product.price', 'product.discount');

function Price() {
  const m = i18n.useMessages(loadPrice);
  return <p>{m.product.price({ amount: 20 })}</p>;
}
```

Selection is optional for correctness. Do not use dynamic keys or enumerate `messages`; they force the full catalog.

## Server rendering

For SSR or hydration with a preloaded snapshot use `createReactI18n` and pass the loaded locale:

```tsx
import { createReactI18n } from '@nordbeam/locale/react';
import { loadLocale } from './i18n/index.js';

export const i18n = createReactI18n(loadLocale);
const initial = await i18n.loadLocale('en');
// <i18n.Provider initial={initial}><App /></i18n.Provider>
```

Serialise only the locale string into the page, call `loadLocale` per request on the server, and construct the client store once during bootstrap. Never hold the current locale in module-global mutable state on the server. https://github.com/nordbeam/locale/blob/main/docs/GUIDE.md (Client and React) in the repository has the full SSR contract.

## Tests

```ts
import { createMessageTestHelpers } from '@nordbeam/locale/testing';
import type { Messages } from './i18n/index.js';
import { locales, loadLocale } from './i18n/index.js';

const testI18n = createMessageTestHelpers<Messages>();
testI18n.keyFromSelector(m => m.product.price); // "product.price"
const rendered = await testI18n.localeMatrix(locales, loadLocale, messages => messages.product.price({ amount: 12 }));
```

Pin `timeZone` in the config and pass fixed dates in snapshot tests.
