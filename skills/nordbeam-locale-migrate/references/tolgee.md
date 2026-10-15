# Tolgee

`--format tolgee` (core) or `--format tolgee-react` (React bindings); both read the `tolgee` catalog format when you pass `--catalog-format tolgee`. A Tolgee JSON export is either a plain key/value object or an array of rows with `keyName` and per-locale `translations`.

```sh
npx nordbeam-locale migrate --from export.json --format tolgee --locale en --out messages-nordbeam/en.json --dry-run --json
npx nordbeam-locale migrate-project --from tolgee-export --format tolgee-react --catalog-format tolgee --framework vite-react --source-dir src --initial-locale-expression locale --json
```

- Multi-locale exports need `--locale` (single file) or one locale-named file per language in a directory. Rows without a string for the selected locale are skipped with `MIGRATION_LOCALE_REQUIRED`.
- Tolgee message text is ICU, so plurals and selects carry over; check `check --json` after conversion for tag and argument mismatches between locales.
- Codemod: the aliased `t` from `useTranslate` (and the React variant) with static keys. Dynamic keys and anything the report lists under `codemod.skipped` stay in place; convert component-based rich content to ICU tags with `rich()`.
- Tolgee's in-context editing, API keys and CDN delivery (`TolgeeProvider`, `Tolgee().use(...)`) are runtime services with no Nordbeam equivalent. Remove them from the app once calls are migrated, and agree with the user where translators will edit catalogs instead (PO export/import with `export --locale` and `import --locale` is built in).
- Finish with [finishing.md](finishing.md).
