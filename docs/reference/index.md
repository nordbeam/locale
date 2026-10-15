# Core runtime — `@nordbeam/locale`

The root entry contains the locale store and schema re-exports. It has no React,
Next, or Vite dependency.

```ts
import { createLocaleStore } from '@nordbeam/locale';
```

- `LoadedLocale<Locale, Messages>` — loaded locale and typed message map.
- `LocaleStore<Locale, Messages>` — synchronous reads plus async locale changes.
- `createLocaleStore({ initial, loadLocale })` — creates an isolated store for
  one browser app or server request. Loaded locales are cached per store, so
  switching back to one does not call `loadLocale` again. `preload(locale)`
  fills the cache without switching, and `invalidate(locale?)` drops cached
  entries (all of them when called without a locale) while keeping the current
  snapshot. Failed loads are never cached.
- `catalogSchema`, `configSchema`, and `JsonSchema` — re-exported editor helpers.

There is no global current locale. See the [cookbook](../COOKBOOK.md) for the
bootstrap and switcher pattern.
