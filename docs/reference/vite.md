# Vite plugin — `@nordbeam/locale/vite`

The Vite adapter generates modules before imports resolve, watches catalog edits,
and can infer local message selection in development and production. It also
regenerates a [scope computed from code](../GUIDE.md#scopes-computed-from-code)
when one of the files it was computed from changes, in `vite dev` and in watch
builds.

```ts
import { nordbeamLocale } from '@nordbeam/locale/vite';
```

- `nordbeamLocale(options?)` — Vite plugin factory (also the default export).
  `nordbeamI18n` is a deprecated alias of the same function.
- `ViteOptions` — generation, selection fallback, and preload options.
- `SelectionFallbackMode`, `GenerateOptions`, and
  `NordbeamLocalePreloadManifest` — related public types. `NordbeamI18nPreloadManifest`
  is a deprecated alias.

The plugin is an ES module. In a package without `"type": "module"`, Vite
bundles `vite.config.ts` and `vitest.config.ts` as CommonJS and `require()`s the
plugin; every `@nordbeam/locale` entry has a `default` export condition for that,
and Node 22.12 or newer loads the module.

With `preloadManifest: true`, the client build emits `nordbeam-locale-preload.json`.

When a server build follows the client build in the same process, as in
`vite build` for TanStack Start, the server build's generated `loadLocale`
carries the client chunk URLs of each locale's catalog, so the
[TanStack Start adapter](tanstack-start.md#loading-and-hydration) can hint them
while rendering. This needs an absolute `base`, and costs nothing in the client bundle.

Selection runs after other plugins compile each module, so `.svelte` components and
Vue script blocks (`App.vue?vue&type=script…`) are narrowed once their script is
plain JavaScript. Modules that cannot import the generated catalog are not parsed.

When a recognized call cannot be proven, the plugin warns with a remedy. Follow
that warning before adding `selectMessages` manually; see the [guide](../GUIDE.md#vite-selection).
