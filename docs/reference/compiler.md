# Compiler — `nordbeam-locale/compiler`

Use this entry to compile catalogs or build custom generation tooling.

```ts
import { compileProject, checkProject } from 'nordbeam-locale/compiler';
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

## Locale tags

`CompilerOptions.intlLocales` maps a locale code to the BCP 47 tag that `Intl`
formats it with, such as `{ se: 'sv' }`. Generated formatters, plural rules,
ICU skeletons and the plural category checks use the tag; file names,
diagnostics and `loadLocale` keep the code. With the option set, each generated
`index.js` also exports `intlLocales`, a frozen map from every locale to its tag.
See [locale codes that mean another language](../GUIDE.md#locale-codes-that-mean-another-language).

## Declared arguments

`CompilerOptions.arguments` adds arguments to a message's contract that its base
text does not use, by message ID: `{ 'pricing.subtitle': { price: 'value' } }`.
Translations may then use them, the generated type requires them, and
development output checks them in every locale. `DeclaredArgumentKind` is
`'value' | 'number' | 'date'`. An unknown ID is `UNKNOWN_MESSAGE`, and an invalid
name or kind is `INVALID_DECLARED_ARGUMENT`. See
[arguments only a translation uses](../GUIDE.md#arguments-only-a-translation-uses).

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
