# Changelog

All notable changes to `@nordbeam/locale` and `@nordbeam/locale-migrate` are
documented here. The project follows [Semantic Versioning](https://semver.org/);
before 1.0, minor versions may contain breaking changes, and they are called
out in this file.

## Unreleased

Breaking: the runtime and the build tooling are now separate packages, so a
production install carries only the runtime. The rest are fixes and additions
from migrating a production app (13,899 messages in four locales) from Lingui 3,
with one more type change, in the TanStack Start adapter:
`useHtmlAttributes().lang` is typed `string` (it was the locale type).

### Two packages

- **`@nordbeam/locale` is the runtime**: the locale store, the React, Vue,
  Svelte, Solid, Next.js and TanStack Start adapters, `rich()` and the
  development inspector. It has no dependencies. An application keeps it in
  `dependencies`. A production install (`npm install --omit=dev`) is one
  package and 0.7 MB on disk, where 0.4.0 installed eight packages and 9.7 MB:
  the compiler, the CLI, `oxc-parser` with its native binding, and the
  `@formatjs` parser.
- **`nordbeam-locale` is the tooling**: the CLI, the compiler, the Vite plugin,
  the test helpers, the agent APIs and the MCP server. Add it to
  `devDependencies` at the same version. The package used to be a shim that
  ran the CLI of `@nordbeam/locale`; `npx nordbeam-locale` now runs the real
  thing.
- **Moving.** Install both packages, then change the tooling imports:
  `@nordbeam/locale/vite` becomes `nordbeam-locale/vite`, and the same for
  `/compiler`, `/project`, `/translations`, `/po`, `/schema`, `/config`,
  `/pseudo`, `/testing`, `/agent`, `/agent/plans`, `/agent/events`,
  `/agent/inspect` and `/mcp`. `catalogSchema` and `configSchema` are no
  longer exported from `@nordbeam/locale`; import them from
  `nordbeam-locale/schema`. Application imports (`@nordbeam/locale/react`,
  `/react/rich`, `/tanstack-start`, `/next/runtime` and the rest) do not change.
- `withNordbeamLocale()` stays at `@nordbeam/locale/next`, because `next start`
  loads `next.config` in production too. It loads `nordbeam-locale` for
  `next dev` and `next build`, and at `next start` returns the configuration
  without generating, since the build already compiled the messages.
- `@nordbeam/locale-migrate` peers on `nordbeam-locale` instead of
  `@nordbeam/locale`.
- `init` says which packages to install, as `notes`: the runtime when it
  scaffolds framework files that import it, and the tooling when
  `package.json` does not list it. `capabilities --json` reports `product:
  "nordbeam-locale"`, and installed skills record `nordbeam-locale` as their
  package.

### `nordbeam-locale` and `@nordbeam/locale`

- **Scopes read non-ASCII names.** The crawl behind scopes computed from code
  matched property chains with an ASCII-only pattern, so `m.för()` and
  `m.Sökförslag()` were left out of the scope, and an import that names a
  non-ASCII binding (`import { Sökruta } from …`) was not followed. Pages then
  threw `m.för is not a function` in production while the full catalog, which
  tests render, had the message. Chains now follow JavaScript's identifier
  rules, and a segment may be a string key (`m.video['för']()`).
- **Why is a message in a scope?** `nordbeam-locale inspect --scope <name>`
  lists the files the crawl read, with the number of messages each one is the
  first to name and whether it sits behind a dynamic `import()`, and how many
  messages the scope would hold without dynamic imports. `--id <message-id>`
  prints the import chain that brought one message in. `inspectScope` returns
  the same from `@nordbeam/locale/agent/inspect`, and the `report` page shows
  each computed scope's file count and the dynamic-import trade-off.
- **Computed reads warn.** The crawl cannot tell which message `m[key]()` or
  `m.status[state]()` reads, so a scope could lack it and the page fail in
  production. `check`, `generate`, `inspect` and `report` now warn about each
  such read in a file a scope reads, naming every scope it affects:
  `SCOPE_DYNAMIC_ACCESS`. A template key with the ID's start
  (`` m[`status.${state}`]() ``) is read as a pattern and does not warn, and a
  `nordbeam-locale-ignore` comment on the line or the line above keeps a
  checked read quiet.
- **`"dynamicImports": false` on a scope** stops the crawl at dynamic
  `import()` calls, for code split off behind a boundary that loads the full
  catalog anyway. In the migrated app it took two scopes from 525 and 767
  messages to 402 and 644; the hand-maintained Lingui scopes held 392 and 623.
- **Arguments only a translation uses.** A translation could not use an
  argument the base text leaves out (`UNKNOWN_ARGUMENT`), even when every call
  passes it, such as a Finnish subtitle that shows a price the English one
  omits. Declare it in the config: `"arguments": { "pricing.subtitle":
  { "price": "value" } }`. The argument becomes part of the message's type and
  of the development checks in every locale, and the `UNKNOWN_ARGUMENT` hint
  names the declaration. New error: `INVALID_DECLARED_ARGUMENT`. See
  [arguments only a translation uses](docs/GUIDE.md#arguments-only-a-translation-uses).
- **Locale codes that mean another language.** A new `intlLocales` config key
  maps a locale code to the BCP 47 tag `Intl` formats it with. `{ "se": "sv" }`
  keeps `messages/se.json`, `locales/se.js` and `loadLocale('se')`, and formats
  `se` as Swedish instead of Northern Sami. Plural rules, number and date
  formatters, ICU skeletons, the `MISSING_PLURAL_CATEGORY` check and the PO
  `Language` header use the tag; `X-Nordbeam-Locale` keeps the code, and PO
  import accepts either. When the config maps a locale, the generated
  `index.js` also exports `intlLocales`. New errors: `UNKNOWN_INTL_LOCALE` and
  `INVALID_INTL_LOCALE`. See
  [locale codes that mean another language](docs/GUIDE.md#locale-codes-that-mean-another-language).
- The Next.js and TanStack Start routing take the generated `intlLocales`:
  `Accept-Language` matches the tag (`sv-SE` selects `se`), the alternate
  `Link` header writes it as `hreflang`, and TanStack Start's
  `useHtmlAttributes()` writes it as `lang`. `intlLocaleOf(routing, locale)`
  returns it. **Type change:** `useHtmlAttributes().lang` is typed `string`.
- **`verify` passes after a production build.** `verify` compared the output
  with the mode `NODE_ENV` implies, so after `vite build` or `next build` wrote
  production output, a check without `NODE_ENV` failed with `GENERATED_STALE`
  ("generation options changed"). Without a flag or `NODE_ENV`, `verify` and
  `inspect` now accept output generated in either mode and report it as
  `freshness.mode`. `--production` and `--development`, new on both commands,
  make the mode a requirement, and the stale reason then says which mode the
  output is in.
- **`init` writes `"prebuild": "nordbeam-locale --production"`.** It wrote
  `nordbeam-locale`, which generates development output, with argument guards,
  before a production build.
- **`init` keeps generated code out of linters and formatters.** It adds the
  generated directory to `.eslintignore`, `.prettierignore`, `.oxlintrc.json`
  and `.oxfmtrc.json` when they exist, and says what to add to a flat
  `eslint.config.*` or a Biome config. In the migrated app, linting the
  generated output added 6,700 ESLint errors.
- **`doctor` warns when an apostrophe joins two quoted runs.** In ICU,
  `'<br/>''<br/>'` is one quoted run that contains an escaped apostrophe, so
  it renders `<br/>'<br/>`. It is valid, and almost always a quoting mistake.
  The new `QUOTED_RUN_APOSTROPHE` warning shows what the run renders and the
  single run to write instead. It found 317 such runs in 86 messages of the
  migrated catalogs.
- **Test messages.** `@nordbeam/locale/testing` adds `messageIds(messages)`, a
  messages object in which every message renders its ID, and
  `withMessages(messages, overrides)`, a copy with some messages replaced by
  text or by a function typed from the message, through both flat and nested
  access. `compileMessages(texts)` compiles a test's own ICU text with the same
  compiler. Component tests no longer need a hand-written ICU renderer or
  `Object.create(messages, …)`. See [testing](docs/reference/testing.md).
- **Elements in plain arguments.** `rich()` accepts a React element for a plain
  `{name}` argument, also in a message without tags:
  `rich(m.promo, { code: <strong>{code}</strong> })`. Number, date and `select`
  arguments still take values only. `@nordbeam/locale/react/rich` grows by
  167 B min+gzip.
- **`hardcoded` recognizes Lingui, react-intl and i18next.** Text those
  libraries render is no longer reported, so a scan before a migration is a
  baseline: Lingui `<Trans>`, `<Plural>`, `` t`…` ``, `msg`, `defineMessage`,
  `plural()` and `i18n._({ id, message })`; react-intl `<FormattedMessage>`,
  `defineMessages` and `intl.formatMessage()`; i18next `t('key', 'Default')`
  and `<Trans i18nKey>`. Files that use them count as localized. After a
  migration, the `message` or `defaultMessage` of a descriptor passed to a
  message call is no longer reported either. On the app before its migration,
  findings went from 4,001 to 2,945, and those on Lingui `message:` text from
  1,097 to 11.
- `hardcoded` names a mapped locale by its tag's language, so a branch such as
  `isSwedish` counts as an inline translation of `se`.
- **A Vite config bundled as CommonJS can load the plugin.** Every entry point
  now has a `default` export condition next to `import`, so `require()`
  resolves it and Node 22.12+ loads the ES module. Vite bundles
  `vite.config.ts` and `vitest.config.ts` as CommonJS in a package without
  `"type": "module"`, and the import failed with
  `ERR_PACKAGE_PATH_NOT_EXPORTED`.
- The `bin` paths no longer start with `./`, which npm 11 reported as invalid
  and rewrote on every publish.

### `@nordbeam/locale-migrate`

- **Lingui 3 projects.** `migrate-project --from . --format lingui` reads the
  catalogs that `package.json#lingui` or `.linguirc` names, and Lingui's
  `sourceLocale` becomes the base locale; `<locale>/messages.po` folders are
  found without configuration. A new `lingui-po` catalog format converts what
  Lingui 3 rendered: numbered tags become `<tag0>…</tag0>` for `rich()`, a run
  of HTML tags is quoted as one literal (`'<br/><br/>'`, never
  `'<br/>''<br/>'`), apostrophes, obsolete `#~` entries and unescaped PO quotes
  are read as Lingui read them, an empty source-locale text takes its ID, and
  messages with arguments are trimmed as Lingui trimmed them. New warnings:
  `LINGUI_PO_QUOTES`, `LINGUI_OBSOLETE_INCLUDED`, `LINGUI_WHITESPACE_TRIMMED`
  and `LINGUI_SOURCE_ID_TEXT`.
- **Every failing message at once.** A catalog that cannot be converted, or
  that breaks the contract between locales, fails with `COMMAND_FAILED`
  followed by one error per message with its `code`, `locale`, `file` and
  `messageId`. It used to stop at the first.
- **Grouped warnings.** `DOTTED_SOURCE_ID`, `MIGRATION_METADATA_DROPPED`, the PO
  skip warnings and the Lingui warnings come once per code and catalog, with
  `count` and `messageIds`, instead of once per message. IDs that cannot nest
  (a message that is also a namespace, or an empty or space-edged segment) are
  renamed the same way in every locale and in the rewritten calls, reported as
  `MIGRATION_ID_RENAMED` with a `renamed` map.
- **Conversion check.** Each converted message is read back and compared with
  its source; a difference is reported as `MIGRATION_TEXT_CHANGED`.
- **More `<Trans>` rewritten.** `<Trans components={[…]}>` becomes `rich()`,
  `id={'x'}` and conditional IDs are rewritten, and `i18n._()` descriptors keep
  their `values`. Elements are bounded by the parser, so a nested `/>` no
  longer swallows its siblings. Components that used `<Trans>` without
  `useLingui()` get a `useMessages()` binding, and an element outside any
  component becomes a generated `<LocaleMessage render={(m) => …} />`, so it
  still renders in the current locale. On the 13,899-message app, the source
  rewrite changed 3,170 calls in 496 files.
- The `--catalog-format` help says it names the format of the legacy catalogs
  being read.

## 0.4.0

New commands for seeing where a project's translations stand: `report` and
`hardcoded`. No breaking changes.

### `@nordbeam/locale`

- **Project report.** `nordbeam-locale report` writes a self-contained HTML
  page about the project's translations: coverage per locale, namespaces as a
  treemap, the size of the catalog each locale downloads and of each scope, ICU
  features, which files use which messages, unused messages, diagnostics, and a
  searchable table of every message. `--open` opens it, `--out` names the file,
  and `--json` returns the same data for scripts and agents. See
  [Project report](docs/GUIDE.md#project-report).
- **Hardcoded text.** `nordbeam-locale hardcoded` finds UI text in the source
  that is not a catalog message, in JSX, Vue and Svelte templates, attributes,
  props, toasts and the helpers that feed them. It learns from the project:
  positions that receive messages elsewhere, inline translations such as
  `locale === "en" ? "Save" : "Spara"` and `{ sv, en }` objects, and text that
  is the same in every catalog. Each finding has a confidence and a reason.
  `--fix` replaces text with the catalog message that renders the same, adding
  the translator hook and its import where needed; `--extract` adds new
  messages; both preview until `--write`. Ignore comments, ESLint
  `i18next/no-literal-string` comments and a new `text` configuration key mark
  what to leave alone. Projects with more than a few dozen files are scanned
  on worker threads, and `persistentCache` reuses results for unchanged files.
  It uses `oxc-parser`, a new optional dependency. See
  [Hardcoded text](docs/GUIDE.md#hardcoded-text).
- `doctor` reports hardcoded text as the `HARDCODED_TEXT` warning, `report`
  adds a section for it, and the MCP server adds a `find_hardcoded` tool.
- The development inspector checks the page for text no message rendered:
  `scanRenderedText(inspector)`, and a "Find hardcoded text" button in the
  overlay that outlines it. This covers text from an API or a CMS that the
  static scan cannot see.
- The source scan behind `doctor`, `prune` and `rename` skips regular
  expression literals. It used to read the `m` flag in `/…/m.test(s)` as the
  messages object and report an unknown message ID, and a quote inside a
  regular expression could hide the rest of the line from the scan.
- Dependencies: `@formatjs/icu-messageformat-parser` 3.5.21 and `magic-string`
  1.4.3.

### `@nordbeam/locale-migrate`

- Dependencies: `fast-xml-parser` 5.11.2 and `yaml` 2.9.1. No other changes.

### `nordbeam-locale`

- Released at the same version as `@nordbeam/locale`.

## 0.3.0

Breaking changes, all in the TanStack Start adapter: a `hydrate` router option
of your own must call `options.hydrate()`; a direct call to `i18n.beforeLoad`
that passes `matches` in an object literal must drop it; and `getLocale()`
returns `undefined` outside a request instead of throwing. Details below.

### `@nordbeam/locale`

- **Scopes computed from code.** A scope can now be
  `{ modules, exclude?, messages? }` instead of a list of IDs. The generator
  follows the imports of the files `modules` matches through the app's own
  source (relative paths, `tsconfig.json` `paths`, `/src/...`), and takes the
  message IDs they name in string literals, property chains (`m.pricing.title`)
  and template literals (`` `plan.${id}.name` `` as a pattern). The scope is
  recomputed on every generation, and under the Vite plugin when one of its
  files changes, so it follows the code instead of going stale. In development,
  the `loadLocale` of a computed scope logs each read of a message that the
  scope left out.
  New errors: `SCOPE_MODULE_NOT_FOUND`, `EMPTY_SCOPE`.
- **TanStack Start: public pages can load a smaller catalog.** Pass
  `scopes: { site: loadSiteLocale }` to `createTanStackStartI18n` and mark
  routes with `staticData: { i18nScope: 'site' }`. The browser loads the
  scope's catalog on those pages, and the full catalog only once it navigates
  to a page outside the scope. The server renders with the full catalog,
  names the scope on `<html>` through `useHtmlAttributes()`, and hints the
  scope's chunks. On Nordsynk's marketing pages, a scope computed from 59
  route files (2,717 of 7,629 messages) halved the catalog download (135.7 to
  68.2 KB brotli) and made hydration 0.40 to 0.71 s earlier on slow 4G, with
  first paint unchanged.
- **React: `createSuspenseI18n(...).prime(snapshot)`** uses messages loaded
  elsewhere for their locale, such as a scope's catalog, without suspending.
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

### `nordbeam-locale`

- Available again, at the same version as `@nordbeam/locale`, so
  `npx nordbeam-locale init` works. Its 0.2.1 was withdrawn, and 0.2.2 was
  never published.

## 0.2.1

The first public release. 0.2.0 is deprecated because its package metadata
listed scripts from the development repository.

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
