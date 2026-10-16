# Finishing a migration

A successful `migrate-project --write` leaves the app in a half-way state on purpose: catalogs converted, proven calls rewritten, scaffolds in place, legacy runtime still installed. Work through this list in order.

## 1. Generate and check

```sh
npx nordbeam-locale generate --json
npx nordbeam-locale check --json
```

`migrate-project --write` already generates the modules, so `verify` should pass for the catalogs; run `generate` again after any catalog edit. Fix catalog diagnostics now (`INVALID_ICU`, `UNKNOWN_ARGUMENT`, `MISSING_PLURAL_CATEGORY`); they are cheaper to fix before the source changes. Add `--strict` to `check` once translations are complete.

## 2. Find unbound `m`

The codemod emits `m.section.key(...)`. It creates the binding only when it can prove a safe place. Find the gaps:

```sh
git diff --name-only
npx tsc --noEmit        # or the project's type-check: "Cannot find name 'm'"
```

Bind by framework (target API details are in the nordbeam-locale skill):

- Vite React component: `const { messages: m } = i18n.useI18n();` with `import { i18n } from '<path>/i18n/client.js'`; the root needs `<i18n.Provider initialLocale={...}>` (pass `--initial-locale-expression` on a re-run, or add it by hand).
- Next.js server component: `const { messages: m } = await i18n.loadLocale(locale)` after `i18n.hasLocale(locale)` narrowing, `import { i18n } from '<path>/i18n/next'`. Client component: `i18n.useI18n()` from `<path>/i18n/client` under a `NordbeamLocaleProvider` in the locale layout.
- Vue: `const { messages: m } = i18n.useI18n()`, a ref: `m.value.key(...)` in script (wrap in `computed` to stay reactive), `m.key(...)` in templates.
- Svelte: `const { messages } = getI18nContext()` and `$messages.key(...)`.
- Solid: `const { messages } = i18n.useI18n()` and `messages().key(...)`.
- Plain modules: `const { messages: m } = await loadLocale(locale)` from `<path>/i18n/index.js`.

Use `--messages-import <specifier>` only when you have an application module that exports the binding named by `--messages-object` (default `m`); the generated `src/i18n/index.js` exports no `m`.

## 3. Resolve skipped constructs

Use [skipped-constructs.md](skipped-constructs.md). Re-run `npx nordbeam-locale codemod --format <source> --source-dir src --json` (no `--write`; read-only) to watch the remaining list shrink. `migrate-project` cannot be re-run once its destination catalogs exist: it refuses with `MIGRATION_OUTPUT_EXISTS`, even as a preview. For a project-wide batch, `codemod --plan .nordbeam/codemod.json --json` then `apply-plan --from .nordbeam/codemod.json --json` keeps each batch reviewable and stale-safe.

## 4. Replace the legacy boundary

- Build config: `migrate-project` does not edit an existing `vite.config.*` or `next.config.*`. Add `nordbeamLocale()` from `nordbeam-locale/vite` to the Vite plugins, or wrap the Next config with `withNordbeamLocale()` from `@nordbeam/locale/next`, and make sure `@nordbeam/locale` is in `dependencies` (the runtime imports it), not only the migration package.

- Provider and bootstrap: remove the old provider, plugin or `init()`; the Nordbeam adapter replaces them.
- Language switching: the old `changeLanguage`/`setLocale`/`$locale.set` becomes the adapter's `setLocale`.
- Next.js: one request file (`proxy.ts` beside `app/`, `src/` for `src/app`), routing from `defineRouting`, `withNordbeamLocale()` in the Next config; remove the old plugin wrapper and middleware.
- Build scripts: `init` adds `prebuild: nordbeam-locale`. Production builds need `NODE_ENV=production`.

## 5. Parity checks

The tools prove syntax and arguments, not meaning. At minimum:

- Message counts per locale match: `npx nordbeam-locale inspect --json` (catalog `messageCount`, `missingCount`) against the legacy catalogs.
- Spot-check each message shape in both systems with the same inputs: plurals at 0, 1, 2 and a large number, selects, interpolated values with special characters, rich text, dates and numbers in at least two locales.
- Grep the converted catalogs for leftovers of the legacy syntax: `{{`, `$t(`, ` | ` (vue-i18n pipes), `@:`, `%s`, `<0>`.
- Run the app's tests and a production build; load one page per locale in a browser if a dev server is available, and confirm there are no hydration or missing-key problems.

## 6. Clean up and verify

Remove the legacy packages, config files, provider code and old catalogs only after the residue audit (`migrate-project` preview, `residueAudit.findings`) shows nothing real and a search for the old package name returns nothing. Delete files with the user's agreement; the tools never delete anything. Finally:

```sh
npx nordbeam-locale generate --json
npx nordbeam-locale verify --json      # must exit 0
```

Report to the user: messages and locales migrated, calls rewritten automatically, what was finished by hand, what remains on the legacy runtime (if anything) and why.
