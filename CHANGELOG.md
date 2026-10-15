# Changelog

All notable changes to `@nordbeam/locale` and `@nordbeam/locale-migrate` are
documented here. The project follows [Semantic Versioning](https://semver.org/);
before 1.0, minor versions may contain breaking changes, and they are called
out in this file.

## Unreleased

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
