# Source codemods — `@nordbeam/locale-migrate/codemods`

Requires `@nordbeam/locale-migrate`, which ships the migration tools outside `@nordbeam/locale`:

```sh
npm install --save-dev @nordbeam/locale-migrate
```

Install the same version as `@nordbeam/locale`. The `nordbeam-locale` commands `codemod`, `migrate` and `migrate-project` load it on first use.

Codemods make conservative, reviewable source changes during migration.

```ts
import { codemodSource, codemodProject } from '@nordbeam/locale-migrate/codemods';
```

- `codemodSource(text, format, options?)` — plan changes in one source file.
- `codemodProject(options)` — scan and optionally write a source tree.
- `readMessageIdBySourceFile(file, root?)` — read source-to-ID maps.
- `CodemodFormat`, source/result/change/skip and compatibility plan types.
- `CodemodStrictError` — thrown when strict mode encounters an unsafe skip.

Dynamic keys and ambiguous providers are reported, not guessed. See [Migration](../MIGRATION.md).

`messageIdRenames` maps legacy IDs to the names the catalog migration gave them
(`migrateCatalog` and `migrateProject` report them as `MIGRATION_ID_RENAMED`).
Every rewritten call uses the new name.

`richMessageIds` lists the IDs whose base message has tags. A Lingui
`<Trans components={[…]}>` becomes `rich(m.id, { tag0: … })` only for those IDs,
and a plain call otherwise, because a message without tags never rendered its
components. Without the option, every element with `components` becomes `rich()`.
Each slot rebuilds the component around the message's children: a void element
such as `<br />` takes none, and an empty `<0></0>` renders the component as it was
written. Components passed by reference (`components={[link]}`) are reported as
`RICH_MESSAGE`.

`messageComponent` names a component that renders a message in the current
locale, `<C render={(m) => …} />`. When it is given, a Lingui `<Trans>` outside
any component (module scope, a plain helper, a class) becomes that element
instead of a call on `m`, which has no binding there. Function components and
hooks are recognized by their names (`Title`, `useTitle`), including arrow
functions assigned to a name or wrapped in `memo()` or `forwardRef()`.
`planReactMigration` declares the component; the option alone does not.

A Lingui `<Trans>` id may also be an expression: `id={'x'}` and a finite
conditional (`id={open ? 'a' : 'b'}`, also with `defineMessage({ id }).id`
branches) are rewritten; any other expression is `DYNAMIC_MESSAGE_KEY`.
`i18n._(descriptor)` keeps the descriptor's `values`, also inside
`defineMessage()`, `msg()` and `t()`.

`messagesImport` is an explicit opt-in source option (or `--messages-import <specifier>` on
`codemod`). When a call is rewritten, it adds or merges a value import for the configured
messages object; files with no replacements are left unchanged. JavaScript/TypeScript files
and Svelte instance scripts are supported, including repeated runs.

`messagesHook` (or `--messages-hook <name>`) names a hook that `messagesImport` exports
and that returns the messages object, such as `useMessages`. A formatter hook whose
calls were all rewritten, such as `const t = useT()`, becomes `const m = useMessages()`
in the same place. One that skipped calls (dynamic keys) keep alive stays, and
`const m = useMessages();` goes on the next line. The hook is imported instead of `m`.
A scope gets one binding, which covers the functions nested in it. A side-effect import of
the module (`import '~/i18n'`) becomes the named import. A formatter that arrives as a
parameter or from `await` has no hook to replace; its calls still reference `m`, and
`codemod` reports the file as `MISSING_MESSAGES_BINDING`. JavaScript and TypeScript files only.

`moveTypeImports` is an explicit list of named type-only imports to move to
`messagesImport`; the CLI equivalent is repeatable `--move-type-import <name>`.
Aliases and mixed imports are preserved, the move is counted as
`typeImportsMoved`, and the tool never assumes two formatter types are
compatible. Project runs lower finite conditional keys and reparse between
passes so nested calls converge in one operation. Unresolved constructs expose
a stable `code`, explanation, source offset, and suggested `action` in machine
output; strict mode refuses to write them.
