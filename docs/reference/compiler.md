# Compiler — `@nordbeam/locale/compiler`

Use this entry to compile catalogs or build custom generation tooling.

```ts
import { compileProject, checkProject } from '@nordbeam/locale/compiler';
```

- `Catalog`, `Formats`, `CompilerOptions`, `CompilerCacheOptions` — compiler
  configuration types.
- `CompiledProject` — validated compiled catalogs and generated artifacts.
- `compileProject(options)` — compile and validate a project in memory.
- `compileSelection(project, entry, locale, keys)` — emit one selected artifact.
- `checkProject(options)` — validate without writing output.
- `createCompiler(cacheOptions?)` — create a reusable compiler function.
- `describeCatalog(catalog)` — return stable per-message argument, branch, and
  slot contracts for cloud validation and translation-memory matching.
- `compareContract(source, translation)` — report missing arguments, branches,
  or rich-text slots between two message contracts.
- `locateDiagnostics(diagnostics, sources)` — map in-memory diagnostics back to
  catalog source coordinates.
- `updateCatalogText(text, changes)` — change selected JSON values while
  retaining the surrounding layout.
- `CompileError`, `Diagnostic`, `formatDiagnostic`, and `quote` — diagnostics
  and code-generation helpers.

## Declarations

Generated `messages.d.ts` declarations carry each message's base-locale source
as a one-line JSDoc comment, so editors show the text on hover. The text is
collapsed to one line, truncated at 200 characters, and `*/` and word-initial
`@` are escaped so they cannot end the comment or start a tag. With the
`notes` option (message ID to text), a message's note follows as `@remarks`,
on the same line and with the same limits.

Catalogs with more than 256 messages split their declarations across
`types/N.d.ts` modules. `messages.d.ts` then combines them with one interface
that extends every module and a mapped `Messages` type, which keeps
`Record<string, unknown>` assignability and resolves each property to its
module declaration.
