# FormatJS and react-intl

`--format formatjs` or `--format react-intl`. The catalog format is inferred as FormatJS: descriptor entries use their `defaultMessage`; a non-standard `message` field is accepted with `MIGRATION_MESSAGE_FIELD`; a descriptor without a string `defaultMessage` is an error (`MIGRATION_UNSUPPORTED_DESCRIPTOR`); descriptions and other metadata are dropped. ICU syntax is native, so plurals, selects and rich tags carry over.

```sh
npx nordbeam-locale migrate-project --from lang --format react-intl --framework vite-react --source-dir src --initial-locale-expression locale --json
```

## Prepare

- Use the extracted or compiled JSON locale files (`lang/en.json`, `lang/fr.json`) as the directory. If messages exist only in `defineMessages` source, extract them first (for example with `formatjs extract`) so the catalogs hold IDs and default messages.
- Dotted IDs become nested keys (`DOTTED_SOURCE_ID`); generated hash IDs become unreadable but valid keys. Decide with the user whether to keep IDs or rename them later with `nordbeam-locale rename --id old --to new --regenerate`.

## What the codemod rewrites

`useIntl().formatMessage({ id })`, destructured aliases, injected class calls, and self-closing `<FormattedMessage id="..." />`. Static IDs become `m.<id path>(values)`. Reported and left alone: `<FormattedMessage>` with children or rich values (`RICH_MESSAGE`), dynamic IDs, and descriptors whose ID cannot be resolved from the source (`MESSAGE_ID_UNRESOLVED`). `formatDate`, `formatNumber`, `formatRelativeTime`, `formatList` and `<FormattedDate>`-style helpers are not message calls: express dates and numbers in the message (`{d, date, medium}`, `{n, number}`) or use `Intl` directly.

## After the tool

- Replace `<IntlProvider locale messages>` with the Nordbeam provider (`<i18n.Provider initialLocale={locale}>` in Vite React) and delete the code that loaded messages into it.
- Convert rich `values` such as `{ b: chunks => <b>{chunks}</b> }` to `rich(m.key, { b: children => <b>{children}</b> })` (`@nordbeam/locale/react/rich`). Tag names in the ICU stay the same.
- `intl.locale` becomes `locale` from `i18n.useI18n()`.
- If source code relied on `defaultMessage` fallbacks, make sure the base catalog contains every message; Nordbeam reads catalogs, not source defaults.
- Finish with [finishing.md](finishing.md).
