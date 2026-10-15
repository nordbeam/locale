# React migration — `@nordbeam/locale-migrate/react`

Requires `@nordbeam/locale-migrate`, which ships the migration tools outside `@nordbeam/locale`:

```sh
npm install --save-dev @nordbeam/locale-migrate
```

Install the same version as `@nordbeam/locale`. The `nordbeam-locale` commands `codemod`, `migrate` and `migrate-project` load it on first use.

Plan or apply source and provider rewrites for React applications.

```ts
import { planReactMigration, applyReactMigration } from '@nordbeam/locale-migrate/react';
```

- `planReactMigration(source, options?)` and `applyReactMigration(plan)` — one
  source file.
- `planReactProject(options)` and `applyReactProject(plan)` — project trees.
- `planReact`, `applyReact`, `planReactFrameworkMigration`, and
  `applyReactFrameworkMigration` — compatibility aliases.
- React migration option, plan, skip, and project-plan types.
