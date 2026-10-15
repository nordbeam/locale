# Catalog formats: PO, POT, MO, Jed JSON, ARB, YAML, Android XML, Apple strings

Supported `--format` / `--catalog-format` values for catalogs (confirm with `npx nordbeam-locale capabilities --json`, `formats.catalogs`): `i18next`, `vue-i18n`, `next-intl`, `formatjs`, `lingui`, `tolgee`, `arb`, `yaml`, `android-xml`, `apple-strings`, `apple-xcstrings`, `po`, `pot`, `mo`, `json-gettext`, `module`. XLIFF is not supported: convert it to PO or JSON with another tool first rather than parsing it by hand.

`migrate` converts one catalog and never touches source calls. Always preview first; the JSON result carries the whole converted catalog in `output`, plus `warnings` and `collisions`:

```sh
npx nordbeam-locale migrate --from locales/fr.po --format po --locale fr --dry-run --json
npx nordbeam-locale migrate --from locales/fr.po --format po --locale fr --out messages/fr.json     # new file only
```

FormatJS and ARB descriptions and `module` comments are notes about messages: `--notes messages.notes.json` writes them to a new notes file (outside the catalog directory), which the project names with `"notes"` in its config. An existing `--out` or `--notes` is refused (`MIGRATION_OUTPUT_EXISTS`, exit 4); pick a new path and move the reviewed result into the catalog directory yourself. For a whole app, `migrate-project --catalog-format <format>` runs the same converters over a directory (it scans `.json`, `.yaml`, `.yml`, `.arb`, `.xml`, `.strings`, `.xcstrings`, `.po`, `.pot` and `.mo` files named by locale).

| Format | Behaviour to review |
| --- | --- |
| `po`, `pot`, `mo`, `json-gettext` | The message ID is the `msgid` text, prefixed by `msgctxt` when present (a `msgctxt "cart.empty"` with `msgid "Empty"` becomes `cart.empty.Empty`, nested). Sentences as IDs contain spaces and dots; the tool warns with `DOTTED_SOURCE_ID` and suggests `--message-id-map` (migrate-project) or keyed IDs so one sentence stays one message. Call such messages with bracket access (`m['Hello %s'](...)`) or, better, rename to semantic IDs with `rename` after migrating. printf placeholders (`%s`, `%d`) become named ICU arguments (`{arg1}`, `{count}`) with `MIGRATION_PRINTF_PLACEHOLDER`: rename them and update call sites. gettext plural arrays become one ICU plural using the `Plural-Forms` header: with `PO_PLURAL_FORMS_MISSING` only `one` and `other` survive; set the `Language` header to a canonical tag (`pl`, `pt-BR`). Fuzzy entries are skipped (`PO_FUZZY_SKIPPED`) and untranslated entries are skipped (`PO_UNTRANSLATED_SKIPPED`): review them and clear the fuzzy flags before migrating if they are good. |
| `arb` | ICU messages carry over; `@key` descriptions become notes with `--notes <file>`, and other metadata (placeholders) is dropped (`MIGRATION_METADATA_DROPPED`). |
| `module` | A TypeScript or JavaScript dictionary (`.ts`, `.js`, `.mts`, `.mjs`, `.cts`, `.cjs`), parsed and never run: the default export, `module.exports`, or the only exported object. String literals, plain template literals, `+` joins and nested objects migrate; computed values and spreads are skipped (`MIGRATION_UNSUPPORTED_VALUE`). Strings must already be ICU; convert other placeholder syntax first. Comments above a message, or after it on its line, become notes with `--notes <file>`; then set `"notes"` in the config. |
| `yaml` | Nested keys keep dotted IDs. The text is taken as ICU, so rewrite non-ICU interpolation (`%{name}`, `{{name}}`) to `{name}` first or the run fails with `MIGRATION_INVALID_ICU`. |
| `android-xml` | `<string>` and `<plurals>` become messages; printf-style placeholders become named arguments with a review warning; check escape sequences and embedded HTML in the converted text. |
| `apple-strings`, `apple-xcstrings` | printf-style placeholders become named arguments with a warning. An `.xcstrings` catalog holds several locales: pass `--locale`, or its `sourceLanguage` is used. |

## Two different PO workflows

- `migrate --format po` (above) imports an existing PO catalog from another toolchain into JSON, once.
- `nordbeam-locale export --locale fr --out translations/fr.po` and `import --locale fr --from translations/fr.po [--dry-run]` are the ongoing translator hand-off for catalogs that already live in Nordbeam: entries are keyed by `msgctxt` = message ID, hold ICU in `msgid`/`msgstr`, and `import` rejects fuzzy headers, missing `msgctxt`, stale sources (`PO_STALE_SOURCE`) and the base locale (`PO_BASE_LOCALE`). Do not feed a foreign PO file to `import`.

After converting, `npx nordbeam-locale generate --json`, `check --json` and `verify --json` as usual, then migrate call sites with the matching source codemod if the app used a catalog-only library (the codemods are listed in `formats.sourceCodemods`).
