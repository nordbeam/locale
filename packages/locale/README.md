# @nordbeam/locale

The runtime of [Nordbeam Locale](https://github.com/nordbeam/locale#readme): the
locale store, the React, Vue, Svelte, Solid, Next.js and TanStack Start adapters,
`rich()` for messages with tags, and the development inspector. It has no
dependencies.

Messages are compiled by [`nordbeam-locale`](https://www.npmjs.com/package/nordbeam-locale),
the CLI, compiler and Vite plugin. Install both at the same version, the runtime
as a dependency and the tooling as a devDependency:

```sh
npm install @nordbeam/locale
npm install --save-dev nordbeam-locale
npx nordbeam-locale init --framework <next|vite-react|tanstack-start|vue|svelte|solid>
```

| Entry | Use |
| --- | --- |
| `@nordbeam/locale` | `createLocaleStore` |
| `@nordbeam/locale/react`, `/react/rich` | React provider, hooks and `rich()` |
| `@nordbeam/locale/vue`, `/svelte`, `/solid` | Component framework adapters |
| `@nordbeam/locale/next` | `withNordbeamLocale()` for `next.config` |
| `@nordbeam/locale/next/runtime`, `/middleware`, `/navigation`, `/routing`, `/server` | Next.js App Router |
| `@nordbeam/locale/tanstack-start` | TanStack Start |
| `@nordbeam/locale/inspector` | Development inspector overlay |

See the [package reference](https://github.com/nordbeam/locale/blob/main/docs/reference/README.md).
