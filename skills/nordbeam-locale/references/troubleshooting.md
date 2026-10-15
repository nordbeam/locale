# Troubleshooting

Start with the code: `npx nordbeam-locale explain <CODE> --json` gives the cause and fix, and https://github.com/nordbeam/locale/blob/main/docs/reference/errors.md lists all of them. Run `check --json --summary` first to see which codes dominate, then `check --json --only CODE --limit all` to see every row for one code.

## CLI and setup

| Symptom | Cause and fix |
| --- | --- |
| `npx nordbeam-locale` fails with `E404` for `nordbeam-locale` | The package is not installed locally, so npx searched the registry for an unscoped package. Run `npm install @nordbeam/locale` first (the bin is declared by `@nordbeam/locale`). |
| `npm install @nordbeam/locale` cannot find the package | Pre-release builds may not be on the registry yet. Install the tarball or path the user provides (`npm install ../locale/nordbeam-locale-0.2.0.tgz`). Install `@nordbeam/locale-migrate` at exactly the same version when migrating. |
| `FILE_NOT_FOUND` / `No catalogs directory at messages/` | The project is not initialised or `catalogs` points elsewhere. Run `init`, or set `"catalogs"` in `nordbeam-locale.config.json`. |
| `CONFIG_EXISTS` from `init --catalogs ...` | Init never replaces a config. Edit the JSON file instead; plain `init` and `init --agent` work on an existing config. |
| `init` printed `Vite: add nordbeamLocale() ...` and the plugin is missing | An existing `vite.config.*` is preserved. Add `nordbeamLocale()` from `@nordbeam/locale/vite` to `plugins` by hand. For Vue, Svelte and Solid, install the framework's Vite plugin before `init` or add `vue()` / `svelte()` / `solid()` yourself. |
| `--json is available with nordbeam-locale check and other explicit...` | `--json` needs an explicit command. Use `generate --json`, not bare `nordbeam-locale --json`. |
| `USAGE` with `Unknown option --x, did you mean --y?` | Read `suggestion` in the error, or run `help <command>`. |

## Catalog diagnostics

| Code | Meaning and fix |
| --- | --- |
| `INVALID_ICU` | Read `reason`: `MISSING_OTHER_CLAUSE` (add `other {...}`), `EXPECT_ARGUMENT_CLOSING_BRACE` (close `}` or quote a literal brace as `'{'`), mismatched rich tags (every `<x>` needs `</x>`; tags cannot be numbered). `frame` shows the exact column. |
| `INVALID_JSON`, `DUPLICATE_KEY` | The catalog is not strict JSON (trailing comma, comment) or repeats a key. Fix at the reported line. |
| `UNKNOWN_ARGUMENT`, `MISSING_ARGUMENT` | A translation renamed, added or dropped an argument. Arguments are code identifiers, not translatable text; restore the base name. |
| `MISSING_PLURAL_CATEGORY`, `MISSING_PLURAL_BRANCH` | The language needs plural categories the translation lacks (or the base defines a branch the translation omits). Add them; see `icu-messages.md`. |
| `DROPPED_RICH_TAG`, `UNEXPECTED_SLOT`, `SLOT_MISMATCH` | Rich tags differ between locales, or a name is a plain value in one message and a slot in another. Keep the base message's tags and argument kinds. |
| `FALLBACK_MESSAGE` (warning), `MISSING_MESSAGE` (error under `--strict` or `"missing": "error"`) | A locale lacks a key; the base text is served. Translate it, or accept the fallback when the task allows it. |
| `INVALID_FORMAT`, `UNKNOWN_FORMAT` | A number or date style or skeleton `Intl` rejects, or an undeclared named style. Correct it, or declare it under `formats` in the config. |
| `THENABLE_KEY`, `CATALOG_LAYOUT_CONFLICT`, `INVALID_MESSAGE_ID` | A key named `then`, a key that is both a message and a namespace, or an empty or malformed dotted ID. Rename it. |
| `GENERATED_STALE` | Catalogs, options or the compiler changed since the last generation, or because a production build (`vite build`, `next build`) regenerated the output in production mode while `verify` ran in development mode. Run `generate` and then `verify` with the same `NODE_ENV`; use `NODE_ENV=production` for both when the build was a production one. |
| `GENERATED_MODIFIED` | A generated file was hand-edited. Put the change in a catalog or the config, run `generate` to restore it, then `verify`. |
| `UNUSED_MESSAGE` (doctor) | No statically recognisable source reference. Dynamic keys are invisible to the scan; review before deleting. |

## Types and runtime

- A route or query parameter is a plain `string`. Narrow it before `loadLocale`: `locales.includes(value as Locale)`, or in Next.js `i18n.hasLocale(value)`.
- A TypeScript error on `m.key({...})` is the contract working: the catalog says which arguments exist and their types. Fix the call or the catalog; the generated `.d.ts` updates on `generate`.
- `argument "name" must be string or number` is the development guard. It disappears in production output, so fix the call site rather than building in production to hide it. Set `NODE_ENV=production` (or `generate --production`) for real builds.
- Server and browser format dates differently: set `"timeZone"` in the config and keep `Intl` data consistent.
- Locale flickers on load or hydration warns: pass the server-selected locale as `initialLocale`/`initial`; `initialLocale` is read on mount only and later prop changes do nothing (use `setLocale`).
- `Nordbeam Locale: wrap this component in its matching i18n.Provider.` (React, Solid) or a composable error (Vue) or `getI18nContext` throwing (Svelte): the provider, `app.use(i18n)` or `setI18nContext(...)` is missing above the component.
- Vite warns that a loader cannot be narrowed (`SELECTION_FALLBACK`): the bundle is correct but larger. Add a module-scope `selectMessages(...)` at that boundary, or move the call into a `.ts` module.

## Next.js

- Every localized URL is a 404, or locale prefixes never appear: `proxy.ts` / `middleware.ts` must sit beside `app/` (inside `src/` for `src/app`), export `config.matcher` as scaffolded, and import the routing module with a valid relative path.
- `Functions cannot be passed directly to Client Components`: a messages object, message function or slot callback crossed the Server to Client boundary. Pass the locale string and use `NordbeamLocaleProvider` or `createClientI18n`.
- `PageProps` or `LayoutProps` is not defined: the project's Next version does not generate the global route-prop helpers. Type the props as `{ params: Promise<{ locale: string }> }`.
- A route handler outside the matcher sees a spoofed locale header: call `getLocale(routing)` with the routing so only configured locales are accepted.
- Imports fail to resolve: follow the scaffold style (`./index.js` for generated modules, extensionless for sibling `.ts` sources).

## When the cause is not obvious

Run `npx nordbeam-locale inspect --json` (is generated output `complete` and `fresh`; which integration is detected), then `doctor --json`. If a result looks wrong and is not covered by a code, report the exact command and its JSON output; `INTERNAL_ERROR` (exit 70) is a library defect, not a project mistake.
