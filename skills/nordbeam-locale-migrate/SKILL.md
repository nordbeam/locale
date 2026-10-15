---
name: nordbeam-locale-migrate
description: Migrate an existing app from another i18n library to Nordbeam Locale (@nordbeam/locale) with @nordbeam/locale-migrate and the nordbeam-locale CLI (migrate-project, migrate, codemod, apply-plan). Handles sources, catalogs and call sites from i18next, react-i18next, next-i18next, next-intl, FormatJS and react-intl, Lingui, vue-i18n and Nuxt i18n, svelte-i18n, typesafe-i18n, Tolgee, next-international, Transloco, ngx-translate, plus catalog files in PO, POT, MO, Jed JSON, ARB, YAML, Android XML and Apple strings or xcstrings. Use when the user wants to switch to, move to, replace their current i18n library with, or convert translations into Nordbeam Locale, or asks how to move off one of these libraries. Gives the safe protocol (preview, review, apply, verify), the per-library gaps, and how to resolve every skipped construct. Not for everyday catalog edits in a project already on Nordbeam Locale (use nordbeam-locale), and not for choosing or starting an i18n setup from scratch.
license: Apache-2.0
compatibility: Needs Node 22.12 or newer, @nordbeam/locale and @nordbeam/locale-migrate installed at exactly the same version, and a git working tree to review the diff.
---

# Migrate to Nordbeam Locale

The migration tools convert catalogs and rewrite recognisable, statically provable translation calls. They never guess: dynamic keys, rich markup, provider setup and anything ambiguous are reported as skipped constructs with a stable `code` and an `action`, and left untouched. Your job is to run the protocol, treat the preview as the spec for the work, finish what the tools deliberately leave to a human, and prove the result with `verify`. Read the [nordbeam-locale](../nordbeam-locale/SKILL.md) skill for the target library's API and edit loop; this skill covers getting there.

Run commands from the project root. `--json` prints one JSON document; prefer it.

## 1. Before touching anything

1. Find the source library and its catalogs in `package.json` and the tree. Pick the matching reference below and read it now: the per-library gaps decide how you prepare the catalogs.
2. Choose the target framework: `next`, `vite-react`, `vue`, `svelte` or `solid`. Angular (Transloco, ngx-translate) has codemods only and no Nordbeam runtime adapter: stop and tell the user before changing anything. Remix, Nuxt and other frameworks are not scaffolded; see the reference. TanStack Start is a runtime target but not a migration scaffold: omit `--framework` to migrate catalogs and calls, then wire the runtime by hand with the `tanstack-start` reference of the nordbeam-locale skill.
3. Require a clean git tree (or ask the user to commit) so the whole migration is one reviewable diff. Work on a branch.
4. Install both packages at the same version; a mismatch stops every migration command (`MIGRATE_PACKAGE_VERSION`, missing package is `MIGRATE_PACKAGE_MISSING` with the exact install command in the error):

   ```sh
   npm install @nordbeam/locale
   npm install --save-dev @nordbeam/locale-migrate
   ```

5. `npx nordbeam-locale capabilities --json` lists the accepted `--format` values under `formats.catalogs` and `formats.sourceCodemods`. Do not guess a name. XLIFF is not a supported format; convert it to PO or JSON with a tool first.
6. Normalise the catalog layout the tool expects: either one catalog file (pass `--locale`, default `en`) or a directory whose files are named by locale (`en.json`, `fr.json`). For the JSON formats a `locales/<locale>/<namespace>.json` layout is also accepted: each namespace file becomes the first ID segment (`common.hi`), and a lone `translation.json` stays unprefixed. Static namespaces in calls then become key prefixes.

## 2. Preview (writes nothing)

```sh
npx nordbeam-locale migrate-project --from <catalog dir or file> --format <source> --framework <next|vite-react|vue|svelte|solid> --source-dir src --json > /tmp/nordbeam-preview.json
```

Preview is the default; only `--write` changes files. The `--format` names the source library and drives the codemod. The catalog format is inferred for i18next, FormatJS and vue-i18n (whose pipe plurals, links and list placeholders are converted) and defaults to ICU JSON (next-intl style) for every other source; pass `--catalog-format <format>` when the catalogs use different syntax (for example `--catalog-format i18next` for Transloco or ngx-translate catalogs, whose `{{name}}` interpolation otherwise fails as invalid ICU).

Useful options: `--locale <l>` (single-file input), `--catalogs <dir>` (destination, default `messages-nordbeam`), `--base-locale`, `--out-dir`, `--initial-locale-expression <expr>` (Vite React: a JavaScript expression that yields the initial locale, for example `locale`, or a quoted literal such as `"'en'"`; without it the root provider is left for you to add), `--message-id-map <file>` (Lingui source-text to ID map), `--custom-call <callee[:namespace]>` (repeatable; app-owned wrappers such as `translate`), `--messages-object <name>` (default `m`), `--strict` (refuse to write when constructs are unresolved).

Read these fields, not the whole document: `ok`; `catalogs[]` (`locale`, `messageCount`, `warnings`); `codemod.replacements`, `codemod.changed[]`; `codemod.skipped[]` (`code`, `callee`, `reason`, `action`, `file`, `line`); `codemod.compatibility` (`directRewrites`, `fallbackFiles`); `integration.skipped[]` (providers, hooks and roots left alone, with `reason`); `generatedFiles`, `scaffoldFiles`, `configFiles`, `packageEdits`; `residueAudit.findings[]` (incumbent imports that remain); `manualActions[]`. Paths in this report are absolute.

A one-liner for counts by skip code:

```sh
node -e "const j=require('/tmp/nordbeam-preview.json');const c={};for(const s of j.codemod.skipped)c[s.code]=(c[s.code]||0)+1;console.log(j.ok,j.catalogs.map(x=>x.locale+':'+x.messageCount),j.codemod.replacements,c)"
```

If the preview fails with `COMMAND_FAILED`, the message names the catalog and cause (`MIGRATION_INVALID_ICU`, `MIGRATION_ID_COLLISION`, `MIGRATION_LAYOUT_COLLISION`, `MIGRATION_OUTPUT_EXISTS`): fix the input, not the tool. One malformed message blocks the whole run, so repair it in a working copy of the legacy catalog and re-run.

## 3. Review with the user

Summarise before writing: messages and locales, direct rewrites, skipped constructs grouped by `code` with the `action` each asks for, and the manual actions. Decide the open choices (initial locale expression, ID map, wrappers). If a large share of calls is dynamic (`DYNAMIC_MESSAGE_KEY`), agree a plan: replace dynamic keys with explicit maps in the legacy code first, or accept that those calls stay on the legacy runtime behind a boundary until they are migrated by hand.

## 4. Apply

Whole project, the normal path:

```sh
npx nordbeam-locale migrate-project <same flags> --write --json
```

It creates the destination catalogs (existing destinations are never replaced), `nordbeam-locale.config.json`, framework scaffolds under `src/i18n/`, package scripts, and applies only the proven source rewrites. It also generates the typed modules, so `verify` should already pass for the catalogs; re-run `generate` after you edit anything.

Stepwise path for custom layouts or when you want a reviewable plan file:

```sh
npx nordbeam-locale migrate --from <file> --format <catalog format> --locale <l> --out <new file> --dry-run --json   # then without --dry-run
npx nordbeam-locale codemod --format <source> --source-dir src --plan .nordbeam/codemod.json --json
# review affectedPaths, changes and planHash with the user, then:
npx nordbeam-locale apply-plan --from .nordbeam/codemod.json --json
```

`migrate --out` refuses an existing file (`MIGRATION_OUTPUT_EXISTS`, exit 4). `apply-plan` validates every target's hash first and writes all or nothing; a second run reports `already-applied`; a concurrent edit gives `STALE_PLAN` (exit 4), so regenerate the plan rather than editing it. Do not pass the generated `src/i18n/index.js` as `--messages-import`: it exports no `m`. Point it at an application module that exports the binding, or bind `m` yourself (next section).

## 5. Finish what the tool leaves, then verify

Do these in order; [references/finishing.md](references/finishing.md) has the details and framework patterns.

1. `npx nordbeam-locale generate --json`, then `npx nordbeam-locale check --json`. Fix catalog problems first.
2. Bind `m` wherever the codemod rewrote calls: it emits `m.section.key(...)` but does not always create the binding (hooks that also destructure other state, non-conventional server components and `<script setup>` blocks are skipped, and the report says `Bind or verify the generated messages object as m`). Search the changed files for unbound `m`, and use the framework's adapter (`i18n.useI18n()`, `await i18n.loadLocale(locale)`, and so on).
3. Resolve each skipped construct by `code` using [references/skipped-constructs.md](references/skipped-constructs.md). Rich text (`<Trans>`, `t.rich`, `<FormattedMessage>` with children, `<i18n-t>`) becomes ICU tags plus the framework's rich renderer by hand.
4. Replace the legacy provider, plugin and bootstrap with the Nordbeam adapter (the report lists each one under `integration.skipped` and `manualActions`), and replace legacy request routing (for example `next-intl/middleware`) with the generated one; do not leave two request files.
5. Run the app's type-check, tests and a production build. Compare a sample of rendered strings between the old and new catalogs for plurals, interpolation and rich text; the tools flag, but do not prove, runtime parity.
6. Only when `residueAudit` has no real findings and nothing imports the legacy library, remove the legacy dependency, provider code and catalogs, with the user's agreement.
7. `npx nordbeam-locale verify --json` must exit 0. Add `--strict` to `check` once translations are complete.

## Rules

- Preview before `--write`, and review `skipped` and `manualActions` before and after. A clean `ok: true` means the tool found nothing it refused to guess, not that the app is migrated.
- Never invent a locale expression, message ID or key for a skipped call. Convert dynamic keys deliberately (a finite conditional or an explicit typed map of literal keys).
- Never hand-edit files under the generated output directory; fix catalogs or source and regenerate.
- Never delete legacy catalogs, providers or dependencies before parity checks pass.
- `migrate` and `migrate-project` never overwrite an existing destination, even in preview, so `migrate-project` runs once per destination: after `--write`, use `codemod` (without `--write`) to re-check source constructs. Choose a new path instead of deleting a user's file.
- When a check fails, `npx nordbeam-locale explain <CODE> --json` gives the cause and fix.

## Per-library references

Read only the one that matches.

| Source | Reference |
| --- | --- |
| i18next, react-i18next, next-i18next | [references/i18next.md](references/i18next.md) |
| next-intl | [references/next-intl.md](references/next-intl.md) |
| FormatJS, react-intl | [references/formatjs.md](references/formatjs.md) |
| Lingui | [references/lingui.md](references/lingui.md) |
| vue-i18n, Nuxt i18n | [references/vue-i18n.md](references/vue-i18n.md) |
| svelte-i18n | [references/svelte-i18n.md](references/svelte-i18n.md) |
| typesafe-i18n, next-international | [references/typesafe-i18n.md](references/typesafe-i18n.md) |
| Tolgee | [references/tolgee.md](references/tolgee.md) |
| Transloco, ngx-translate (Angular) | [references/angular.md](references/angular.md) |
| PO, POT, MO, Jed JSON, ARB, YAML, Android XML, Apple strings and xcstrings | [references/catalog-formats.md](references/catalog-formats.md) |
| Skipped-construct codes and their fixes | [references/skipped-constructs.md](references/skipped-constructs.md) |
| Post-migration checklist and framework patterns | [references/finishing.md](references/finishing.md) |
