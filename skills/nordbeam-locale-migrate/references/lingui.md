# Lingui

`--format lingui` or `--format lingui-react` for the source codemod; JSON catalogs are read as the `lingui` catalog format (source catalogs, which are ICU) and `.po` catalogs as `lingui-po`, which converts what Lingui 3 rendered: numbered tags `<0>…</0>` become `<tag0>…</tag0>`, other HTML stays quoted text, and messages with arguments are trimmed (`LINGUI_WHITESPACE_TRIMMED`). A compiled Lingui catalog entry cannot be converted: migrate the source catalog instead (`LINGUI_COMPILED_ENTRY`).

`--from .` with `--format lingui` reads the catalogs that `package.json#lingui` or `.linguirc` names, and its `sourceLocale`. A `lingui.config.js` is not run: pass the catalog directory (`<locale>/messages.po` folders) instead.

```sh
npx nordbeam-locale migrate-project --from src/locales --format lingui-react --framework vite-react --source-dir src --message-id-map source-to-id.json --initial-locale-expression locale --json
```

## Source messages need IDs

Lingui macros (`` t`Hello` ``, `<Trans>Hello</Trans>`) use the source text as the message; Nordbeam messages have explicit IDs. The codemod rewrites source macros only when an unambiguous source-text to ID map exists. Either the catalog provides one, or you pass `--message-id-map <file>`: a JSON object whose keys are exact source strings and whose values are the IDs. An ambiguous map (array values) fails before any write instead of picking a fuzzy match; unresolved macros are reported as `MESSAGE_ID_UNRESOLVED`. Calls that already carry explicit IDs (`i18n._('id')` from `useLingui`, descriptors with an `id`, `<Trans id="..." />`) are recognised directly.

Generate the map from the extracted catalog (source string to the ID you want) and review it with the user before using it. Prefer adopting explicit IDs in the Lingui project first if the codebase is small.

## What the report shows

`codemod.compatibility` lists `directRewrites`, `fallbackFiles` (files that still need a lazy legacy boundary) and a per-file plan. A file with no fallback can drop its legacy lookup; files with unresolved calls keep an explicit boundary. The tool never turns a synchronous call into an asynchronous one automatically.

## After the tool

- Remove `I18nProvider`, `i18n.activate(...)` and the dynamic `import('./locales/<l>/messages')` loading; the Nordbeam provider loads locale chunks. Pass your initial-locale logic as `initialLocale`.
- `<Trans id components={[…]}>` becomes `rich()` (`@nordbeam/locale/react/rich`); `components={[link]}` by reference is `RICH_MESSAGE` and needs the same by hand. `<Trans>` with JSX children and no ID still needs converting to ICU tags plus `rich()`.
- Express `plural()` macros and `<Plural>` as ICU plural messages called with the count.
- Remove the Lingui macro plugin and config only after nothing imports Lingui. Finish with [finishing.md](finishing.md).
