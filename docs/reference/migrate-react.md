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

For Lingui, the plan also binds messages where `<Trans>` needed no hook:

- A component or hook whose rewritten messages have no `m` in scope gets
  `const m = i18n.useMessages();` at the top of its body. An arrow function with
  an expression body becomes a block that returns the expression.
- An element outside any component becomes `<LocaleMessage render={(m) => …} />`
  (see `messageComponent` in [codemods](codemods.md)). The plan declares
  `LocaleMessage` once at the end of the file, typed in TypeScript files, and
  picks another name if `LocaleMessage` is taken.
- A file that still has a call on `m` without a binding, or that declares an `m`
  of its own, is returned unchanged and reported as `MISSING_MESSAGES_BINDING`.

`messageIdRenames` and `richMessageIds` pass through to the codemod.
