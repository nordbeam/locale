# Lingui

`--format lingui` or `--format lingui-react` for the source codemod; JSON catalogs are read as the `lingui` catalog format (source catalogs, which are ICU) and `.po` catalogs as `lingui-po`, which converts what Lingui 3 rendered: numbered tags `<0>…</0>` become `<tag0>…</tag0>`, other HTML stays quoted text, and messages with arguments are trimmed (`LINGUI_WHITESPACE_TRIMMED`). A compiled Lingui catalog entry cannot be converted: migrate the source catalog instead (`LINGUI_COMPILED_ENTRY`).

`--from .` with `--format lingui` reads the catalogs that `package.json#lingui` or `.linguirc` names, and its `sourceLocale`. A `lingui.config.js` is not run: pass the catalog directory (`<locale>/messages.po` folders) instead.

```sh
npx nordbeam-locale migrate-project --from src/locales --format lingui-react --framework vite-react --source-dir src --message-id-map source-to-id.json --initial-locale-expression locale --json
```

## Source messages need IDs

Lingui macros (`` t`Hello` ``, `<Trans>Hello</Trans>`) use the source text as the message; Nordbeam messages have explicit IDs. The codemod rewrites source macros only when an unambiguous source-text to ID map exists. Either the catalog provides one, or you pass `--message-id-map <file>`: a JSON object whose keys are exact source strings and whose values are the IDs. An ambiguous map (array values) fails before any write instead of picking a fuzzy match; unresolved macros are reported as `MESSAGE_ID_UNRESOLVED`. Calls that already carry explicit IDs (`i18n._('id')` from `useLingui`, descriptors with an `id`, `<Trans id="..." />`) are recognised directly.

With the map, the Lingui 4 and 5 forms convert: `` t`Hello ${name}` `` becomes `m.id({ name })`, and other expressions are numbered as Lingui extracts them (`` t`Hi ${user.name}` `` reads `Hi {0}` and becomes `m.id({ 0: user.name })`); `` _(msg`…`) `` and `i18n._(msg({ message }))` become one call; `t({ message })` and `` t(msg`…`) `` from `useLingui()` convert; `msg({ message, context })` resolves through a `context\u0004source` key; and `<Trans>` children are read with Lingui's whitespace rules, so `<Trans>Read the <a href="/terms">terms</a></Trans>` becomes `rich(m.id, { tag0: (children) => <a href="/terms">{children}</a> })`. `msg` and `defineMessage` become the message function (`m.status.draft`), not a call, because Lingui translates a descriptor where it is read: call it there (`STATUS[x]()`), where the codemod reports the old `_(STATUS[x])` as `DYNAMIC_MESSAGE_KEY`.

Generate the map from the extracted catalog (source string to the ID you want) and review it with the user before using it. Prefer adopting explicit IDs in the Lingui project first if the codebase is small.

## What the report shows

`codemod.compatibility` lists `directRewrites`, `fallbackFiles` (files that still need a lazy legacy boundary) and a per-file plan. A file with no fallback can drop its legacy lookup; files with unresolved calls keep an explicit boundary. The tool never turns a synchronous call into an asynchronous one automatically.

## After the tool

- Remove `I18nProvider`, `i18n.activate(...)` and the dynamic `import('./locales/<l>/messages')` loading; the Nordbeam provider loads locale chunks. Pass your initial-locale logic as `initialLocale`.
- `<Trans id components={[…]}>` and `<Trans>` children with elements become `rich()` (`@nordbeam/locale/react/rich`); `components={[link]}` by reference, fragments and spread props in the children are `RICH_MESSAGE` and need the same by hand.
- Express `plural()` macros and `<Plural>` as ICU plural messages called with the count.
- Remove the Lingui macro plugin and config only after nothing imports Lingui. Finish with [finishing.md](finishing.md).
