# typesafe-i18n and next-international

`--format typesafe-i18n` or `--format next-international`. Both libraries keep translations in TypeScript modules (typesafe-i18n `src/i18n/<locale>/index.ts`; next-international `locales/<locale>.ts`), and `capabilities --json` lists no catalog decoder for either. The migration commands read JSON (and the other listed catalog formats), so first convert the locale objects to one `<locale>.json` per locale in a scratch directory, with a small script you write and review, then pass that directory as `--from`.

Convert the message syntax while you do it, because the default catalog format treats the text as ICU:

- typesafe-i18n: `{name}` placeholders already match ICU; its own plural syntax (the `{{...}}` blocks) and formatter pipes (`{value|formatter}`) must become ICU: `{count, plural, one {# item} other {# items}}`, `{date, date, medium}`.
- next-international: `{name}` placeholders match ICU; its `{count, plural, ...}` strings are ICU-compatible. Keep nested objects as they are (dotted IDs).

```sh
npx nordbeam-locale migrate-project --from /tmp/typesafe-catalogs --format typesafe-i18n --framework vite-react --source-dir src --initial-locale-expression locale --json
```

## What the codemod rewrites

- typesafe-i18n: static nested `LL` calls obtained from `useI18nContext()` (`LL.cart.items({ count })` becomes `m.cart.items({count})`), and dead bindings. The adapter and context setup are reported (`TYPESAFE_I18N_ADAPTER`) as are dictionary and formatter loading (`TYPESAFE_I18N_LOADER`). Replace the typesafe adapter (`TypesafeI18n` provider, `setLocale` from the generated `i18n-react`) with the Nordbeam integration for the framework, wire the Nordbeam loader where dictionaries were loaded, and delete the generated typesafe files after nothing imports them.
- next-international: a function or destructured `t` returned by `useI18n` (`const t = useI18n()`), with `--framework next`. Follow [next-intl.md](next-intl.md) for the request file, routing and config steps, and replace `createI18nMiddleware`/`I18nProviderClient` with the Nordbeam middleware and provider.

Finish with [finishing.md](finishing.md).
