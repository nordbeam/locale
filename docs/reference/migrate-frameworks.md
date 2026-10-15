# Framework migration — `@nordbeam/locale-migrate/frameworks`

Requires `@nordbeam/locale-migrate`, which ships the migration tools outside `@nordbeam/locale`:

```sh
npm install --save-dev @nordbeam/locale-migrate
```

Install the same version as `@nordbeam/locale`. The `nordbeam-locale` commands `codemod`, `migrate` and `migrate-project` load it on first use.

This entry provides migration codemods for Vue, Svelte, and Angular. Vue, Svelte,
and Solid also have runtime adapters ([Vue](vue.md), [Svelte](svelte.md),
[Solid](solid.md)); Angular does not.

```ts
import { planFrameworkMigration, applyFrameworkMigration } from '@nordbeam/locale-migrate/frameworks';
```

- `planFrameworkMigration(source, options)` and `applyFrameworkMigration(...)`.
- `planFrameworkProject(options)` and `applyFrameworkProject(plan)`.
- `FrameworkMigration` supports `vue-i18n`, `svelte-i18n`, `transloco`,
  `ngx-translate`, and `typesafe-i18n`.
- Option, change, skip, plan, result, and project-plan types are exported.

Treat generated plans as a migration aid. For Vue and Svelte, replace the
legacy plugin or store bootstrap with the Nordbeam adapter once the plan is
applied; for Angular, keep the existing runtime because no adapter exists.
