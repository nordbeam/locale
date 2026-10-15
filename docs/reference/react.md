# React adapter — `@nordbeam/locale/react`

React 18 and 19 adapters keep locale state isolated and hydration-safe.

```ts
import { createClientI18n, createReactI18n } from '@nordbeam/locale/react';
```

- `createReactI18n(loadLocale)` — adapter for a preloaded snapshot or controlled
  server render.
- `createSuspenseI18n(loadLocale)` — controlled Suspense resource adapter.
- `createClientI18n(loadLocale)` — state-owning provider, hooks, preload, and
  locale switching for browser apps.
- `rich` — re-export of the server-safe rich renderer.

Keep factories stable at module scope for application-wide client state. See
the [locale switcher recipe](../COOKBOOK.md#locale-switcher).

## `createClientI18n` Provider and hooks

- `Provider initialLocale` is read on mount only, like a `useState` initial
  value. Changing it later does nothing. Use `setLocale` to change the locale.
- `Provider preload` is live. A changed list starts loading its locales.
- `useSetLocale()` reads only the stable setter, so buttons that switch locales
  do not re-render on a switch.
- `useMessages()` and `useLocale()` re-render once per locale change, plus one
  suspended attempt during a cold switch.
- `usePending()` and `useI18n()` re-render when a cold switch starts and ends.
  Use `useMessages()` or `useSetLocale()` where that matters.
