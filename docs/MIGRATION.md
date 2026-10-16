# Migrating to Nordbeam Locale

This guide moves an existing project to Nordbeam Locale from i18next and
react-i18next, next-intl, FormatJS and react-intl, Lingui, vue-i18n, Tolgee, PO
files, and other catalog formats. Catalogs, source calls, and whole projects can
each be migrated on their own, with a preview before anything is written.

Nordbeam Locale ships runtime adapters for React (Vite React, Next.js, and
TanStack Start), Vue, Svelte, and Solid. The Angular integrations in this guide are migration codemods
only, with no runtime adapter; keep the existing Angular runtime in place after a
codemod until you choose or build its replacement. The Vue and Svelte codemods
migrate catalogs and call sites, and `init --framework vue` or `svelte`
generates the adapter that replaces the legacy runtime. Plugin, store and
bootstrap code is reported rather than rewritten, so connect it by hand.

## Install the migration package

The migration commands are part of `nordbeam-locale`, but their tools ship in a separate package so that
runtime users do not install the migration parsers:

```sh
npm install --save-dev @nordbeam/locale-migrate
```

Install the same version as `@nordbeam/locale`. `codemod`, `migrate` and `migrate-project` load the package
on first use; without it they stop with `MIGRATE_PACKAGE_MISSING` and print this command.

## Migrating an existing catalog

The CLI has a conservative catalog-only converter for common web, mobile, and
gettext shapes:

```sh
npx nordbeam-locale migrate --from locales/en.json --format i18next \
  --out messages/en.json --dry-run
npx nordbeam-locale migrate --from messages/en.json --format next-intl \
  --out messages/en.json
npx nordbeam-locale migrate --from extracted.json --format formatjs \
  --out messages/en.json
npx nordbeam-locale migrate --from app.arb --format arb --out messages/en.json
npx nordbeam-locale migrate --from strings.xml --format android-xml \
  --out messages/en.json
npx nordbeam-locale migrate --from Localizable.xcstrings \
  --format apple-xcstrings --locale en --out messages/en.json
npx nordbeam-locale migrate --from src/i18n/en.ts --format module \
  --out messages/en.json --notes messages.notes.json
```

`i18next` converts simple `{{name}}` interpolation to ICU `{name}` and combines
paired `_one`, `_other` (and locale category) keys into a `{count, plural, ...}`
message. Unpaired plural-like keys are retained with a warning. Paired rich
markup such as `<bold>...</bold>` becomes an ICU rich-text tag (`I18NEXT_RICH_TEXT`),
and Trans index tags such as `<0>...</0>` become `<tag0>...</tag0>` because ICU
tag names cannot be numbers (`I18NEXT_TRANS_INDEX` lists the mapping). Render
those messages with `rich()` and pass one function per tag. A message with
self-closing tags, attributes or unbalanced tags is skipped with
`I18NEXT_UNSUPPORTED_MARKUP`; the rest of the catalog still migrates.

`vue-i18n` converts the vue-i18n message syntax instead of copying it. Pipe
plurals follow vue-i18n's default rule: `car | cars` becomes
`{count, plural, =1 {car} other {cars}}` and `none | one | {count} many`
becomes `=0`, `=1`, `other` branches, on `{count}` (or `{n}` when the message
uses that name). Call sites must pass the number as `count` (or `n`), which
vue-i18n supplied implicitly (`VUE_I18N_PIPE_PLURAL`). Plain linked messages
(`@:key`, `@:(key)`, `@:{'key'}`) are inlined (`VUE_I18N_LINK_INLINED`), and
`@.upper:`, `@.lower:` and `@.capitalize:` are applied to fixed linked text.
List placeholders `{0}`, `{1}` become `{arg0}`, `{arg1}`, so call sites pass an
object (`VUE_I18N_LIST_INTERPOLATION`). Custom modifiers, modifiers on messages
with arguments, nested or cyclic links, links to plurals, computed link keys,
more than three pipe forms (custom pluralization rules) and the legacy
`%{name}` syntax are skipped with `VUE_I18N_UNSUPPORTED_SYNTAX`, never copied
as text. `next-intl`
messages are already ICU and are copied, while FormatJS descriptors use their
`defaultMessage` (or the non-standard `message` field), and their descriptions
become notes. Nested input is emitted as a canonical nested
Nordbeam catalog, so dotted IDs keep their identity.

`module` reads a dictionary kept in TypeScript or JavaScript (`.ts`, `.mts`,
`.cts`, `.js`, `.mjs`, `.cjs`), as typesafe-i18n,
next-international and hand-written apps keep them. It parses the file and runs
nothing: the dictionary is the default export (`as const` and `satisfies` are
fine), a name the default export refers to, `module.exports`, or the module's only
exported object. Values must be string literals, template literals without
substitutions, `+` joins of those, or nested objects; anything computed or
spread is skipped with `MIGRATION_UNSUPPORTED_VALUE`. Strings must already be ICU.
A comment directly above a message, or after it on its line, is that message's
note.

`--notes <file>` writes the notes found in the source (module comments, FormatJS
and ARB descriptions) to a new [notes file](GUIDE.md#notes-about-messages);
without it they are reported as `MIGRATION_METADATA_DROPPED`. Like `--out`, it
never replaces an existing file.

Additional formats are `lingui`, `lingui-po`, `tolgee`, `arb`, `yaml`, `android-xml`,
`apple-strings`, `apple-xcstrings`, `po`, `pot`, `mo`, `json-gettext`, and `module`.
Android and Apple printf placeholders become named ICU arguments with a review
warning. Multi-locale Tolgee and Apple exports require `--locale` when the
source locale cannot be inferred safely.

`lingui-po` reads a PO catalog that Lingui 3 wrote; a `po` file whose header has
`X-Generator: @lingui/cli` is read the same way. Lingui reads ICU a little
differently from Nordbeam, so each message is decoded as Lingui reads it and
written again so that it renders the same text:

- Numbered tags `<0>…</0>` become `<tag0>…</tag0>` for `rich()`. `<0/>` becomes an
  empty `<tag0></tag0>`, which renders the component as written, as `<Trans>` did.
- Other HTML, such as `<br/>` or `<a href="…">`, stays text. A run of adjacent tags
  is one quoted literal: `One<br/><br/>Two` becomes `One'<br/><br/>'Two`, never
  `'<br/>''<br/>'`, which would render an apostrophe between the tags.
- An apostrophe that Lingui read as text stays text: `Users'<0>…</0>` becomes
  `Users''<tag0>…</tag0>`.
- Lingui trims the rendered text of a message with arguments, so the migration
  trims it too and reports `LINGUI_WHITESPACE_TRIMMED`. A message without
  arguments keeps its spaces, as in Lingui.
- Obsolete `#~` entries migrate, because Lingui 3 compiles and renders them
  (`LINGUI_OBSOLETE_INCLUDED`).
- Lines with unescaped quotes are read as Lingui reads them
  (`LINGUI_PO_QUOTES`).
- In the source locale, an empty `msgstr` takes its ID, which is what Lingui
  rendered (`LINGUI_SOURCE_ID_TEXT`). `migrate-project` knows the source locale.

Each converted message is then read back, and its text is compared with the
source once tags and arguments are normalized. A message that reads differently,
for example because of a lost apostrophe or dropped text, is reported as
`MIGRATION_TEXT_CHANGED` with its ID.

A nested catalog key is either a message or a namespace, never both, and it is
never empty. IDs that break this rule are renamed and reported once as
`MIGRATION_ID_RENAMED`, which carries the `renamed` map:

- `toast` next to `toast.action` becomes `toast.message`;
- the sentence ID `Try again later.` loses its empty last segment and becomes
  `Try again later`.

A warning that concerns many messages comes once per code and catalog, with a
`count` and the `messageIds`. Dotted IDs, dropped metadata, skipped fuzzy or
untranslated entries and the Lingui warnings above all work this way.

Migration never rewrites application source calls. Namespace resolution,
interpolation escaping, custom plural options, and FormatJS descriptions can
change runtime behavior and require review. `--dry-run --json` returns the full
converted document, warnings, and any ID/layout collisions. Existing output
files are never overwritten; choose a new path or move the reviewed result into
your configured catalog directory yourself.

## Migrating a complete project

Use the orchestrator when the legacy catalogs and application source should be
planned as one migration:

```sh
npx nordbeam-locale migrate-project --from legacy/messages \
  --format next-intl --framework next --source-dir src --json
npx nordbeam-locale migrate-project --from legacy/messages \
  --format next-intl --framework next --source-dir src --write
```

`--from` accepts one supported catalog file, a directory of locale-named catalog files, or (for the JSON formats) a directory of
`<locale>/<namespace>.json` folders, where each namespace becomes the first segment of the message ID
(`common.json` > `hi` migrates to `common.hi`; a lone `translation.json` stays unprefixed). A
single file defaults to locale `en`; set `--locale` when it represents another
locale. The command converts every catalog, validates the entire cross-locale
message contract, checks destination ownership, previews source rewrites, and
reports the remaining provider/import work. It creates nothing unless
`--write` is present.

The source format controls the codemod. `--catalog-format` names the format of
the legacy catalogs that are read, not of the catalogs that are written, which
are always Nordbeam's. Without it, each file's extension decides (`.po`, `.arb`,
`.yaml` and so on). JSON follows the source library: i18next and FormatJS have
their own converters, `vue-i18n` and `nuxt-i18n` use the `vue-i18n` converter,
and every other library reads ICU/next-intl JSON. A `.po` file under
`--format lingui` is read as `lingui-po`. When the inference is wrong, pass
`--catalog-format` explicitly. New
catalogs default to `messages-nordbeam`; `--catalogs`, `--base-locale`, and
`--out-dir` override the generated project layout. `--framework next` creates
the Next App Router helper/config when absent, while `--framework vite-react`
creates the Vite plugin config and client store when absent. Existing catalog
destinations are never replaced.

If a catalog fails to convert, or the converted catalogs break the cross-locale
message contract, the run fails with `COMMAND_FAILED` and nothing is written.
Every failing message is reported at once, each with its code, `locale`,
`messageId` and `file`, for example `MIGRATION_INVALID_ICU` or `UNKNOWN_ARGUMENT`.
Fix them in a working copy of the legacy catalogs and run again.

### Lingui 3 projects

With `--format lingui`, `--from .` (or the path of a `package.json` or
`.linguirc`) reads Lingui's configuration and migrates the catalogs it names.
The catalogs come from `catalogs[0].path` (or the older `localeDir`), with
`<rootDir>` and `{locale}` filled in, for every locale in `locales` except
`pseudoLocale`. The `format` decides the extension (`po` or `minimal`/`lingui`
JSON), and `sourceLocale` is the base locale. A `lingui.config.js` would have
to run to be read, so instead pass the catalog directory: a `<locale>/messages.po`
folder layout is found without configuration.

```sh
npx nordbeam-locale migrate-project --from . --format lingui \
  --framework vite-react --source-dir src --json
```

The migration keeps what Lingui rendered:

- IDs are renamed the same way in every locale and in the rewritten calls.
- A message that only translations hold takes its ID as source-locale text,
  which is what Lingui rendered there (`LINGUI_SOURCE_ID_TEXT`).
- A contract error in an obsolete `#~` entry says so in its hint. Deleting that
  entry is often the fix.

The Vite React integration rewrites `<Trans>` in these cases:

- **Components without `useLingui()`.** A component whose only messages were
  `<Trans>` elements gets `const m = i18n.useMessages()` at its top.
- **Elements outside any component.** An element at module scope, in a plain
  helper or in a class becomes
  `<LocaleMessage render={(m) => m.title()} />`. The migration declares this small
  component at the end of the file. The element stays lazy and renders in the
  current locale, as `<Trans>` did.
- **Files it cannot bind.** A file whose rewritten messages cannot be bound, for
  example because it declares its own `m`, is left unchanged and reported as
  `MISSING_MESSAGES_BINDING`.

### Framework bindings and providers

The complete-project command understands these source-library aliases:

| Runtime | Source formats | Automated boundary work |
| --- | --- | --- |
| Next App Router | `next-intl`, `next-i18next`, `react-i18next`, `next-international` | Server locale loading, dead imports, static params, Client Component hooks, nearest conventional locale-layout provider; for `next-intl` also the request file, `routing`, `navigation` and `next.config` modules (see below) |
| Vite React | `react-i18next`, `i18next`, `react-intl`, `formatjs`, `lingui-react`, `lingui`, `tolgee-react`, `tolgee` | One unconditional messages hook per proven component, dead imports, conventional `createRoot`/`hydrateRoot` provider |
| Vue/Nuxt | `vue-i18n`, `nuxt-i18n` | Static calls and dead bindings/imports; plugin/bootstrap boundaries reported (replace with `createVueI18n` from `@nordbeam/locale/vue`) |
| Svelte/SvelteKit | `svelte-i18n` | Static script and markup calls; store/bootstrap boundaries reported (replace with `setI18nContext` from `@nordbeam/locale/svelte`) |
| Angular | `transloco`, `ngx-translate` | Static service calls and literal template pipes, plus dead imports; DI providers and dynamic templates reported |
| Framework adapters | `typesafe-i18n` | Static nested `LL` calls and dead bindings; generated adapter/loader boundary reported |

For `next-intl`, the Next request file (`proxy.ts`, or `middleware.ts` before
Next 16, beside the `app` directory or in `src/`) is rewritten in place to
`createNextMiddleware(routing)`; the `routing` module's `defineRouting` and the
`navigation` module's `createNavigation` move to `@nordbeam/locale/next/routing`
and `/navigation`; and `createNextIntlPlugin(...)` becomes
`withNordbeamLocale(...)` in `next.config`. No second request file is created:
Next 16 refuses to build when `middleware.ts` and `proxy.ts` both exist. Files
that do not match these conventional shapes (an inline middleware options object,
extra `next-intl/routing` exports, `createNextIntlPlugin` options) are reported
as skips, and the plan lists manual actions: renaming `middleware.ts` to
`proxy.ts` on Next 16 (still loaded, but deprecated) and deleting the now-unused
`getRequestConfig` module.

For Vite React, pass the expression already used to select the initial locale:

```sh
npx nordbeam-locale migrate-project --from legacy/messages \
  --format react-i18next --catalog-format next-intl \
  --framework vite-react --initial-locale-expression locale --write
```

This produces `<i18n.Provider initialLocale={locale}>` around a conventional
root. Without the option, the tool migrates safe component bindings but leaves
the root unchanged and reports it. Next migration never inserts `"use client"`
into an existing Server Component. A generated `provider.ts` client bridge is
instead placed at a conventional locale layout. Co-located legacy providers,
conditional hooks, multiple dynamic route parameters, and unusual root shapes
are intentionally skipped rather than receiving a behavior-changing guess.

The framework planners are also public as `@nordbeam/locale-migrate/next`,
`@nordbeam/locale-migrate/react`, and
`@nordbeam/locale-migrate/frameworks` for custom local migration scripts.

## Migrating source calls

After converting catalogs, preview a conservative source codemod:

```sh
npx nordbeam-locale codemod --format i18next --source-dir src
npx nordbeam-locale codemod --format next-intl --source-dir src
npx nordbeam-locale codemod --format formatjs --source-dir src
npx nordbeam-locale codemod --format lingui --source-dir src
npx nordbeam-locale codemod --format lingui --source-dir src --message-id-map source-to-id.json --json
npx nordbeam-locale codemod --format svelte-i18n --source-dir src \
  --messages-import '$lib/i18n/nordbeam' --move-type-import MessageFormatter
npx nordbeam-locale codemod --format auto --source-dir src
```

The codemod recognizes bindings created by `useTranslation`, `useTranslations`,
`getTranslations`, `useIntl`, `useLingui`, Vue I18n's `useI18n`, Tolgee's
`useTranslate`, next-international's `useI18n`, and typesafe-i18n's
`useI18nContext`, Svelte i18n stores, Angular Transloco, and ngx-translate,
plus default/named `i18next.t` imports. It also converts
React Intl `<FormattedMessage>` and Lingui `<Trans>` components with proven
static IDs, including non-self-closing plain fallbacks.
It rewrites static IDs to nested `m.product.price()` calls and preserves a
single values argument. Static next-intl/i18next namespaces become key prefixes.

| Format | Recognized source shapes |
| --- | --- |
| i18next / react-i18next / next-i18next | `useTranslation` aliases, namespace + `keyPrefix`, default/named `i18next.t`, self-closing `<Trans i18nKey>` |
| next-intl | `useTranslations`, awaited `getTranslations`, object namespaces; `t.rich` is reported for the separate Nordbeam rich-renderer migration |
| FormatJS / React Intl | `useIntl().formatMessage`, destructured aliases, injected class calls, self-closing `<FormattedMessage>` |
| Lingui | `useLingui` `i18n._`/destructured `_` (descriptors keep their `values`, also inside `defineMessage()`), explicit-ID `<Trans>` (`id={'x'}` and finite conditionals such as `id={open ? 'a' : 'b'}` included), `<Trans components={[…]}>` as `rich(m.x, { tag0: … })`, explicit descriptor macros, and source macros when a catalog supplies an unambiguous source-to-ID map |
| Vue/Nuxt i18n | aliased `t` from `useI18n` |
| Tolgee | aliased `t` from `useTranslate` |
| next-international | function or destructured `t` returned by `useI18n` |
| typesafe-i18n | nested `LL` calls returned by `useI18nContext` |
| Svelte i18n | `$_` and `$t` stores in modules importing `svelte-i18n` |
| Angular Transloco | injected or conventional class `TranslocoService.translate` calls and literal `| transloco` template pipes |
| Angular ngx-translate | injected or conventional class `TranslateService.instant` calls and literal `| translate` template pipes |

`--format auto` applies every proven binding detector, which is useful in a
monorepo or an incremental migration containing more than one library.

For source-message systems such as Lingui, `--message-id-map` accepts a JSON
object whose keys are exact source strings and whose values are generated IDs.
The codemod rejects ambiguous array-valued entries. Its `compatibility` report
lists `directRewrites`, `fallbackFiles`, and a per-file plan: files with no
fallback can drop the legacy lookup map, while unresolved dynamic files retain
an explicit `lazy-legacy-boundary`. This report never changes a synchronous
call into an asynchronous one automatically.

Preview is the default. Add `--write` only after reviewing the changed/skipped
report. JavaScript and TypeScript call spans must pass Babel parsing before any
rewrite. Static template literals and finite conditional keys are supported;
the project command reparses between passes so nested translation calls
converge in one reviewed operation. Dynamic keys and templates,
rich JSX, multi-argument options, and ambiguous bindings are classified and
left untouched. Each skip includes a stable diagnostic `code`, a plain-language
`reason`, and a concrete `action`; compatibility files contain only the calls
that still need a lazy legacy boundary. Repeat `--custom-call callee` or
`--custom-call callee:namespace` for application-owned translation wrappers.
For a wrapper that a hook returns (`const t = useT()`), add `--messages-hook
useMessages` to `--messages-import`: the codemod replaces each such hook with
`const m = useMessages()` and imports the hook from that module.
Complete project migration verifies each static target against the generated
base-catalog message IDs before writing. The codemod does not invent provider
placement; pass `--messages-import <specifier>` (or `messagesImport` in the
API) when the generated `m` object has a known module and the codemod should
add/merge its value import. If an application bridge exports a compatible
replacement for an incumbent type-only formatter import, repeat
`--move-type-import <ExportedType>` to move that named type to
`--messages-import`. This operation is explicit, preserves aliases and mixed
imports, is counted separately as `typeImportsMoved`, and also works in Svelte
script blocks. It never guesses that two formatter types are compatible.
Otherwise connect `m` at the appropriate
server/client boundary after rewriting calls.
