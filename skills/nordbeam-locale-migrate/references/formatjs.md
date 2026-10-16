# FormatJS and react-intl

`--format formatjs` or `--format react-intl`. The catalog format is inferred as FormatJS: descriptor entries use their `defaultMessage`; a non-standard `message` field is accepted with `MIGRATION_MESSAGE_FIELD`; a descriptor without a string `defaultMessage` is an error (`MIGRATION_UNSUPPORTED_DESCRIPTOR`); descriptions and other metadata are dropped. ICU syntax is native, so plurals, selects and rich tags carry over.

```sh
npx nordbeam-locale migrate-project --from lang --format react-intl --framework vite-react --source-dir src --initial-locale-expression locale --json
```

## Prepare

- Use the extracted or compiled JSON locale files (`lang/en.json`, `lang/fr.json`) as the directory. If messages exist only in `defineMessages` source, extract them first (for example with `formatjs extract`) so the catalogs hold IDs and default messages.
- Dotted IDs become nested keys (`DOTTED_SOURCE_ID`); generated hash IDs become unreadable but valid keys. Decide with the user whether to keep IDs or rename them later with `nordbeam-locale rename --id old --to new --regenerate`.

## What the codemod rewrites

`useIntl().formatMessage(descriptor)`, destructured aliases, injected class calls, and `<FormattedMessage>`. A descriptor can be inline (`{ id }`), a `defineMessages` constant in the same file, or one imported by a relative path (`import messages from './messages'`); `messages.key`, `{...messages.key}` and `open ? messages.a : messages.b` all resolve. Static IDs become `m.<id path>(values)`. Values that hold an element, a tag renderer (`b: chunks => <b>{chunks}</b>`) or a name bound to an element become `rich(m.<id path>, values)` from `@nordbeam/locale/react/rich`, and `tagName="strong"` becomes `<strong>{m.<id path>()}</strong>`. Constants and imports the rewrite stopped reading are removed. Reported and left alone: `<FormattedMessage>` with a children render function (`RICH_MESSAGE`), dynamic IDs, tables imported through path aliases or chosen at run time (`DYNAMIC_MESSAGE_KEY`), a wrapper of your own around `defineMessages`, and `intl` from `injectIntl` or a parameter (`UNBOUND_TRANSLATOR`). `formatDate`, `formatNumber`, `formatRelativeTime`, `formatList` and `<FormattedDate>`-style helpers are not message calls: express dates and numbers in the message (`{d, date, medium}`, `{n, number}`) or use `Intl` directly.

## After the tool

- Replace `<IntlProvider locale messages>` with the Nordbeam provider (`<i18n.Provider initialLocale={locale}>` in Vite React) and delete the code that loaded messages into it.
- Rich `values` are already `rich(m.key, …)` calls. Tag names in the ICU stay the same; a renderer typed for react-intl's `chunks` receives the children array.
- `intl.locale` becomes `locale` from `i18n.useI18n()`.
- If source code relied on `defaultMessage` fallbacks, make sure the base catalog contains every message; Nordbeam reads catalogs, not source defaults.
- Finish with [finishing.md](finishing.md).
