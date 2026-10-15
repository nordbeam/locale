# Next migration — `@nordbeam/locale-migrate/next`

Requires `@nordbeam/locale-migrate`, which ships the migration tools outside `@nordbeam/locale`:

```sh
npm install --save-dev @nordbeam/locale-migrate
```

Install the same version as `@nordbeam/locale`. The `nordbeam-locale` commands `codemod`, `migrate` and `migrate-project` load it on first use.

Plan or apply safe Next App Router rewrites from supported i18n libraries.

```ts
import { planNextMigration, applyNextMigration } from '@nordbeam/locale-migrate/next';
```

`migrateNextSource` and `migrateNextMiddlewareSource` handle one source file;
`planNextMigration` and `applyNextMigration` handle the project plan. Exported
aliases `planNextAppMigration` and `applyNextAppMigration` are equivalent.

Migration option, plan, skip, and apply-result types are exported alongside the
functions. Unusual provider composition is returned as a skip for review.
