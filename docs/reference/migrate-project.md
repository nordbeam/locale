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

- **Catalog discovery.** `from` is a catalog file, a directory of `<locale>.<ext>`
  files, or a directory of `<locale>/` folders that each hold one catalog. With
  `format: 'lingui'`, it can also be a project directory, `package.json` or
  `.linguirc`. The catalogs then come from the Lingui configuration
  (`catalogs[0].path` or `localeDir`, `locales` without `pseudoLocale`), and its
  `sourceLocale` is the base locale unless `baseLocale` or `locale` is given.
  Lingui's `{name}` paths and several catalogs are reported, not guessed.
- **Catalog format.** `catalogFormat` is the format of the legacy catalogs that
  are read. Without it, each file's format is inferred: a `.po` file under
  `format: 'lingui'` is `lingui-po`. Each `catalogs[]` entry reports the
  `format` it was read with.
- **Renamed IDs.** `renamedIds` maps every ID that could not be a nested key to
  its new name. The rename applies to every locale and to the planned source
  rewrites.
- **Failures.** A catalog that cannot be converted, or catalogs that break the
  cross-locale contract (`checkProject`), throw a `CompileError`. Its first
  diagnostic is `COMMAND_FAILED`. One diagnostic per failing message follows, with
  `code`, `locale`, `file` and `messageId`.
- **Vite React.** After the React plan, the write pass runs with
  `requireMessagesBinding`, so a file whose rewritten calls have no `m` in scope
  is left unchanged and reported as `MISSING_MESSAGES_BINDING`.
