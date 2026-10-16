# Error and diagnostic codes

Every JSON `errors[].code`, `warnings[].code` and NDJSON diagnostic code emitted by `nordbeam-locale` is listed here. Run `nordbeam-locale explain <CODE>` for the same entry in the terminal, or `explain <CODE> --json` for machine output. Check and doctor diagnostics also carry `fix` and `docs` fields.

## Exit status

| Status | Meaning |
| --- | --- |
| 0 | Success. |
| 1 | Validation failure: check or doctor found errors, a compile error stopped the command, or the command reported a condition it cannot proceed past (`COMMAND_FAILED`). |
| 2 | Usage error: an unknown command or option, a missing or conflicting option, or a value outside the accepted set. |
| 3 | An input file, directory or configuration path does not exist. |
| 4 | The command refused an unsafe operation: a stale plan, an existing output file, or a strict codemod refusal. Nothing was written. |
| 70 | Internal error: an unexpected exception such as a TypeError. Report it with the command and its output. |

With `--json`, stdout holds one JSON document in every case, and the failure is `ok: false` with `errors[].code`. Read the status and `code` together; the status is the coarse category, the code is the specific cause.

## Command failures

### APPLY_FAILED

Severity: error. Exit status 4.

apply-plan could not write every target. Every change it had made was rolled back, so the project is unchanged.

**Fix:** Check the reported path and its permissions, then regenerate the plan and apply it again.

### COMMAND_FAILED

Severity: error. Exit status 1.

The command stopped on a condition that its message describes, such as overlapping directories or an unsupported migration source. Nothing was written.

**Fix:** Correct the input or configuration the message names, then retry.

### CONFIG_EXISTS

Severity: error. Exit status 4.

init found a configuration file and refuses to replace it.

**Fix:** Edit the existing configuration file, then run nordbeam-locale without init.

### FILE_EXISTS

Severity: error. Exit status 4.

The command would overwrite an existing file, so it refused. Nothing was changed.

**Fix:** Choose a new output path, or review and remove the existing file yourself.

### FILE_NOT_FOUND

Severity: error. Exit status 3.

A file or directory that the command reads does not exist. details.path is project-relative when the path is inside the project.

**Fix:** Check the path, or pass the correct --config, --catalogs or --from value. Run nordbeam-locale init to create a starter project.

### INTERNAL_ERROR

Severity: error. Exit status 70.

An unexpected exception, such as a TypeError, escaped the command. The inputs may be valid, so this indicates a defect or an unhandled case in the tool.

**Fix:** Re-run with --json or --ndjson to capture the message, then report the full command and its output.

### INVALID_PLAN

Severity: error. Exit status 1.

The plan file is not a valid reviewed plan: its schema, protocol version or plan hash does not match its contents.

**Fix:** Regenerate the plan with codemod --plan <new-file> --json. Do not edit plan files by hand.

### INVALID_TARGET

Severity: error. Exit status 1.

A plan lists a target path that is outside its allow-list or is not a valid project-relative path.

**Fix:** Regenerate the plan from the current project; do not edit plan files by hand.

### MESSAGE_ALREADY_EXISTS

Severity: error. Exit status 4.

rename or extract would add a message ID that the base catalog already defines, so it refused.

**Fix:** Choose a new message ID, or edit the existing message in the base catalog.

### MIGRATE_PACKAGE_MISSING

Severity: error. Exit status 3.

A migration command (codemod, migrate or migrate-project) needs @nordbeam/locale-migrate, which is not installed. Nothing was read or written.

**Fix:** Install the migration package at the same version as nordbeam-locale: npm install --save-dev @nordbeam/locale-migrate@<nordbeam-locale version>, then retry.

### MIGRATE_PACKAGE_VERSION

Severity: error. Exit status 1.

The installed @nordbeam/locale-migrate version differs from the installed nordbeam-locale version. The two must match exactly, so the command stopped before reading or writing.

**Fix:** Install the matching version: npm install --save-dev @nordbeam/locale-migrate@<nordbeam-locale version>.

### MIGRATION_OUTPUT_EXISTS

Severity: error. Exit status 4.

The migration output path already exists, so migrate refused to overwrite it.

**Fix:** Choose a new --out path, or review and remove the existing file.

### MISSING_TARGET

Severity: error. Exit status 4.

A target that the plan changes no longer exists.

**Fix:** Regenerate the plan from the current project state.

### PSEUDO_TARGET_EXISTS

Severity: error. Exit status 4.

The pseudo-locale catalog already exists and pseudo refuses to replace it.

**Fix:** Pass --update to replace it, or choose a different locale.

### ROOT_MISMATCH

Severity: error. Exit status 4.

The plan was created for a different project root than the one apply-plan runs in.

**Fix:** Run apply-plan from the project root the plan was created in, or regenerate the plan here.

### STALE_PLAN

Severity: error. Exit status 4.

A target changed after the plan was created, so applying it could overwrite newer work. No target was written.

**Fix:** Review the current source, regenerate the plan with codemod --plan, then apply the new plan.

### TARGET_NOT_FILE

Severity: error. Exit status 4.

A planned target is a directory, a symbolic link or another non-file entry.

**Fix:** Remove the non-file entry or exclude it from the scan, then regenerate the plan.

### UNEXPECTED_TARGET

Severity: error. Exit status 4.

A target that the plan expects to be absent now exists.

**Fix:** Regenerate the plan from the current project state.

### UNKNOWN_FORMAT

Severity: error. Exit status 2.

A format name is not supported. For --format and --catalog-format, validValues lists the accepted names. The compiler also uses this code for an ICU number, date or time style that is not declared under formats.

**Fix:** Use one of validValues, or declare the ICU style under formats in the configuration.

### UNRESOLVED_MIGRATION_CONSTRUCT

Severity: error. Exit status 4.

codemod --strict stopped because a source construct cannot be rewritten safely. Nothing was written.

**Fix:** Migrate the reported call by hand, or drop --strict to write the rewritable calls and review the skipped list.

### USAGE

Severity: error. Exit status 2.

The command line is invalid: an unknown command or option, a missing required option, conflicting options, or a value outside the accepted set. Nothing was read or written.

**Fix:** Run nordbeam-locale help <command> for the accepted options, or capabilities --json for the complete contract, then retry.

### VALIDATION_FAILED

Severity: error. Exit status 1.

A command finished and found validation errors that have no more specific code.

**Fix:** Read errors[] in the JSON output, fix each reported diagnostic, then run nordbeam-locale check --json.

## Diagnostics

Diagnostics are reported by check, doctor, generate and the migration commands. Warnings do not fail a command; errors do.

### AMBIGUOUS_BINDING

Severity: warning.

The translation function binding is ambiguous, so the call was not rewritten.

**Fix:** Bind one translation function per scope, or migrate the call by hand.

### ANGULAR_BOOTSTRAP

Severity: warning.

Angular bootstrap providers are framework-owned, so the migration does not rewrite them.

**Fix:** Wire the Nordbeam runtime into the Angular bootstrap by hand.

### ARGUMENT_KIND_MISMATCH

Severity: error.

An argument is a value in one message and a rich-text slot in another.

**Fix:** Use the same kind in every locale.

### ARGUMENT_TYPE_CONFLICT

Severity: error.

One message uses the same argument name as both a rich-text slot and a value.

**Fix:** Rename one of the two uses.

### BASE_LOCALE_MISSING

Severity: error.

The base locale has no catalog, so the other locales have nothing to fall back to.

**Fix:** Create the base catalog, or set baseLocale to a locale that has one.

### CATALOG_CHANGED

Severity: error.

A catalog changed while the command was reading it, so the result could be inconsistent.

**Fix:** Run the command again once the edit has finished.

### CATALOG_LAYOUT_CONFLICT

Severity: error.

Adding the message would replace a nested catalog object at the same path.

**Fix:** Convert that subtree to flat dotted keys, then retry.

### CATALOG_READ_ERROR

Severity: error.

A catalog file could not be read.

**Fix:** Check that the file exists and is readable UTF-8 JSON.

### CONFIG_DEVELOPMENT_IGNORED

Severity: warning.

The development setting in the configuration is ignored. Output mode comes from NODE_ENV or from the --development and --production flags.

**Fix:** Remove development from the configuration, and choose the mode with NODE_ENV or a flag.

### DOCTOR_ERROR

Severity: error.

doctor could not finish inspecting the project. The message says which step failed.

**Fix:** Fix the reported input, then run doctor again.

### DOTTED_SOURCE_ID

Severity: warning.

A message ID contains a dot and migrates as nested catalog keys.

**Fix:** Rename the ID if the nesting is unintended, or call it through the nested path.

### DROPPED_RICH_TAG

Severity: warning.

A translation drops a rich-text tag from the base message, so that text loses its markup.

**Fix:** Restore the tag pair in the translation.

### DUPLICATE_KEY

Severity: error.

A message key is defined more than once, so only the last value would be used.

**Fix:** Keep one definition of the key and delete the other.

### DYNAMIC_MESSAGE_KEY

Severity: warning.

The message key is computed at runtime, so its ID cannot be known statically.

**Fix:** Use a literal key, or migrate the call by hand.

### DYNAMIC_TEMPLATE_KEY

Severity: warning.

The template-literal key is dynamic, so its message ID cannot be known statically.

**Fix:** Use a literal key, or migrate the call by hand.

### EMPTY_SCOPE

Severity: error.

The modules of a scope name no message IDs, so its loader would hold no messages.

**Fix:** List the files that render the scope's messages in its modules, or add the messages to the scope.

### EMPTY_SCOPE_PATTERN

Severity: warning.

A configured scope pattern matches no messages, so the scope selects nothing.

**Fix:** Correct the pattern, or remove the scope if it is no longer needed.

### FALLBACK_MESSAGE

Severity: warning.

A message is served from the base locale because the requested locale does not provide it.

**Fix:** Translate the message in the requested locale, or accept the base text as the fallback.

### HARDCODED_TEXT

Severity: warning.

Source code renders UI text from a string literal instead of a catalog message, so every locale sees the same text. doctor reports a summary; hardcoded lists each string with its confidence.

**Fix:** Run nordbeam-locale hardcoded --fix to reuse catalog messages with the same text, --extract to add new ones, or mark text that is not UI copy with a nordbeam-locale-ignore comment.

### I18NEXT_CONTEXT

Severity: warning.

i18next context variants were migrated as separate messages.

**Fix:** Use one message with a select on the context value.

### I18NEXT_FORMATTER

Severity: warning.

An i18next formatter was kept as a plain argument.

**Fix:** Format the value in code, or declare a Nordbeam formatter.

### I18NEXT_NESTING

Severity: warning.

An i18next $t() nesting reference was kept as literal text.

**Fix:** Inline the referenced message, or compose the two messages in code.

### I18NEXT_RICH_TEXT

Severity: warning.

Named markup tags in an i18next message were converted to ICU rich-text tags.

**Fix:** Render the message with rich() and pass one function per tag.

### I18NEXT_UNSUPPORTED_MARKUP

Severity: warning.

An i18next message has markup that cannot become a rich-text tag (self-closing, with attributes, or unbalanced), so it was not migrated.

**Fix:** Use paired tags such as <link>...</link> in the legacy catalog, or write the message by hand.

### I18NEXT_TRANS_INDEX

Severity: warning.

Trans index tags such as <0>...</0> were converted to named rich-text tags (<tag0>, <tag1>), because ICU tag names cannot be numbers.

**Fix:** Render the message with rich() and pass one function per tag (tag0, tag1, ...).

### IGNORED_CATALOG_FILE

Severity: warning.

A file in the catalog directory is not a recognized catalog, so it is ignored.

**Fix:** Move the file out of the catalog directory, or rename it to a supported locale file name.

### INCUMBENT_RUNTIME_IMPORT

Severity: warning.

The file still imports the previous i18n runtime.

**Fix:** Remove the old runtime import after its calls are migrated.

### INVALID_CATALOG

Severity: error.

A catalog has a structure the compiler cannot read, such as a root that is not an object.

**Fix:** Make the catalog root a JSON object whose leaves are message strings.

### INVALID_CONFIG

Severity: error.

The configuration file is unreadable, is not valid JSON, or contains a value that is not allowed.

**Fix:** Fix the reported field in the configuration file. nordbeam-locale schema writes an editor schema that flags these values as you type.

### INVALID_DECLARED_ARGUMENT

Severity: error.

The arguments option declares an argument with a name that is not an identifier or a kind other than value, number or date.

**Fix:** Declare each argument as "value" (a plain {name}), "number" or "date".

### INVALID_FORMAT

Severity: error.

An ICU number, date or time pattern or skeleton was rejected by Intl.

**Fix:** Correct the pattern or skeleton named in the message.

### INVALID_ICU

Severity: error.

An ICU MessageFormat message is syntactically invalid and cannot be compiled. The reason field gives the parser code.

**Fix:** Correct the ICU syntax at the reported location. Use {name} placeholders and quote literal braces with apostrophes.

### INVALID_JSON

Severity: error.

A catalog file is not valid JSON, so its messages cannot be read.

**Fix:** Fix the JSON syntax at the reported location. A catalog must be a single JSON object.

### INVALID_KEY

Severity: error.

A message key is empty or otherwise cannot be a message ID.

**Fix:** Give the message a non-empty dotted ID, such as checkout.pay.

### INVALID_INTL_LOCALE

Severity: error.

An intlLocales value is not a canonical BCP 47 tag, so Intl cannot format the locale with it. The locale is not compiled.

**Fix:** Map the locale to a canonical tag such as sv, nb or pt-BR.

### INVALID_LOCALE

Severity: error.

A locale is not a canonical BCP 47 tag, so it cannot name a catalog.

**Fix:** Use a canonical tag such as en, fr or pt-BR.

### INVALID_MESSAGE_ID

Severity: error.

A message ID is empty, starts or ends with a dot, or has an empty segment.

**Fix:** Use a non-empty dotted ID such as checkout.pay.

### INVALID_NOTES

Severity: error.

The notes file cannot be read, is not JSON shaped like a catalog, or sits in the catalog directory.

**Fix:** Keep the notes file outside the catalog directory, as a JSON object whose leaves are note strings.

### INVALID_PO

Severity: error.

The PO file is malformed and cannot be read safely.

**Fix:** Fix the reported PO syntax at the given line, or export a fresh PO file.

### INVALID_SCOPE

Severity: error.

A scope name in the configuration is not a valid identifier.

**Fix:** Start the scope name with a letter, then use only letters, digits, underscores or hyphens.

### INVALID_SELECTION

Severity: error.

A requested loader or locale is not part of the generated project.

**Fix:** Use a locale that has a catalog, or add the catalog and regenerate.

### LINGUI_COMPILED_ENTRY

Severity: warning.

A compiled Lingui entry could not be converted, so it was not migrated.

**Fix:** Migrate the source catalog instead of the compiled output.

### LINGUI_OBSOLETE_INCLUDED

Severity: warning.

Obsolete (`#~`) PO entries were migrated, because Lingui 3 compiles and renders them. The warning counts them and lists their IDs in `messageIds`.

**Fix:** Run nordbeam-locale prune after the source migration to find the ones no code uses.

### LINGUI_PO_QUOTES

Severity: warning.

Lingui-written PO lines had unescaped interior quotes; they were read as Lingui reads them, as the text between the first and last quote.

**Fix:** Escape the quotes in the PO file if other gettext tools read it.

### LINGUI_SOURCE_ID_TEXT

Severity: warning.

A source-locale message had no text, so its ID became its text, which is what Lingui rendered. This covers an empty `msgstr` in the source locale and, under migrate-project, a message only translations hold.

**Fix:** Write the text the message should show in the source locale.

### LINGUI_WHITESPACE_TRIMMED

Severity: warning.

Leading or trailing whitespace was trimmed from messages with arguments, as Lingui trims them when it renders. Messages without arguments keep their whitespace, as in Lingui.

**Fix:** Put intended spacing in the surrounding markup instead of the message.

### LOCALE_MISSING

Severity: error.

No catalog exists for the requested locale.

**Fix:** Create the locale catalog, or pass a locale that has one.

### MANUAL_REVIEW

Severity: warning.

A construct was skipped and needs human review.

**Fix:** Migrate the reported call by hand, then run check.

### MESSAGE_ID_UNRESOLVED

Severity: warning.

The message ID of a call could not be resolved from the source.

**Fix:** Pass a literal key, or map the source file with --message-id-map.

### MESSAGE_NOT_FOUND

Severity: error.

The message that rename or extract should change is not present in the base catalog.

**Fix:** Check the ID with nordbeam-locale inspect --id <id>, then retry with the correct ID.

### MESSAGE_TOO_DEEP

Severity: error.

The message nests too deeply for the compiler to generate code for it.

**Fix:** Split the message into smaller messages and compose them in code.

### MIGRATION_ID_COLLISION

Severity: error.

Two input keys map to the same message ID, one nested and one flat.

**Fix:** Rename one of the keys so that every message ID is unique.

### MIGRATION_ID_RENAMED

Severity: warning.

A message ID could not nest as written (a message that is also a namespace, or an empty or space-edged segment), so it was renamed: `toast` next to `toast.action` becomes `toast.message`, and `Try again later.` becomes `Try again later`. The warning carries the `renamed` map; migrate-project applies the same renames in every locale and to the calls it rewrites.

**Fix:** Use the new ID. migrate-project rewrites the calls; after migrate alone, rename them in the source.

### MIGRATION_INTERPOLATION_REVIEW

Severity: warning.

An interpolation could not be converted completely.

**Fix:** Convert the reported interpolation by hand, then check the result.

### MIGRATION_INVALID_KEY

Severity: error.

An input key is empty and cannot become a message ID.

**Fix:** Give the key a name in the source format, then retry.

### MIGRATION_LAYOUT_COLLISION

Severity: error.

A migrated message would replace a catalog object or string at the same path.

**Fix:** Rename one of the keys so the two layouts do not overlap.

### MIGRATION_LITERAL_BRACE

Severity: warning.

Literal braces in the source text may change meaning in ICU.

**Fix:** Confirm the text is intended, and quote literal braces with apostrophes.

### MIGRATION_LOCALE_REQUIRED

Severity: warning.

A Tolgee export has no string for the selected locale.

**Fix:** Pass --locale for multi-locale Tolgee exports.

### MIGRATION_MESSAGE_FIELD

Severity: warning.

A non-standard message field was used instead of defaultMessage.

**Fix:** Confirm that the converted text is correct.

### MIGRATION_METADATA_DROPPED

Severity: warning.

ARB metadata was dropped because the target catalog format has no equivalent.

**Fix:** Keep a copy of the metadata if your tooling needs it.

### MIGRATION_ORDINAL_ID

Severity: warning.

i18next ordinal plurals were merged into one message.

**Fix:** Call the merged message with an ordinal selector.

### MIGRATION_PRINTF_PLACEHOLDER

Severity: warning.

A printf placeholder was converted to an ICU argument.

**Fix:** The plural selector supplies the count; check the converted text.

### MIGRATION_READ_ERROR

Severity: error.

The migration source could not be read.

**Fix:** Check the --from path and that the file is valid for its format.

### MIGRATION_TEXT_CHANGED

Severity: warning.

A converted message reads differently from its source once tags and arguments are normalized, for example a lost apostrophe or dropped text. The warning names the message in `messageId`.

**Fix:** Compare the message with its source and correct the converted catalog.

### MIGRATION_UNESCAPED_INTERPOLATION

Severity: warning.

An unescaped interpolation was converted. The HTML escaping at the call site may differ.

**Fix:** Confirm the escaping at the call site.

### MIGRATION_UNPAIRED_PLURAL

Severity: warning.

A plural-like key had no matching variants, so it was kept unchanged.

**Fix:** Add the missing variants, or leave the key as it is.

### MIGRATION_UNSUPPORTED_DESCRIPTOR

Severity: error.

A FormatJS descriptor has no string defaultMessage, so it cannot be migrated.

**Fix:** Add a string defaultMessage to the descriptor.

### MIGRATION_UNSUPPORTED_VALUE

Severity: error.

A value is neither a string nor a nested object, so it cannot be migrated.

**Fix:** Convert the value to a string.

### MISSING_ARGUMENT

Severity: error.

A translation drops an argument that the base message uses.

**Fix:** Add the argument placeholder back to the translation.

### MISSING_MESSAGE

Severity: warning.

A locale lacks a message that the base locale defines, so the base text is used at runtime.

**Fix:** Translate the message in that locale, for example with nordbeam-locale import of a reviewed PO file.

### MISSING_MESSAGES_BINDING

Severity: warning.

A rewritten source file calls the generated messages object without binding it first.

**Fix:** Import or bind the messages object in that file, or pass --messages-import to codemod, with --messages-hook when that module exports a hook such as useMessages.

### MISSING_PLURAL_BRANCH

Severity: error.

A translation has no branch for a plural category that the base message defines.

**Fix:** Add the branch to the translation. Use other {...} as the fallback branch.

### MISSING_PLURAL_CATEGORY

Severity: warning.

A translation lacks a plural category that its locale requires, so some counts fall back to other.

**Fix:** Add the missing category, such as one or other, to the translation.

### MISSING_SELECT_BRANCH

Severity: error.

A translation lacks a select branch that the base message defines.

**Fix:** Add the missing branch to the translation.

### NESTED_TRANSLATION_CALL

Severity: warning.

A translation call is nested inside another call that the rewriter cannot handle.

**Fix:** Move the inner call into a variable, then migrate it by hand.

### NGX_TRANSLATE_PROVIDER

Severity: warning.

ngx-translate providers and loaders are Angular dependency-injection code that the migration does not rewrite.

**Fix:** Configure the Nordbeam loader in the Angular providers by hand.

### NGX_TRANSLATE_TEMPLATE

Severity: warning.

ngx-translate pipes and directives in templates need an explicit template migration.

**Fix:** Replace the translate pipe or directive in each template by hand.

### SCOPE_DYNAMIC_ACCESS

Severity: warning.

A file that a computed scope reads indexes the messages object with a computed key, such as m[key]() or m.status[state](). The crawl cannot tell which message that is, so the scope may lack it, and a page that reads a message its scope lacks fails at run time. Tests that render the full catalog do not notice.

**Fix:** Read the message with a literal key or a template such as m[`status.${state}`](), keep a map of message functions such as { open: m.status.open }[state], or add its IDs or a prefix.* pattern to the scope's messages. A nordbeam-locale-ignore comment on the line keeps a reviewed read quiet.

### SCOPE_MODULE_NOT_FOUND

Severity: error.

A module pattern of a scope matches no files, so the scope cannot be computed.

**Fix:** Correct the pattern, relative to the project root, or remove it.

### SELECTION_FALLBACK

Severity: warning.

The Vite integration could not select a locale for a module and used the fallback.

**Fix:** Set the selection expression or the initial locale so that every module resolves a locale.

### PO_BASE_LOCALE

Severity: error.

import targeted the base locale. The base locale is edited in its JSON catalog, not imported from PO.

**Fix:** Choose a target locale that differs from the base locale, and edit source messages in the base JSON catalog.

### PO_DUPLICATE_ID

Severity: error.

The PO file contains the same message ID twice.

**Fix:** Keep one entry for each msgctxt.

### PO_ENCODING

Severity: error.

The PO Content-Type does not declare text/plain with charset=UTF-8.

**Fix:** Save the file as UTF-8 and set Content-Type to text/plain; charset=UTF-8.

### PO_FUZZY_HEADER

Severity: error.

The PO header is marked fuzzy, so the file cannot be trusted as reviewed.

**Fix:** Remove the fuzzy flag from the header, then import again.

### PO_FUZZY_SKIPPED

Severity: warning.

A fuzzy translation was skipped during migration because it has not been reviewed.

**Fix:** Review the translation and remove its fuzzy flag before migrating it.

### PO_GETTEXT_PLURAL

Severity: error.

The entry uses gettext plural arrays, which cannot represent ICU plurals.

**Fix:** Keep ICU plural messages inside a single msgid and msgstr.

### PO_LOCALE_MISMATCH

Severity: error.

The PO Language header does not match the requested locale.

**Fix:** Import the PO file for that locale, or correct its Language header.

### PO_MISSING_CONTEXT

Severity: error.

A PO entry has no stable message ID in msgctxt, so it cannot be matched to a message.

**Fix:** Export a PO file with nordbeam-locale export, then translate that file.

### PO_MISSING_HEADER

Severity: error.

The PO file has no header with Language and a UTF-8 Content-Type.

**Fix:** Add the header, or export a fresh PO file.

### PO_PLURAL_FORMS_INVALID

Severity: warning.

The plural forms cannot be mapped because the catalog language is missing or invalid.

**Fix:** Set a canonical Language header, such as pl or pt-BR.

### PO_PLURAL_FORMS_MISSING

Severity: warning.

The Plural-Forms header is missing, so plural messages keep only their one and other forms.

**Fix:** Add nplurals and plural to the Plural-Forms header.

### PO_PLURAL_MAPPING

Severity: warning.

A plural category maps to several msgstr forms, so one of them was chosen.

**Fix:** Check the chosen plural form in the PO file.

### PO_READ_ERROR

Severity: error.

The PO input could not be read as UTF-8.

**Fix:** Save the file as UTF-8, and check its path.

### PO_STALE_SOURCE

Severity: error.

The source message changed after this PO entry was exported, so the translation may no longer match.

**Fix:** Export current source text, review the translation, then import again.

### PO_UNKNOWN_ID

Severity: error.

The PO entry names a message ID that is absent from the base catalog.

**Fix:** Remove the entry, or mark it obsolete.

### PO_UNREPRESENTABLE_TEXT

Severity: error.

The text contains NUL, EOT or unpaired UTF-16 surrogates, which the PO transport cannot carry.

**Fix:** Remove those characters, or use valid Unicode text.

### PO_UNTRANSLATED_SKIPPED

Severity: warning.

An untranslated entry was skipped during migration.

**Fix:** Translate the entry before migrating it.

### PO_VERSION

Severity: error.

The PO transport version is not supported by this release.

**Fix:** Re-export the file with this version of nordbeam-locale.

### QUOTED_RUN_APOSTROPHE

Severity: warning.

Quoted text in a message holds `''` right before ICU syntax, as in `'<br/>''<br/>'`. ICU reads that as one quoted run with an apostrophe in it, so the page shows `<br/>'<br/>`. It usually comes from quoting two pieces of syntax, such as HTML tags, one by one and putting them side by side. `doctor` reports it. An apostrophe followed by text, as in `'{name}''s'`, is not reported.

**Fix:** Quote adjacent syntax as one run, '{a}{b}' rather than '{a}''{b}', or end the quote before an apostrophe that should show.

### READ_ONLY_FILE

Severity: warning.

The source file is read-only, so its rewrites were not applied.

**Fix:** Make the file writable, then run codemod again.

### RENAME_DYNAMIC_REFERENCE

Severity: warning.

A dynamic key may refer to the message being renamed, and rename cannot rewrite it.

**Fix:** Update that dynamic reference by hand, then run check.

### RICH_MESSAGE

Severity: warning.

The message uses rich-text markup that codemod does not convert.

**Fix:** Migrate the rich-text call by hand using Nordbeam slots.

### SLOT_MISMATCH

Severity: error.

An argument is a rich-text slot in one message and a plain value in another.

**Fix:** Use the same kind, a value or a slot, in every locale.

### SOURCE_PARSE_ERROR

Severity: error.

A source file could not be parsed, so it was not rewritten.

**Fix:** Fix the syntax error in that file, then run codemod again.

### SVELTE_I18N_SETUP

Severity: warning.

svelte-i18n initialization, dictionary registration and locale switching are application code the migration does not rewrite.

**Fix:** Connect the Nordbeam loader and locale switching in the Svelte setup by hand.

### SVELTEKIT_HOOK

Severity: warning.

SvelteKit hooks and locale switching are application boundaries that the migration does not rewrite.

**Fix:** Set the locale in the SvelteKit hook by hand.

### TEXT_SCANNER_UNAVAILABLE

Severity: error.

The text scanner needs oxc-parser, an optional dependency that is not installed for this platform, so source files could not be parsed.

**Fix:** Install it with npm install --save-dev oxc-parser, then retry.

### THENABLE_KEY

Severity: error.

A message ID is then, which would make the generated module look like a Promise to await.

**Fix:** Rename the message ID, for example to then.label.

### TRANSLOCO_PROVIDER

Severity: warning.

Transloco providers, modules and loaders are Angular dependency-injection code that the migration does not rewrite.

**Fix:** Configure the Nordbeam loader in place of the Transloco providers by hand.

### TRANSLOCO_TEMPLATE

Severity: warning.

Transloco pipes and directives in templates need an explicit template migration.

**Fix:** Replace the transloco pipe or directive in each template by hand.

### TYPESAFE_I18N_ADAPTER

Severity: warning.

The typesafe-i18n adapter and context setup are framework-owned and are not rewritten.

**Fix:** Replace the adapter with the Nordbeam integration for your framework.

### TYPESAFE_I18N_LOADER

Severity: warning.

typesafe-i18n dictionary and formatter loading must be connected to the Nordbeam loader manually.

**Fix:** Connect the Nordbeam loader where the dictionary was loaded.

### UNEXPECTED_SLOT

Severity: error.

A translation introduces a rich-text slot that the base message does not have.

**Fix:** Remove the slot tag from the translation, or add it to the base message.

### UNKNOWN_ARGUMENT

Severity: error.

A translation uses an argument that the base message does not declare.

**Fix:** Remove the argument from the translation, or use it in the base message. When the call passes it and only the base text leaves it out, declare it for the message under "arguments" in the config.

### UNKNOWN_INTL_LOCALE

Severity: error.

intlLocales maps a locale that has no catalog, so the entry has no effect. A misspelled locale here leaves the intended one formatting as another language.

**Fix:** Correct the locale so it names a catalog file, or remove the entry.

### UNKNOWN_MESSAGE

Severity: error.

A selected or referenced message ID does not exist in the base catalog.

**Fix:** Add the message to the base catalog, or correct the ID.

### UNKNOWN_MESSAGE_ID

Severity: error.

A source call or command references a message ID that the catalog does not define.

**Fix:** Add the ID to the base catalog with extract, or correct the reference.

### UNKNOWN_NOTE

Severity: warning.

A note describes a message ID that is not in the base catalog, usually after a rename or a removal.

**Fix:** Move the note to the message's new ID, or delete it.

### GENERATED_MODIFIED

Severity: error.

verify found generated files that were edited by hand. Their content differs from the last generation, so the next generation would overwrite the edit.

**Fix:** Move the change into a catalog or the configuration, restore the generated file by running nordbeam-locale, then run verify again.

### GENERATED_STALE

Severity: error.

verify found generated output that is missing or was built from older catalogs or options. An input changed since the last generation, or the output has not been generated yet.

**Fix:** Run nordbeam-locale to regenerate the output, then run verify again.

### UNKNOWN_PLURAL_BRANCH

Severity: error.

A translation adds a plural branch that the base message does not define.

**Fix:** Remove the branch, or add it to the base message if every locale needs it.

### UNKNOWN_SELECT_BRANCH

Severity: error.

A translation adds a select branch that the base message does not define.

**Fix:** Remove the branch, or add it to the base message if every locale needs it.

### UNSUPPORTED_NAMESPACE_SYNTAX

Severity: warning.

The namespace separator syntax of this call is not supported.

**Fix:** Migrate that call by hand.

### UNSUPPORTED_OPTIONS

Severity: warning.

The call passes options that codemod cannot translate.

**Fix:** Migrate the options by hand.

### UNUSED_MESSAGE

Severity: warning.

A base-catalog message is not referenced by any statically recognizable source call. Dynamic keys can make this a false positive.

**Fix:** Delete the message if it is unused. Keep it if it is referenced dynamically.

### VUE_ATTRIBUTE_TRANSLATION

Severity: warning.

A translation helper is used in an attribute binding, and the template codemod does not rewrite attribute values.

**Fix:** Migrate that attribute binding by hand.

### VUE_GLOBAL_TRANSLATOR

Severity: warning.

A Vue template uses the global vue-i18n translator, which the generated messages object does not replace.

**Fix:** Migrate that template call by hand.

### VUE_I18N_COMPONENT

Severity: warning.

The vue-i18n <i18n-t> component renders through the runtime and is not rewritten.

**Fix:** Replace it with a call to the generated messages.

### VUE_I18N_PLUGIN

Severity: warning.

The vue-i18n createI18n and app.use bootstrap must be replaced by hand with createVueI18n from @nordbeam/locale/vue.

**Fix:** Replace the vue-i18n plugin setup with createVueI18n from @nordbeam/locale/vue and app.use(i18n).

### VUE_I18N_PIPE_PLURAL

Severity: warning.

A vue-i18n pipe plural was converted to an ICU plural on {count} (or {n} when the message uses it).

**Fix:** Pass the number as the count argument at call sites; vue-i18n supplied it implicitly.

### VUE_I18N_LIST_INTERPOLATION

Severity: warning.

vue-i18n list placeholders such as {0} were converted to named arguments such as {arg0}.

**Fix:** Pass an object such as { arg0: value } at call sites, or rename the arguments.

### VUE_I18N_LINK_INLINED

Severity: warning.

A vue-i18n linked message (@:key) was replaced by the text of the message it references.

**Fix:** Edit both copies when the linked message changes, or compose the messages in code.

### VUE_I18N_UNSUPPORTED_SYNTAX

Severity: warning.

A vue-i18n message uses syntax with no faithful ICU conversion (custom link modifiers, modifiers on messages with arguments, nested or cyclic links, links to plurals, computed link keys, more than three pipe forms, %{name}), so it was not migrated.

**Fix:** Write the message by hand in the migrated catalog, then run check.

### VUE_NUXT_PLUGIN

Severity: warning.

The Nuxt vue-i18n plugin and bootstrap integration are framework-owned and remain a manual action.

**Fix:** Replace the Nuxt plugin with the Nordbeam integration by hand.

### VUE_TEMPLATE_API

Severity: warning.

Vue template helpers such as $t, $tc, $d and $n are outside the TypeScript call codemod.

**Fix:** Migrate those template calls explicitly.
