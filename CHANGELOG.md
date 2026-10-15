# Changelog

All notable changes to `@nordbeam/locale` and `@nordbeam/locale-migrate` are
documented here. The project follows [Semantic Versioning](https://semver.org/);
before 1.0, minor versions may contain breaking changes, and they are called
out in this file.

## Unreleased

### `@nordbeam/locale`

- **TanStack Start: hydration no longer blanks the page while the catalog
  loads.** The `Provider` suspended when hydration reached a catalog that was
  still loading. The first update above it, such as an effect that sets state,
  then made React replace the server HTML with the empty fallback until the
  catalog arrived. `routerOptions()` now also returns the router's `hydrate`
  hook, which TanStack awaits before React hydrates. Apps that spread
  `routerOptions()` get it without changes. If you pass your own `hydrate`, call
  `options.hydrate()` from it.
- **TanStack Start: `beforeLoad: i18n.beforeLoad` keeps the root route typed.**
  The parameter type declared `matches`, which TanStack types from the
  registered router. When a file with a typed `Link` was checked before the
  root route, TypeScript reported `Route` and `getRouter` as circular (TS7022,
  TS7023). The parameter type no longer declares `matches`. A direct call that
  passes `matches` in an object literal must drop it or cast.
- **TanStack Start: the server hints the page's catalog chunk.** The browser
  requested the catalog only once the entry ran the `hydrate` hook, one round
  trip after the entry chunk. In a production build, the Vite plugin now gives
  the server build the client chunks of each locale's catalog, and the
  `Provider` emits them in `<head>` (React 19) as low-priority
  `<link rel="preload" as="script">`, so the catalog downloads with the entry.
  On Nordsynk's production build, hydration came 0.1 to 0.3 s earlier with
  first paint unchanged; a high-priority `modulepreload` delayed first paint
  by up to 1.1 s on slow 4G. A wrapper around the generated `loadLocale` keeps
  the hint with `Object.assign(wrapper, loadLocale)`. `react-dom` is now an
  optional peer dependency.
- **TanStack Start: `getLocale()` returns `undefined` outside a request**, as
  documented, instead of throwing Start's "No Start context found" error in
  queue consumers, scheduled handlers and module scope.
- **Notes about messages.** A notes file shaped like a catalog, named with
  `"notes"` in the config, holds context for translators and developers:
  where a text appears, what an argument holds, or that legal reviews every
  change. A note shows beside its message in editor hovers (`@remarks`) and as
  `#.` comments in PO exports (`serializePo` takes `notes` too), and `rename`
  moves it with its message. `check` and `generate` warn with `UNKNOWN_NOTE`
  for a note whose message is gone, and refuse a malformed notes file or one in
  the catalog directory with `INVALID_NOTES`. Catalogs still hold message text
  only.
- **`init --framework tanstack-start`** no longer suggests calling
  `routerOptions()` twice to merge your own router context. Two calls create
  two router states.
- **`codemod --messages-hook <name>`** passes the new codemod option through
  (see below).

### `@nordbeam/locale-migrate`

- **Codemod: `messagesHook` binds the messages object through a hook.** With
  `--messages-import ~/i18n --messages-hook useMessages`, each formatter hook
  whose calls were all rewritten (`const t = useT()`) becomes
  `const m = useMessages()`. A hook that skipped calls keep alive gets
  `const m = useMessages();` on the next line. The hook is imported instead of
  `m`. On Nordsynk's 185 rewritten files, unbound `m` warnings fell from 185
  files to 47, all of them functions that receive `t` as a parameter. Before,
  a hook-based wrapper left every rewritten file with an unbound `m`
  (`MISSING_MESSAGES_BINDING`). A side-effect import of the `messagesImport`
  module now becomes the named import instead of a second import.
- **Codemod: custom calls under `--format auto` are judged once.** Each custom
  call went through every format's rules. A values argument
  (`t('key', { plan })`) was rewritten by one pass and reported as an
  unsupported svelte-i18n option by another, so `--strict` refused a complete
  migration. A custom call now belongs to the format that detected the same
  callee, or else to a pass that passes values through unchanged.
- **`migrate --format module` reads dictionaries kept in TypeScript or
  JavaScript**, as typesafe-i18n, next-international and hand-written apps keep
  them. The file is parsed, never run: the default export (with `as const` or
  `satisfies`), `module.exports`, or the only exported object. String literals,
  plain template literals and `+` joins migrate; computed values and spreads
  are skipped with `MIGRATION_UNSUPPORTED_VALUE`. `inferMigrationFormat` maps
  `.ts`, `.mts`, `.cts`, `.js`, `.mjs` and `.cjs` to it.
- **`migrate --notes <file>` keeps descriptions.** Comments above a message in
  a dictionary module, FormatJS `description` fields and ARB `@key`
  descriptions become a notes file instead of being dropped.
- **Codemod: a kept side-effect import keeps its line.** When a custom
  formatter import lost its last name, the `import '…';` left in its place was
  joined onto the next line, and its quotes became double quotes.

## 0.2.2

No code changes. The three packages are republished together at one version.

## 0.2.1

The first public release. 0.2.0 was published briefly and withdrawn because its
package metadata listed scripts from the development repository.

### `@nordbeam/locale`

- **Compiler.** ICU MessageFormat catalogs compile to typed, tree-shakable
  JavaScript. Each message is a generated function over the platform `Intl`
  APIs: no runtime parser and no `eval`. Locales load lazily, with explicit or
  Vite-inferred message selection and scopes as bundle boundaries.
- **Framework adapters.** Vite plugin; React (provider, hooks, rich text,
  Server Components); Next.js App Router (`withNordbeamLocale`, routing with
  locale prefixes, localized pathnames and domains, middleware, navigation,
  and server helpers); TanStack Start (router `rewrite` for locale prefixes
  and localized pathnames, request middleware with the same redirect, cookie,
  and `hreflang` rules as Next.js, SSR with `<html lang dir>`, locale-aware
  links, and the request locale in server functions); Vue; Svelte; Solid; and
  plain TypeScript/Node.
- **CLI.** `init` scaffolds each framework without replacing existing files
  (for Next.js, the request file goes beside `app/` or `src/app/`);
  `check`, generation, `verify`, `doctor`, `inspect`, and `explain <CODE>`.
  Every diagnostic has a registered code with a documented fix.
- **Agent tooling.** `capabilities --json`, `agent-guide`, versioned JSON and
  NDJSON envelopes, stable exit codes, hash-bound `--plan` / `apply-plan`
  writes, and a stdio MCP server (`nordbeam-locale mcp`).
- **Agent skills.** `nordbeam-locale` (setup, catalogs, ICU, the typed API,
  and the check/generate/verify loop for every framework) and
  `nordbeam-locale-migrate` (moving from other i18n libraries). Install them
  with `npx skills add nordbeam/locale`, from the Claude Code plugin
  marketplace (`/plugin marketplace add nordbeam/locale`), or from the
  installed package with `nordbeam-locale skills install` or `init --agent`,
  which never overwrites skill files you have edited.
- **Translation workflow.** PO export and import, pseudo-localization, a
  development inspector, a persistent compile cache, and JSON schemas for
  configuration and catalogs.

### `@nordbeam/locale-migrate`

- Catalog conversion from i18next, next-intl, FormatJS, Lingui, vue-i18n,
  Tolgee, PO, and other formats. vue-i18n pipe plurals, plain linked
  messages, and list placeholders become ICU; i18next rich-text tags become
  ICU tags (`<0>` becomes `<tag0>`), and `locales/<locale>/<namespace>.json`
  folders are read. Constructs with no faithful ICU form are skipped with a
  diagnostic code instead of being copied as text.
- Source codemods and project migrations for i18next/react-i18next,
  next-intl, FormatJS/react-intl, Lingui, and Vue/Svelte/Angular framework
  planners, with preview, plans, and residue audits. next-intl projects are
  rewritten in place (request file, routing, navigation, `next.config`), with
  the remaining manual steps listed in the plan.
- Split from the core package so runtime users don't install the migration
  parsers. The CLI loads it on demand and requires the same version as
  `@nordbeam/locale`.

### `nordbeam-locale`

- Runs the `@nordbeam/locale` CLI of the same version, so
  `npx nordbeam-locale init` works before the project depends on
  `@nordbeam/locale`.

### Editor

- VS Code extension: typed navigation, extraction, rename, missing-translation
  repair, and verification.
