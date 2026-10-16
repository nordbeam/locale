# @nordbeam/locale-migrate

Migration tools for [Nordbeam Locale](../../README.md): convert catalogs and source calls from i18next, next-intl, FormatJS, Lingui, Tolgee and other libraries, and plan the Next, React and framework integration changes that go with them.

It is a separate package so that projects which are not migrating do not install the parsers it needs.

## Install

```sh
npm install --save-dev @nordbeam/locale-migrate
```

Install the same version as `nordbeam-locale`, the CLI. The package declares `nordbeam-locale` as an exact peer dependency. The CLI refuses to run the migration commands when the two versions differ.

## CLI

You do not import this package to use the CLI. `nordbeam-locale codemod`, `migrate` and `migrate-project` load it on first use. Without it they stop with `MIGRATE_PACKAGE_MISSING` and print the install command. A version mismatch stops with `MIGRATE_PACKAGE_VERSION`.

## Imports

| Import | Contents |
| --- | --- |
| `@nordbeam/locale-migrate/codemods` | `codemodSource`, `codemodProject`, `CodemodStrictError` |
| `@nordbeam/locale-migrate/project` | `migrateProject`, `auditProjectResidues` |
| `@nordbeam/locale-migrate/catalog` | `migrateCatalog` and the catalog format decoders |
| `@nordbeam/locale-migrate/next` | `planNextMigration`, `applyNextMigration`, source helpers |
| `@nordbeam/locale-migrate/react` | `planReactMigration`, `applyReactMigration` |
| `@nordbeam/locale-migrate/frameworks` | Vue, Svelte, Angular and other framework planners |

The root export `@nordbeam/locale-migrate` re-exports all of them, plus `version`.

See the reference pages in [`docs/reference`](../../docs/reference/README.md) and the [migration guide](../../docs/MIGRATION.md).

## License

[Apache License 2.0](LICENSE). Copyright 2026 Nordbeam.
