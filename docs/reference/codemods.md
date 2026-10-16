# Source codemods — `@nordbeam/locale-migrate/codemods`

Requires `@nordbeam/locale-migrate`, which ships the migration tools outside `nordbeam-locale`:

```sh
npm install --save-dev @nordbeam/locale-migrate
```

Install the same version as `nordbeam-locale`. The `nordbeam-locale` commands `codemod`, `migrate` and `migrate-project` load it on first use.

Codemods make conservative, reviewable source changes during migration.

```ts
import { codemodSource, codemodProject } from '@nordbeam/locale-migrate/codemods';
```

- `codemodSource(text, format, options?)` — plan changes in one source file.
- `codemodProject(options)` — scan and optionally write a source tree.
- `readMessageIdBySourceFile(file, root?)` — read a source-to-ID map: a JSON object
  from each source text (`"Hello {name}"`) to its message ID (`"home.greeting"`).
  An array value is ambiguous and rejected. `codemod --message-id-map <file>` reads
  the same file; a Lingui 4 or 5 project whose catalogs use source text as IDs needs
  one, or no source macro resolves.
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

Lingui 4 and 5 source macros resolve through `messageIdBySource`. A tagged
macro's placeholders follow Lingui's extractor: `` t`Hi ${name}` `` reads
`Hi {name}` and becomes `m.id({ name })`, and any other expression is numbered,
so `` t`Hi ${user.name}` `` reads `Hi {0}` and becomes `m.id({ 0: user.name })`.
A translator around a macro (`` _(msg`…`) ``, `i18n._(msg({ message }))`) is
one call, and so are `t({ message })` and `` t(msg`…`) `` from `useLingui()`.
`<Trans>` children are read the way Lingui extracts them (whitespace, entities,
`{"text"}`, numbered elements); with elements the call is `rich(m.id, { tag0:
(children) => … })`. `msg` and `defineMessage` become the message function, not
a call, because Lingui translates a descriptor where it is read. A message with
a `context` resolves through a `context\u0004source` key.

Lingui's choices are messages too, on their own or inside another:
`plural()`, `select()` and `selectOrdinal()`, and `<Plural>`, `<Select>` and
`<SelectOrdinal>`. `plural(count, { one: '# item', other: '# items' })` reads
`{count, plural, one {# item} other {# items}}` and becomes `m.id({ count })`;
a value other than a name is numbered (`{0, plural, …}`), `0:` in `plural()` and
`_0` on `<Plural>` are the exact case `=0`, and a case holding an element becomes a
`rich()` slot. Only a choice imported from a Lingui macro package is read, so a
`<Select>` from a UI library stays an element. A spread, a computed case or a
dynamic `offset` is reported.

A message is looked up first as Lingui 5 extracts it (JSX text as React renders
it, every other character kept) and then as Lingui 4 does (whitespace normalized
and the message trimmed), so a catalog extracted by either resolves.

react-intl descriptors resolve from a `defineMessages` or `defineMessage`
constant in the same file. `codemodProject` also finds the ones a file imports
by a relative path and passes them as `formatjsMessages`; `codemodSource` alone
reads only its own file. A constant, or a relative import of one, that the
rewrite left unread is removed, unless it is exported. Values holding an element,
a tag renderer or a name bound to an element become `rich(m.id, values)`, and
`tagName` becomes the wrapping element. next-intl `t.rich(key, values)` becomes
`rich(m.key, values)`.

A translator that no hook binds, passed in as a parameter, taken from props or
an HOC (`this.props.t`, `injectIntl`), or held in another local, is reported as
`UNBOUND_TRANSLATOR` in files that use the library. The codemod cannot bind `m`
there; pass the messages object or message functions instead.

A skip's `offset`, `line` and `column` point into the text the codemod was
given. `codemodProject` reruns `codemodSource` until nested calls converge and
maps each position to the file on disk: the file as it was read for a preview, and
the written file with `write`.

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
