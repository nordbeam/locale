# Solid (Vite)

Package entries: `@nordbeam/locale/solid` (`createSolidI18n`), `nordbeam-locale/vite`. Each instance owns its locale state: one per app, or one per request on the server.

## Setup

```sh
npm install solid-js
npm install --save-dev vite-plugin-solid
npx nordbeam-locale init --framework solid
```

Init writes `vite.config.ts` with `solid()` and `nordbeamLocale()` only when `vite-plugin-solid` is declared and no Vite config exists; otherwise it prints a note and you add both plugins. It also creates `src/i18n/solid.ts`:

```ts
import { createSolidI18n } from '@nordbeam/locale/solid';
import { baseLocale, loadLocale } from './index';
import messages from './locales/en';

export const i18n = createSolidI18n({ initial: { locale: baseLocale, messages }, loadLocale });
```

## Use

Wrap the app once; Solid accessors are called, not read:

```tsx
// src/App.tsx
import { i18n } from './i18n/solid.js';

function Greeting() {
  const { messages, locale, pending, setLocale } = i18n.useI18n();
  return <>
    <p lang={locale()}>{messages().greeting({ name: 'Ada' })}</p>
    <button disabled={pending()} onClick={() => setLocale('de')}>Deutsch</button>
  </>;
}

export function App() {
  return <i18n.Provider><Greeting /></i18n.Provider>;
}
```

- `useI18n()` returns `{ locale, messages, pending, setLocale, preload }`; `locale`, `messages` and `pending` are accessors. Call them inside JSX or effects so reads stay reactive; never destructure their results once at setup.
- `setLocale(locale)` keeps the current locale visible while a cold catalog loads, sets `pending()` meanwhile, and resolves `false` when a newer request superseded it.
- Hooks outside a matching `i18n.Provider` throw `Nordbeam Locale: wrap this component in its matching i18n.Provider.`

## Selected loaders

```ts
import { selectMessages } from './i18n/index.js';
const loadPrice = selectMessages('price.label', 'price.amount');
const price = i18n.useMessages(loadPrice);   // Accessor<Selected | undefined>
```

`useMessages(loader)` is backed by `createResource`, reloads on locale change and keeps the previous value while loading. Its value contains functions and cannot be serialised into Solid's hydration data, so do not render it on the server.

## Server rendering and SolidStart

Create the instance inside the request handler and render text from `useI18n().messages()`:

```tsx
import { renderToString } from 'solid-js/web';

export function render(locale: 'en' | 'fr') {
  const i18n = createSolidI18n({ initial: /* loadLocale(locale) for this request */, loadLocale });
  return renderToString(() => <i18n.Provider><App /></i18n.Provider>);
}
```

The adapter has no SolidStart-specific dependency. Reference page: https://github.com/nordbeam/locale/blob/main/docs/reference/solid.md
