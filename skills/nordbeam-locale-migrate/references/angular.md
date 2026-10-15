# Angular: Transloco and ngx-translate

Nordbeam Locale has no Angular runtime adapter. The codemods can convert catalogs and static service calls, but the app still needs a Nordbeam loader that you wire into Angular by hand. Tell the user this before starting, and keep the legacy runtime until a replacement is agreed.

`--format transloco` (`@jsverse/transloco` or `@ngneat/transloco`) or `--format ngx-translate` (`@ngx-translate/core`). Both libraries use `{{name}}` interpolation, which fails as invalid ICU under the default catalog format, so pass `--catalog-format i18next` (verified: without it the run stops with `MIGRATION_INVALID_ICU`, with it `Hi {{name}}` becomes `Hi {name}`):

```sh
npx nordbeam-locale migrate-project --from src/assets/i18n --format transloco --catalog-format i18next --source-dir src --json
```

Omit `--framework`: there is no Angular scaffold. Catalog files must be named by locale (`en.json`, `fr.json`).

## What the codemod rewrites

Static `TranslocoService.translate(...)` and `TranslateService.instant(...)` calls in injected or conventionally named class members (verified: `this.transloco.translate('hi', { name: 'Ada' })` became `m.hi({ name: 'Ada' })`), and literal `| transloco` and `| translate` template pipes. Reported and left alone: providers, modules and loaders (`TRANSLOCO_PROVIDER`, `NGX_TRANSLATE_PROVIDER`), bootstrap (`ANGULAR_BOOTSTRAP`), template pipes and directives that are not literal (`TRANSLOCO_TEMPLATE`, `NGX_TRANSLATE_TEMPLATE`), and dynamic keys.

## By hand

- Provide the generated messages through Angular DI (for example a service that loads a locale with the generated `loadLocale` and exposes `messages`), and bind `m` in each class that now calls `m.key(...)`.
- Replace the template pipes with calls through that service or component property.
- Locale switching, lazy loading and `LOCALE_ID` wiring are application code: use the generated `loadLocale(locale)` and `locales`.
- Remove the legacy modules, providers and `HttpClient` loaders once nothing uses them. Finish with [finishing.md](finishing.md).
