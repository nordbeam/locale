# Vite plugin — `@nordbeam/locale/vite`

The Vite adapter generates modules before imports resolve, watches catalog edits,
and can infer local message selection in development and production.

```ts
import { nordbeamLocale } from '@nordbeam/locale/vite';
```

- `nordbeamLocale(options?)` — Vite plugin factory (also the default export).
  `nordbeamI18n` is a deprecated alias of the same function.
- `ViteOptions` — generation, selection fallback, and preload options.
- `SelectionFallbackMode`, `GenerateOptions`, and
  `NordbeamLocalePreloadManifest` — related public types. `NordbeamI18nPreloadManifest`
  is a deprecated alias.

With `preloadManifest: true`, the client build emits `nordbeam-locale-preload.json`.

Selection runs after other plugins compile each module, so `.svelte` components and
Vue script blocks (`App.vue?vue&type=script…`) are narrowed once their script is
plain JavaScript. Modules that cannot import the generated catalog are not parsed.

When a recognized call cannot be proven, the plugin warns with a remedy. Follow
that warning before adding `selectMessages` manually; see the [guide](../GUIDE.md#vite-selection).
