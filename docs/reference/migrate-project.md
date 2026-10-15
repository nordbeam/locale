# Project migration — `@nordbeam/locale-migrate/project`

Requires `@nordbeam/locale-migrate`, which ships the migration tools outside `@nordbeam/locale`:

```sh
npm install --save-dev @nordbeam/locale-migrate
```

Install the same version as `@nordbeam/locale`. The `nordbeam-locale` commands `codemod`, `migrate` and `migrate-project` load it on first use.

Plan and apply a catalog plus application-source migration as one operation.

```ts
import { migrateProject, auditProjectResidues } from '@nordbeam/locale-migrate/project';
```

- `migrateProject(options)` — validate catalogs, plan rewrites, and scaffold a
  Next or Vite React integration.
- `auditProjectResidues(options)` — report legacy runtime imports and dynamic
  catalog boundaries that still need manual ownership.
- `ProjectMigrationOptions`, `ProjectMigrationResult`, and integration/audit
  result types describe the JSON-safe plan.

The default is preview-only; writing requires an explicit `write` option.
