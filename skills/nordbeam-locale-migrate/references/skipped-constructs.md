# Skipped constructs and migration warnings

The preview and the codemod report every construct they refused to rewrite as `codemod.skipped[]` with `code`, `callee`, `reason`, `action`, `file`, `line`, `column` (and `offset`). Each is also a diagnostic code: `npx nordbeam-locale explain <CODE> --json` returns its explanation and fix. Never delete a skip from the list by guessing; resolve it, or leave the call on the legacy runtime and say so in the summary. `--strict` on `codemod` or `migrate-project` refuses to write while unresolved constructs remain (`UNRESOLVED_MIGRATION_CONSTRUCT`, exit 4), which is the right setting for CI.

## Call-site constructs

| Code | Meaning | What to do |
| --- | --- | --- |
| `DYNAMIC_MESSAGE_KEY`, `DYNAMIC_TEMPLATE_KEY` | The key is computed (`t(key)`, `` t(`a.${x}`) ``) | Replace by a literal key, a finite conditional (`cond ? 'a.yes' : 'a.no'`, which the project command lowers itself), or an explicit map of literal keys to message functions (`const label = { open: m.status.open, closed: m.status.closed }[state]`). Otherwise keep the call behind a lazy legacy boundary until it is migrated. |
| `MESSAGE_ID_UNRESOLVED` | The ID cannot be resolved from the source (Lingui source text, FormatJS default message) | Supply `--message-id-map`, or pass an explicit ID in source. |
| `RICH_MESSAGE` | Markup or component children (`<Trans>`, `t.rich`, `<FormattedMessage>` with children, `<i18n-t>`) | Rewrite the catalog text to ICU rich tags (`Read <link>terms</link>`) and render with `rich(m.key, { link: children => ... })` (`@nordbeam/locale/react/rich`), or the framework's callback form (Vue `h`, Svelte and Solid callbacks). Keep the same tags in every locale. |
| `UNSUPPORTED_OPTIONS` | Options the tool cannot translate (`defaultValue`, `returnObjects`, `context`, `ns`, count-as-argument, formatter options) | Move the behaviour into the message (plural or select) and pass plain values; migrate by hand. |
| `UNSUPPORTED_NAMESPACE_SYNTAX` | A namespace separator form it does not support | Migrate that call by hand using the nested ID. |
| `NESTED_TRANSLATION_CALL` | A translation call sits inside another call it cannot rewrite | Move the inner call to a variable, then migrate both. |
| `AMBIGUOUS_BINDING` | The translation function binding is shadowed or reassigned | Bind one translation function per scope, then re-run or migrate by hand. |
| `SOURCE_PARSE_ERROR` | The file does not parse | Fix the syntax error, then re-run. The file was not touched. |
| `MISSING_MESSAGES_BINDING` | A rewritten file calls `m` without binding it | Bind it with the framework adapter (see [finishing.md](finishing.md)), or pass `--messages-import` for a module that exports `m`. |
| `INCUMBENT_RUNTIME_IMPORT` | The file still imports the old runtime | Expected until the last call and provider are migrated; remove the import then. |

## Framework boundaries (always manual)

| Code | Replace with |
| --- | --- |
| `VUE_I18N_PLUGIN`, `VUE_NUXT_PLUGIN` | `createVueI18n` from `@nordbeam/locale/vue` and `app.use(i18n)`; in Nuxt wire it in a plugin by hand. |
| `VUE_TEMPLATE_API`, `VUE_GLOBAL_TRANSLATOR`, `VUE_ATTRIBUTE_TRANSLATION`, `VUE_I18N_COMPONENT` | Calls through `i18n.useI18n()` messages in the component; for `<i18n-t>` use a rich message and `h`. |
| `SVELTE_I18N_SETUP`, `SVELTEKIT_HOOK` | `setI18nContext(i18n)` in the root layout and the SvelteKit load pattern (nordbeam-locale skill, svelte reference). |
| `TYPESAFE_I18N_ADAPTER`, `TYPESAFE_I18N_LOADER` | The Nordbeam adapter for the framework and `loadLocale` where dictionaries were loaded. |
| `TRANSLOCO_PROVIDER`, `TRANSLOCO_TEMPLATE`, `NGX_TRANSLATE_PROVIDER`, `NGX_TRANSLATE_TEMPLATE`, `ANGULAR_BOOTSTRAP` | Angular has no adapter: provide the generated `loadLocale` through DI by hand. |
| `MANUAL_REVIEW` | Read the reported call, migrate it, then `check`. |

## Catalog warnings

| Code | What to do |
| --- | --- |
| `MIGRATION_INVALID_ICU` (inside `COMMAND_FAILED`) | A message is not valid ICU after conversion (`{{x}}` interpolation in a non-i18next format, stray braces). Fix the legacy catalog in a working copy, or pick the right `--catalog-format`. |
| `MIGRATION_ID_COLLISION`, `MIGRATION_LAYOUT_COLLISION`, `MIGRATION_INVALID_KEY` (errors) | Two keys map to one ID, a string collides with an object at the same path, or a key is empty. Rename one in the source catalog. |
| `MIGRATION_OUTPUT_EXISTS`, `FILE_EXISTS` (exit 4) | The destination exists; pick a new path. Nothing is overwritten. |
| `MIGRATION_UNPAIRED_PLURAL`, `MIGRATION_ORDINAL_ID`, `I18NEXT_CONTEXT` | Plural-like keys without partners, merged ordinals, context variants kept separate: review, then convert to plural, selectordinal or select. |
| `MIGRATION_INTERPOLATION_REVIEW`, `MIGRATION_LITERAL_BRACE`, `MIGRATION_UNESCAPED_INTERPOLATION`, `MIGRATION_PRINTF_PLACEHOLDER` | Check the converted text; quote literal braces; rename positional arguments. |
| `I18NEXT_FORMATTER`, `I18NEXT_NESTING` | Move formatting into ICU, inline nested references. |
| `I18NEXT_TRANS_INDEX`, `I18NEXT_RICH_TEXT` | Converted: `<0>` became `<tag0>`, named tags kept. Render with `rich()` and one function per tag; update the call sites. |
| `I18NEXT_UNSUPPORTED_MARKUP` | Skipped message (self-closing or attribute tags, unbalanced markup). Rewrite it with paired tags and add it to the catalog by hand. |
| `VUE_I18N_PIPE_PLURAL`, `VUE_I18N_LIST_INTERPOLATION`, `VUE_I18N_LINK_INLINED` | Converted vue-i18n syntax: pass `count` (or `n`) as an argument, pass `{ arg0: ... }` instead of a list, and remember inlined links are copies. |
| `VUE_I18N_UNSUPPORTED_SYNTAX` | Skipped message (custom modifiers, nested or cyclic links, links to plurals, computed keys, more than three pipe forms, `%{name}`). Write the ICU text by hand. |
| `DOTTED_SOURCE_ID` | A dotted ID became nested keys; rename if the nesting is unintended. |
| `MIGRATION_METADATA_DROPPED`, `MIGRATION_MESSAGE_FIELD`, `MIGRATION_LOCALE_REQUIRED` | Keep metadata elsewhere; confirm the converted text; pass `--locale`. |
| `PO_*` | PO transport and gettext problems; see [catalog-formats.md](catalog-formats.md). |
