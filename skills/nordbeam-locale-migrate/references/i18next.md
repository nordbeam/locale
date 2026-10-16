# i18next, react-i18next, next-i18next

`--format` values: `i18next`, `react-i18next`, `next-i18next`. The catalog format is inferred as i18next: `{{name}}` becomes `{name}`, and paired `key_one`, `key_other` (and other locale categories) become one `{count, plural, ...}` message. Use `--framework next` for Next.js, or `--framework vite-react` for a Vite React app (add `--initial-locale-expression <expr>` so the root provider can be placed).

```sh
npx nordbeam-locale migrate-project --from <merged catalog dir> --format react-i18next --framework vite-react --source-dir src --initial-locale-expression locale --json
```

## Prepare the catalogs

- Layout: `--from` accepts a directory of `<locale>.json` files, or the usual `locales/<locale>/<namespace>.json` folders. In the folder layout each namespace file becomes the first segment of the message ID (`common.json` > `hi` is `common.hi`); a locale folder that holds only `translation.json` stays unprefixed. A static namespace in a call then becomes a key prefix: `useTranslation('common')` plus `t('hi')` maps to `m.common.hi`. Namespace folders work for the JSON formats only; every locale needs the same layout. The `ns:key` separator form inside one string is not rewritten (`UNSUPPORTED_NAMESPACE_SYNTAX`).
- Rich markup: paired tags are converted to ICU rich-text tags. Named tags such as `<bold>...</bold>` keep their name (`I18NEXT_RICH_TEXT`); Trans index tags `<0>...</0>` become `<tag0>...</tag0>`, because ICU tag names cannot be numbers (`I18NEXT_TRANS_INDEX` lists the mapping). Render the message with `rich()` and pass one function per tag (`rich(m.terms, { tag0: children => <a href="/terms">{children}</a> })`); a plain `m.terms()` call returns parts, not text. A message with self-closing tags (`<br/>`), attributes (`<a href>`) or unbalanced tags is skipped with `I18NEXT_UNSUPPORTED_MARKUP` and is absent from the output: rewrite it with paired tags and migrate that one message by hand. Other messages still migrate.
- Plurals: `_one`/`_other` pairs are merged; a plural-like key without partners is kept unchanged with `MIGRATION_UNPAIRED_PLURAL`. Ordinal plurals are merged into one message (`MIGRATION_ORDINAL_ID`); call the merged message with an ordinal selector deliberately. Make sure each locale has the plural categories its language needs (`MISSING_PLURAL_CATEGORY` after `check`).
- Context keys such as `greeting_male`: documented as migrated to separate messages (`I18NEXT_CONTEXT`), and in a verified run they came through as plain separate keys with no warning. Search the migrated catalog for suffix keys and replace them with one `select` message, then change the call to pass the context value.
- Formatters (`{{value, number}}`), nesting (`$t(other.key)`), `returnObjects` and `defaultValue` are not equivalent. They surface as `I18NEXT_FORMATTER`, `I18NEXT_NESTING`, `UNSUPPORTED_OPTIONS`, or stay as literal text: search the migrated catalog for `$t(` and `{{`.
- `MIGRATION_UNESCAPED_INTERPOLATION` flags unescaped interpolation (`{{- x}}`); generated functions return plain strings and React escapes them as usual, so review any `dangerouslySetInnerHTML` use.

## What the codemod rewrites

`useTranslation` bindings (aliases, namespace and `keyPrefix`, and a static namespace list such as `useTranslation(['chat', 'common'])`, whose first namespace is the default while `common:key` or `{ ns: 'common' }` reach the others), default and named `i18next.t`, and self-closing `<Trans i18nKey="x" />`. Static keys become nested calls: `t('cart.items', { count: 3 })` becomes `m.cart.items({count: 3})`. Left alone and reported: dynamic keys (`DYNAMIC_MESSAGE_KEY`, `DYNAMIC_TEMPLATE_KEY`), `<Trans>` with children (`RICH_MESSAGE`), call options it cannot translate (`UNSUPPORTED_OPTIONS`), and any hook whose destructuring also pulls other state such as `i18n` (the binding is skipped, so `m` ends up unbound: bind it yourself). A `t` that arrives as a parameter (`t: TFunction`) or from props (`withTranslation`, `this.props.t`) is reported as `UNBOUND_TRANSLATOR`. `i18n.changeLanguage(...)` is not a translation call.

## After the tool

- Remove `i18n.use(initReactI18next).init(...)` and `<I18nextProvider>`; the generated `src/i18n/client.ts` and `<i18n.Provider initialLocale={...}>` replace them. Compute the initial locale yourself (for example from a language detector) and pass it as `initialLocale`.
- Replace `i18n.changeLanguage(x)` with `const { setLocale } = i18n.useI18n(); setLocale(x)`.
- Convert `<Trans>` blocks and `components` props to ICU tags with `rich()` (`@nordbeam/locale/react/rich`).
- next-i18next: remove `appWithTranslation`, `serverSideTranslations` and `next-i18next.config.js` once the routes use the `[locale]` App Router layout from the Next scaffold; follow [next-intl.md](next-intl.md) for the Next-specific request, routing and config steps.
- Finish with [finishing.md](finishing.md).
