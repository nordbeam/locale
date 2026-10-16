/** Stable process exit statuses. Scripts may branch on these; the JSON `code` is the finer-grained contract. */
export const exitCodes = {
  success: 0,
  validation: 1,
  usage: 2,
  inputNotFound: 3,
  refused: 4,
  internal: 70,
} as const;

export interface ErrorCodeEntry {
  code: string;
  severity: 'error' | 'warning';
  explanation: string;
  /** One actionable sentence. Diagnostics with their own hint show that hint here. */
  fix: string;
  /** Repository-relative docs file and anchor for this code. */
  docs: string;
  /** Set only for codes that end a command with a specific exit status. */
  exitCode?: number;
}

/** A failure the CLI reports with a code, exit status, and structured details such as option, path, or validValues. */
export class CliError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = errorCodes[code]?.exitCode ?? exitCodes.validation;
    this.details = details;
  }
}

export function usageError(message: string, details: Record<string, unknown> = {}): CliError {
  return new CliError('USAGE', message, details);
}

const warningCodes = new Set([
  'EMPTY_SCOPE_PATTERN', 'SCOPE_DYNAMIC_ACCESS', 'UNKNOWN_NOTE', 'MISSING_MESSAGE', 'FALLBACK_MESSAGE', 'MISSING_PLURAL_CATEGORY', 'DROPPED_RICH_TAG', 'IGNORED_CATALOG_FILE',
  'CONFIG_DEVELOPMENT_IGNORED', 'SELECTION_FALLBACK', 'MISSING_MESSAGES_BINDING', 'RENAME_DYNAMIC_REFERENCE', 'UNUSED_MESSAGE', 'HARDCODED_TEXT', 'QUOTED_RUN_APOSTROPHE',
  'DOTTED_SOURCE_ID', 'LINGUI_COMPILED_ENTRY', 'I18NEXT_CONTEXT', 'I18NEXT_FORMATTER', 'I18NEXT_NESTING', 'I18NEXT_TRANS_INDEX',
  'MIGRATION_INTERPOLATION_REVIEW', 'MIGRATION_LITERAL_BRACE', 'MIGRATION_LOCALE_REQUIRED', 'MIGRATION_MESSAGE_FIELD', 'MIGRATION_METADATA_DROPPED',
  'MIGRATION_ORDINAL_ID', 'MIGRATION_PRINTF_PLACEHOLDER', 'MIGRATION_UNESCAPED_INTERPOLATION', 'MIGRATION_UNPAIRED_PLURAL',
  'PO_FUZZY_SKIPPED', 'PO_PLURAL_FORMS_INVALID', 'PO_PLURAL_FORMS_MISSING', 'PO_PLURAL_MAPPING', 'PO_UNTRANSLATED_SKIPPED',
  'MANUAL_REVIEW', 'READ_ONLY_FILE', 'UNSUPPORTED_NAMESPACE_SYNTAX', 'UNSUPPORTED_OPTIONS', 'VUE_GLOBAL_TRANSLATOR', 'VUE_ATTRIBUTE_TRANSLATION',
  'VUE_I18N_COMPONENT', 'DYNAMIC_MESSAGE_KEY', 'DYNAMIC_TEMPLATE_KEY', 'AMBIGUOUS_BINDING', 'INCUMBENT_RUNTIME_IMPORT', 'MESSAGE_ID_UNRESOLVED',
  'NESTED_TRANSLATION_CALL', 'RICH_MESSAGE', 'ANGULAR_BOOTSTRAP', 'NGX_TRANSLATE_PROVIDER', 'NGX_TRANSLATE_TEMPLATE', 'SVELTE_I18N_SETUP',
  'SVELTEKIT_HOOK', 'TRANSLOCO_PROVIDER', 'TRANSLOCO_TEMPLATE', 'TYPESAFE_I18N_ADAPTER', 'TYPESAFE_I18N_LOADER', 'VUE_I18N_PLUGIN',
  'VUE_NUXT_PLUGIN', 'VUE_TEMPLATE_API',
  'VUE_I18N_UNSUPPORTED_SYNTAX',
  'VUE_I18N_LINK_INLINED',
  'VUE_I18N_LIST_INTERPOLATION',
  'VUE_I18N_PIPE_PLURAL',
  'I18NEXT_UNSUPPORTED_MARKUP',
  'I18NEXT_RICH_TEXT',
  'LINGUI_PO_QUOTES', 'LINGUI_OBSOLETE_INCLUDED', 'LINGUI_WHITESPACE_TRIMMED', 'LINGUI_SOURCE_ID_TEXT', 'MIGRATION_TEXT_CHANGED', 'MIGRATION_ID_RENAMED',
]);

// [explanation, fix, exit status when the code ends a command]
const definitions: Record<string, [explanation: string, fix: string, exitCode?: number]> = {
  USAGE: ['The command line is invalid: an unknown command or option, a missing required option, conflicting options, or a value outside the accepted set. Nothing was read or written.', 'Run nordbeam-locale help <command> for the accepted options, or capabilities --json for the complete contract, then retry.', 2],
  UNKNOWN_FORMAT: ['A format name is not supported. For --format and --catalog-format, validValues lists the accepted names. The compiler also uses this code for an ICU number, date or time style that is not declared under formats.', 'Use one of validValues, or declare the ICU style under formats in the configuration.', 2],
  FILE_NOT_FOUND: ['A file or directory that the command reads does not exist. details.path is project-relative when the path is inside the project.', 'Check the path, or pass the correct --config, --catalogs or --from value. Run nordbeam-locale init to create a starter project.', 3],
  FILE_EXISTS: ['The command would overwrite an existing file, so it refused. Nothing was changed.', 'Choose a new output path, or review and remove the existing file yourself.', 4],
  COMMAND_FAILED: ['The command stopped on a condition that its message describes, such as overlapping directories or an unsupported migration source. Nothing was written.', 'Correct the input or configuration the message names, then retry.', 1],
  CONFIG_EXISTS: ['init found a configuration file and refuses to replace it.', 'Edit the existing configuration file, then run nordbeam-locale without init.', 4],
  VALIDATION_FAILED: ['A command finished and found validation errors that have no more specific code.', 'Read errors[] in the JSON output, fix each reported diagnostic, then run nordbeam-locale check --json.', 1],
  INTERNAL_ERROR: ['An unexpected exception, such as a TypeError, escaped the command. The inputs may be valid, so this indicates a defect or an unhandled case in the tool.', 'Re-run with --json or --ndjson to capture the message, then report the full command and its output.', 70],
  APPLY_FAILED: ['apply-plan could not write every target. Every change it had made was rolled back, so the project is unchanged.', 'Check the reported path and its permissions, then regenerate the plan and apply it again.', 4],
  INVALID_PLAN: ['The plan file is not a valid reviewed plan: its schema, protocol version or plan hash does not match its contents.', 'Regenerate the plan with codemod --plan <new-file> --json. Do not edit plan files by hand.', 1],
  INVALID_TARGET: ['A plan lists a target path that is outside its allow-list or is not a valid project-relative path.', 'Regenerate the plan from the current project; do not edit plan files by hand.', 1],
  ROOT_MISMATCH: ['The plan was created for a different project root than the one apply-plan runs in.', 'Run apply-plan from the project root the plan was created in, or regenerate the plan here.', 4],
  STALE_PLAN: ['A target changed after the plan was created, so applying it could overwrite newer work. No target was written.', 'Review the current source, regenerate the plan with codemod --plan, then apply the new plan.', 4],
  MISSING_TARGET: ['A target that the plan changes no longer exists.', 'Regenerate the plan from the current project state.', 4],
  UNEXPECTED_TARGET: ['A target that the plan expects to be absent now exists.', 'Regenerate the plan from the current project state.', 4],
  TARGET_NOT_FILE: ['A planned target is a directory, a symbolic link or another non-file entry.', 'Remove the non-file entry or exclude it from the scan, then regenerate the plan.', 4],
  UNRESOLVED_MIGRATION_CONSTRUCT: ['codemod --strict stopped because a source construct cannot be rewritten safely. Nothing was written.', 'Migrate the reported call by hand, or drop --strict to write the rewritable calls and review the skipped list.', 4],
  MIGRATE_PACKAGE_MISSING: ['A migration command (codemod, migrate or migrate-project) needs @nordbeam/locale-migrate, which is not installed. Nothing was read or written.', 'Install the migration package at the same version as nordbeam-locale: npm install --save-dev @nordbeam/locale-migrate@<nordbeam-locale version>, then retry.', 3],
  MIGRATE_PACKAGE_VERSION: ['The installed @nordbeam/locale-migrate version differs from the installed nordbeam-locale version. The two must match exactly, so the command stopped before reading or writing.', 'Install the matching version: npm install --save-dev @nordbeam/locale-migrate@<nordbeam-locale version>.', 1],
  MESSAGE_ALREADY_EXISTS: ['rename or extract would add a message ID that the base catalog already defines, so it refused.', 'Choose a new message ID, or edit the existing message in the base catalog.', 4],
  PSEUDO_TARGET_EXISTS: ['The pseudo-locale catalog already exists and pseudo refuses to replace it.', 'Pass --update to replace it, or choose a different locale.', 4],
  MIGRATION_PRINTF_PLACEHOLDER: ['A printf placeholder was converted to an ICU argument.', 'The plural selector supplies the count; check the converted text.'],
  MIGRATION_OUTPUT_EXISTS: ['The migration output path already exists, so migrate refused to overwrite it.', 'Choose a new --out path, or review and remove the existing file.', 4],
  INVALID_ICU: ['An ICU MessageFormat message is syntactically invalid and cannot be compiled. The reason field gives the parser code.', 'Correct the ICU syntax at the reported location. Use {name} placeholders and quote literal braces with apostrophes.'],
  INVALID_JSON: ['A catalog file is not valid JSON, so its messages cannot be read.', 'Fix the JSON syntax at the reported location. A catalog must be a single JSON object.'],
  INVALID_CATALOG: ['A catalog has a structure the compiler cannot read, such as a root that is not an object.', 'Make the catalog root a JSON object whose leaves are message strings.'],
  INVALID_CONFIG: ['The configuration file is unreadable, is not valid JSON, or contains a value that is not allowed.', 'Fix the reported field in the configuration file. nordbeam-locale schema writes an editor schema that flags these values as you type.'],
  INVALID_DECLARED_ARGUMENT: ['The arguments option declares an argument with a name that is not an identifier or a kind other than value, number or date.', 'Declare each argument as "value" (a plain {name}), "number" or "date".'],
  INVALID_KEY: ['A message key is empty or otherwise cannot be a message ID.', 'Give the message a non-empty dotted ID, such as checkout.pay.'],
  INVALID_MESSAGE_ID: ['A message ID is empty, starts or ends with a dot, or has an empty segment.', 'Use a non-empty dotted ID such as checkout.pay.'],
  INVALID_LOCALE: ['A locale is not a canonical BCP 47 tag, so it cannot name a catalog.', 'Use a canonical tag such as en, fr or pt-BR.'],
  INVALID_INTL_LOCALE: ['An intlLocales value is not a canonical BCP 47 tag, so Intl cannot format the locale with it. The locale is not compiled.', 'Map the locale to a canonical tag such as sv, nb or pt-BR.'],
  UNKNOWN_INTL_LOCALE: ['intlLocales maps a locale that has no catalog, so the entry has no effect. A misspelled locale here leaves the intended one formatting as another language.', 'Correct the locale so it names a catalog file, or remove the entry.'],
  INVALID_SCOPE: ['A scope name in the configuration is not a valid identifier.', 'Start the scope name with a letter, then use only letters, digits, underscores or hyphens.'],
  INVALID_SELECTION: ['A requested loader or locale is not part of the generated project.', 'Use a locale that has a catalog, or add the catalog and regenerate.'],
  INVALID_FORMAT: ['An ICU number, date or time pattern or skeleton was rejected by Intl.', 'Correct the pattern or skeleton named in the message.'],
  EMPTY_SCOPE: ['The modules of a scope name no message IDs, so its loader would hold no messages.', 'List the files that render the scope\'s messages in its modules, or add the messages to the scope.'],
  SCOPE_DYNAMIC_ACCESS: ['A file that a computed scope reads indexes the messages object with a computed key, such as m[key]() or m.status[state](). The crawl cannot tell which message that is, so the scope may lack it, and a page that reads a message its scope lacks fails at run time. Tests that render the full catalog do not notice.', "Read the message with a literal key or a template such as m[`status.${state}`](), keep a map of message functions such as { open: m.status.open }[state], or add its IDs or a prefix.* pattern to the scope's messages. A nordbeam-locale-ignore comment on the line keeps a reviewed read quiet."],
  SCOPE_MODULE_NOT_FOUND: ['A module pattern of a scope matches no files, so the scope cannot be computed.', 'Correct the pattern, relative to the project root, or remove it.'],
  EMPTY_SCOPE_PATTERN: ['A configured scope pattern matches no messages, so the scope selects nothing.', 'Correct the pattern, or remove the scope if it is no longer needed.'],
  INVALID_NOTES: ['The notes file cannot be read, is not JSON shaped like a catalog, or sits in the catalog directory.', 'Keep the notes file outside the catalog directory, as a JSON object whose leaves are note strings.'],
  UNKNOWN_NOTE: ['A note describes a message ID that is not in the base catalog, usually after a rename or a removal.', 'Move the note to the message\'s new ID, or delete it.'],
  UNKNOWN_MESSAGE: ['A selected or referenced message ID does not exist in the base catalog.', 'Add the message to the base catalog, or correct the ID.'],
  UNKNOWN_MESSAGE_ID: ['A source call or command references a message ID that the catalog does not define.', 'Add the ID to the base catalog with extract, or correct the reference.'],
  GENERATED_STALE: ['verify found generated output that is missing or was built from older catalogs or options. An input changed since the last generation, or the output has not been generated yet.', 'Run nordbeam-locale to regenerate the output, then run verify again.'],
  GENERATED_MODIFIED: ['verify found generated files that were edited by hand. Their content differs from the last generation, so the next generation would overwrite the edit.', 'Move the change into a catalog or the configuration, restore the generated file by running nordbeam-locale, then run verify again.'],
  MESSAGE_NOT_FOUND: ['The message that rename or extract should change is not present in the base catalog.', 'Check the ID with nordbeam-locale inspect --id <id>, then retry with the correct ID.'],
  MISSING_MESSAGE: ['A locale lacks a message that the base locale defines, so the base text is used at runtime.', 'Translate the message in that locale, for example with nordbeam-locale import of a reviewed PO file.'],
  FALLBACK_MESSAGE: ['A message is served from the base locale because the requested locale does not provide it.', 'Translate the message in the requested locale, or accept the base text as the fallback.'],
  MISSING_PLURAL_CATEGORY: ['A translation lacks a plural category that its locale requires, so some counts fall back to other.', 'Add the missing category, such as one or other, to the translation.'],
  MISSING_PLURAL_BRANCH: ['A translation has no branch for a plural category that the base message defines.', 'Add the branch to the translation. Use other {...} as the fallback branch.'],
  UNKNOWN_PLURAL_BRANCH: ['A translation adds a plural branch that the base message does not define.', 'Remove the branch, or add it to the base message if every locale needs it.'],
  MISSING_SELECT_BRANCH: ['A translation lacks a select branch that the base message defines.', 'Add the missing branch to the translation.'],
  UNKNOWN_SELECT_BRANCH: ['A translation adds a select branch that the base message does not define.', 'Remove the branch, or add it to the base message if every locale needs it.'],
  MISSING_ARGUMENT: ['A translation drops an argument that the base message uses.', 'Add the argument placeholder back to the translation.'],
  UNKNOWN_ARGUMENT: ['A translation uses an argument that the base message does not declare.', 'Remove the argument from the translation, or use it in the base message. When the call passes it and only the base text leaves it out, declare it for the message under "arguments" in the config.'],
  UNEXPECTED_SLOT: ['A translation introduces a rich-text slot that the base message does not have.', 'Remove the slot tag from the translation, or add it to the base message.'],
  SLOT_MISMATCH: ['An argument is a rich-text slot in one message and a plain value in another.', 'Use the same kind, a value or a slot, in every locale.'],
  ARGUMENT_KIND_MISMATCH: ['An argument is a value in one message and a rich-text slot in another.', 'Use the same kind in every locale.'],
  ARGUMENT_TYPE_CONFLICT: ['One message uses the same argument name as both a rich-text slot and a value.', 'Rename one of the two uses.'],
  DROPPED_RICH_TAG: ['A translation drops a rich-text tag from the base message, so that text loses its markup.', 'Restore the tag pair in the translation.'],
  MESSAGE_TOO_DEEP: ['The message nests too deeply for the compiler to generate code for it.', 'Split the message into smaller messages and compose them in code.'],
  BASE_LOCALE_MISSING: ['The base locale has no catalog, so the other locales have nothing to fall back to.', 'Create the base catalog, or set baseLocale to a locale that has one.'],
  CATALOG_READ_ERROR: ['A catalog file could not be read.', 'Check that the file exists and is readable UTF-8 JSON.'],
  CATALOG_CHANGED: ['A catalog changed while the command was reading it, so the result could be inconsistent.', 'Run the command again once the edit has finished.'],
  CATALOG_LAYOUT_CONFLICT: ['Adding the message would replace a nested catalog object at the same path.', 'Convert that subtree to flat dotted keys, then retry.'],
  LOCALE_MISSING: ['No catalog exists for the requested locale.', 'Create the locale catalog, or pass a locale that has one.'],
  IGNORED_CATALOG_FILE: ['A file in the catalog directory is not a recognized catalog, so it is ignored.', 'Move the file out of the catalog directory, or rename it to a supported locale file name.'],
  CONFIG_DEVELOPMENT_IGNORED: ['The development setting in the configuration is ignored. Output mode comes from NODE_ENV or from the --development and --production flags.', 'Remove development from the configuration, and choose the mode with NODE_ENV or a flag.'],
  SELECTION_FALLBACK: ['The Vite integration could not select a locale for a module and used the fallback.', 'Set the selection expression or the initial locale so that every module resolves a locale.'],
  MISSING_MESSAGES_BINDING: ['A rewritten source file calls the generated messages object without binding it first.', 'Import or bind the messages object in that file, or pass --messages-import to codemod, with --messages-hook when that module exports a hook such as useMessages.'],
  RENAME_DYNAMIC_REFERENCE: ['A dynamic key may refer to the message being renamed, and rename cannot rewrite it.', 'Update that dynamic reference by hand, then run check.'],
  HARDCODED_TEXT: ['Source code renders UI text from a string literal instead of a catalog message, so every locale sees the same text. doctor reports a summary; hardcoded lists each string with its confidence.', 'Run nordbeam-locale hardcoded --fix to reuse catalog messages with the same text, --extract to add new ones, or mark text that is not UI copy with a nordbeam-locale-ignore comment.'],
  QUOTED_RUN_APOSTROPHE: ["Quoted text in a message holds '' right before ICU syntax, as in '{a}''{b}'. ICU reads that as one quoted run with an apostrophe in it, so it renders {a}'{b}. It usually comes from quoting two pieces of syntax, such as HTML tags, one by one and putting them side by side.", "Quote adjacent syntax as one run, '{a}{b}' rather than '{a}''{b}', or end the quote before an apostrophe that should show."],
  TEXT_SCANNER_UNAVAILABLE: ['The text scanner needs oxc-parser, an optional dependency that is not installed for this platform, so source files could not be parsed.', 'Install it with npm install --save-dev oxc-parser, then retry.'],
  UNUSED_MESSAGE: ['A base-catalog message is not referenced by any statically recognizable source call. Dynamic keys can make this a false positive.', 'Delete the message if it is unused. Keep it if it is referenced dynamically.'],
  DOCTOR_ERROR: ['doctor could not finish inspecting the project. The message says which step failed.', 'Fix the reported input, then run doctor again.'],
  DUPLICATE_KEY: ['A message key is defined more than once, so only the last value would be used.', 'Keep one definition of the key and delete the other.'],
  THENABLE_KEY: ['A message ID is then, which would make the generated module look like a Promise to await.', 'Rename the message ID, for example to then.label.'],
  PO_BASE_LOCALE: ['import targeted the base locale. The base locale is edited in its JSON catalog, not imported from PO.', 'Choose a target locale that differs from the base locale, and edit source messages in the base JSON catalog.'],
  PO_DUPLICATE_ID: ['The PO file contains the same message ID twice.', 'Keep one entry for each msgctxt.'],
  PO_ENCODING: ['The PO Content-Type does not declare text/plain with charset=UTF-8.', 'Save the file as UTF-8 and set Content-Type to text/plain; charset=UTF-8.'],
  PO_FUZZY_HEADER: ['The PO header is marked fuzzy, so the file cannot be trusted as reviewed.', 'Remove the fuzzy flag from the header, then import again.'],
  PO_FUZZY_SKIPPED: ['A fuzzy translation was skipped during migration because it has not been reviewed.', 'Review the translation and remove its fuzzy flag before migrating it.'],
  PO_GETTEXT_PLURAL: ['The entry uses gettext plural arrays, which cannot represent ICU plurals.', 'Keep ICU plural messages inside a single msgid and msgstr.'],
  PO_LOCALE_MISMATCH: ['The PO Language header does not match the requested locale.', 'Import the PO file for that locale, or correct its Language header.'],
  PO_MISSING_CONTEXT: ['A PO entry has no stable message ID in msgctxt, so it cannot be matched to a message.', 'Export a PO file with nordbeam-locale export, then translate that file.'],
  PO_MISSING_HEADER: ['The PO file has no header with Language and a UTF-8 Content-Type.', 'Add the header, or export a fresh PO file.'],
  PO_PLURAL_FORMS_INVALID: ['The plural forms cannot be mapped because the catalog language is missing or invalid.', 'Set a canonical Language header, such as pl or pt-BR.'],
  PO_PLURAL_FORMS_MISSING: ['The Plural-Forms header is missing, so plural messages keep only their one and other forms.', 'Add nplurals and plural to the Plural-Forms header.'],
  PO_PLURAL_MAPPING: ['A plural category maps to several msgstr forms, so one of them was chosen.', 'Check the chosen plural form in the PO file.'],
  PO_READ_ERROR: ['The PO input could not be read as UTF-8.', 'Save the file as UTF-8, and check its path.'],
  PO_STALE_SOURCE: ['The source message changed after this PO entry was exported, so the translation may no longer match.', 'Export current source text, review the translation, then import again.'],
  PO_UNKNOWN_ID: ['The PO entry names a message ID that is absent from the base catalog.', 'Remove the entry, or mark it obsolete.'],
  PO_UNREPRESENTABLE_TEXT: ['The text contains NUL, EOT or unpaired UTF-16 surrogates, which the PO transport cannot carry.', 'Remove those characters, or use valid Unicode text.'],
  PO_UNTRANSLATED_SKIPPED: ['An untranslated entry was skipped during migration.', 'Translate the entry before migrating it.'],
  PO_VERSION: ['The PO transport version is not supported by this release.', 'Re-export the file with this version of nordbeam-locale.'],
  INVALID_PO: ['The PO file is malformed and cannot be read safely.', 'Fix the reported PO syntax at the given line, or export a fresh PO file.'],
  MIGRATION_ID_COLLISION: ['Two input keys map to the same message ID, one nested and one flat.', 'Rename one of the keys so that every message ID is unique.'],
  MIGRATION_INTERPOLATION_REVIEW: ['An interpolation could not be converted completely.', 'Convert the reported interpolation by hand, then check the result.'],
  MIGRATION_INVALID_KEY: ['An input key is empty and cannot become a message ID.', 'Give the key a name in the source format, then retry.'],
  MIGRATION_LAYOUT_COLLISION: ['A migrated message would replace a catalog object or string at the same path.', 'Rename one of the keys so the two layouts do not overlap.'],
  MIGRATION_LITERAL_BRACE: ['Literal braces in the source text may change meaning in ICU.', 'Confirm the text is intended, and quote literal braces with apostrophes.'],
  MIGRATION_LOCALE_REQUIRED: ['A Tolgee export has no string for the selected locale.', 'Pass --locale for multi-locale Tolgee exports.'],
  MIGRATION_MESSAGE_FIELD: ['A non-standard message field was used instead of defaultMessage.', 'Confirm that the converted text is correct.'],
  MIGRATION_METADATA_DROPPED: ['ARB metadata was dropped because the target catalog format has no equivalent.', 'Keep a copy of the metadata if your tooling needs it.'],
  MIGRATION_ORDINAL_ID: ['i18next ordinal plurals were merged into one message.', 'Call the merged message with an ordinal selector.'],
  MIGRATION_READ_ERROR: ['The migration source could not be read.', 'Check the --from path and that the file is valid for its format.'],
  MIGRATION_UNESCAPED_INTERPOLATION: ['An unescaped interpolation was converted. The HTML escaping at the call site may differ.', 'Confirm the escaping at the call site.'],
  MIGRATION_UNPAIRED_PLURAL: ['A plural-like key had no matching variants, so it was kept unchanged.', 'Add the missing variants, or leave the key as it is.'],
  MIGRATION_UNSUPPORTED_DESCRIPTOR: ['A FormatJS descriptor has no string defaultMessage, so it cannot be migrated.', 'Add a string defaultMessage to the descriptor.'],
  MIGRATION_UNSUPPORTED_VALUE: ['A value is neither a string nor a nested object, so it cannot be migrated.', 'Convert the value to a string.'],
  DOTTED_SOURCE_ID: ['A message ID contains a dot and migrates as nested catalog keys.', 'Rename the ID if the nesting is unintended, or call it through the nested path.'],
  LINGUI_COMPILED_ENTRY: ['A compiled Lingui entry could not be converted, so it was not migrated.', 'Migrate the source catalog instead of the compiled output.'],
  LINGUI_PO_QUOTES: ['Lingui-written PO lines had unescaped interior quotes; they were read as Lingui reads them, as the text between the first and last quote.', 'Escape the quotes in the PO file if other gettext tools read it.'],
  LINGUI_OBSOLETE_INCLUDED: ['Obsolete (#~) PO entries were migrated, because Lingui 3 compiles and renders them.', 'Run nordbeam-locale prune after the source migration to find the ones no code uses.'],
  LINGUI_WHITESPACE_TRIMMED: ['Leading or trailing whitespace was trimmed from messages with arguments, as Lingui trims them when it renders.', 'Put intended spacing in the surrounding markup instead of the message.'],
  LINGUI_SOURCE_ID_TEXT: ['A source-locale message had no text, so its ID became its text, which is what Lingui rendered.', 'Write the text the message should show in the source locale.'],
  MIGRATION_TEXT_CHANGED: ['A converted message reads differently from its source once tags and arguments are normalized, for example a lost apostrophe or dropped text.', 'Compare the message with its source and correct the converted catalog.'],
  MIGRATION_ID_RENAMED: ['A message ID could not nest as written (a message that is also a namespace, or an empty or space-edged segment), so it was renamed.', 'Use the new ID. migrate-project rewrites the calls; after migrate alone, rename them in the source.'],
  I18NEXT_CONTEXT: ['i18next context variants were migrated as separate messages.', 'Use one message with a select on the context value.'],
  I18NEXT_FORMATTER: ['An i18next formatter was kept as a plain argument.', 'Format the value in code, or declare a Nordbeam formatter.'],
  I18NEXT_NESTING: ['An i18next $t() nesting reference was kept as literal text.', 'Inline the referenced message, or compose the two messages in code.'],
  I18NEXT_RICH_TEXT: ['Named markup tags in an i18next message were converted to ICU rich-text tags.', 'Render the message with rich() and pass one function per tag.'],
  I18NEXT_UNSUPPORTED_MARKUP: ['An i18next message has markup that cannot become a rich-text tag (self-closing, with attributes, or unbalanced), so it was not migrated.', 'Use paired tags such as <link>...</link> in the legacy catalog, or write the message by hand.'],
  I18NEXT_TRANS_INDEX: ['Trans index tags such as <0>...</0> were converted to named rich-text tags (<tag0>, <tag1>), because ICU tag names cannot be numbers.', 'Render the message with rich() and pass one function per tag (tag0, tag1, ...).'],
  ANGULAR_BOOTSTRAP: ['Angular bootstrap providers are framework-owned, so the migration does not rewrite them.', 'Wire the Nordbeam runtime into the Angular bootstrap by hand.'],
  NGX_TRANSLATE_PROVIDER: ['ngx-translate providers and loaders are Angular dependency-injection code that the migration does not rewrite.', 'Configure the Nordbeam loader in the Angular providers by hand.'],
  NGX_TRANSLATE_TEMPLATE: ['ngx-translate pipes and directives in templates need an explicit template migration.', 'Replace the translate pipe or directive in each template by hand.'],
  SVELTE_I18N_SETUP: ['svelte-i18n initialization, dictionary registration and locale switching are application code the migration does not rewrite.', 'Connect the Nordbeam loader and locale switching in the Svelte setup by hand.'],
  SVELTEKIT_HOOK: ['SvelteKit hooks and locale switching are application boundaries that the migration does not rewrite.', 'Set the locale in the SvelteKit hook by hand.'],
  TRANSLOCO_PROVIDER: ['Transloco providers, modules and loaders are Angular dependency-injection code that the migration does not rewrite.', 'Configure the Nordbeam loader in place of the Transloco providers by hand.'],
  TRANSLOCO_TEMPLATE: ['Transloco pipes and directives in templates need an explicit template migration.', 'Replace the transloco pipe or directive in each template by hand.'],
  TYPESAFE_I18N_ADAPTER: ['The typesafe-i18n adapter and context setup are framework-owned and are not rewritten.', 'Replace the adapter with the Nordbeam integration for your framework.'],
  TYPESAFE_I18N_LOADER: ['typesafe-i18n dictionary and formatter loading must be connected to the Nordbeam loader manually.', 'Connect the Nordbeam loader where the dictionary was loaded.'],
  VUE_I18N_PLUGIN: ['The vue-i18n createI18n and app.use bootstrap must be replaced by hand with createVueI18n from @nordbeam/locale/vue.', 'Replace the vue-i18n plugin setup with createVueI18n from @nordbeam/locale/vue and app.use(i18n).'],
  VUE_I18N_PIPE_PLURAL: ['A vue-i18n pipe plural was converted to an ICU plural on {count} (or {n} when the message uses it).', 'Pass the number as the count argument at call sites; vue-i18n supplied it implicitly.'],
  VUE_I18N_LIST_INTERPOLATION: ['vue-i18n list placeholders such as {0} were converted to named arguments such as {arg0}.', 'Pass an object such as { arg0: value } at call sites, or rename the arguments.'],
  VUE_I18N_LINK_INLINED: ['A vue-i18n linked message (@:key) was replaced by the text of the message it references.', 'Edit both copies when the linked message changes, or compose the messages in code.'],
  VUE_I18N_UNSUPPORTED_SYNTAX: ['A vue-i18n message uses syntax with no faithful ICU conversion (custom link modifiers, modifiers on messages with arguments, nested or cyclic links, links to plurals, computed link keys, more than three pipe forms, %{name}), so it was not migrated.', 'Write the message by hand in the migrated catalog, then run check.'],
  VUE_NUXT_PLUGIN: ['The Nuxt vue-i18n plugin and bootstrap integration are framework-owned and remain a manual action.', 'Replace the Nuxt plugin with the Nordbeam integration by hand.'],
  VUE_TEMPLATE_API: ['Vue template helpers such as $t, $tc, $d and $n are outside the TypeScript call codemod.', 'Migrate those template calls explicitly.'],
  AMBIGUOUS_BINDING: ['The translation function binding is ambiguous, so the call was not rewritten.', 'Bind one translation function per scope, or migrate the call by hand.'],
  DYNAMIC_MESSAGE_KEY: ['The message key is computed at runtime, so its ID cannot be known statically.', 'Use a literal key, or migrate the call by hand.'],
  DYNAMIC_TEMPLATE_KEY: ['The template-literal key is dynamic, so its message ID cannot be known statically.', 'Use a literal key, or migrate the call by hand.'],
  INCUMBENT_RUNTIME_IMPORT: ['The file still imports the previous i18n runtime.', 'Remove the old runtime import after its calls are migrated.'],
  MANUAL_REVIEW: ['A construct was skipped and needs human review.', 'Migrate the reported call by hand, then run check.'],
  MESSAGE_ID_UNRESOLVED: ['The message ID of a call could not be resolved from the source.', 'Pass a literal key, or map the source file with --message-id-map.'],
  NESTED_TRANSLATION_CALL: ['A translation call is nested inside another call that the rewriter cannot handle.', 'Move the inner call into a variable, then migrate it by hand.'],
  READ_ONLY_FILE: ['The source file is read-only, so its rewrites were not applied.', 'Make the file writable, then run codemod again.'],
  RICH_MESSAGE: ['The message uses rich-text markup that codemod does not convert.', 'Migrate the rich-text call by hand using Nordbeam slots.'],
  SOURCE_PARSE_ERROR: ['A source file could not be parsed, so it was not rewritten.', 'Fix the syntax error in that file, then run codemod again.'],
  UNSUPPORTED_NAMESPACE_SYNTAX: ['The namespace separator syntax of this call is not supported.', 'Migrate that call by hand.'],
  UNSUPPORTED_OPTIONS: ['The call passes options that codemod cannot translate.', 'Migrate the options by hand.'],
  VUE_GLOBAL_TRANSLATOR: ['A Vue template uses the global vue-i18n translator, which the generated messages object does not replace.', 'Migrate that template call by hand.'],
  VUE_ATTRIBUTE_TRANSLATION: ['A translation helper is used in an attribute binding, and the template codemod does not rewrite attribute values.', 'Migrate that attribute binding by hand.'],
  VUE_I18N_COMPONENT: ['The vue-i18n <i18n-t> component renders through the runtime and is not rewritten.', 'Replace it with a call to the generated messages.'],
};

/** Every diagnostic and error code the package emits, keyed by code. docs/reference/errors.md documents each entry. */
export const errorCodes: Readonly<Record<string, ErrorCodeEntry>> = Object.fromEntries(
  Object.entries(definitions).map(([code, [explanation, fix, exitCode]]) => [code, {
    code,
    severity: warningCodes.has(code) ? 'warning' : 'error',
    explanation,
    fix,
    docs: `docs/reference/errors.md#${code.toLowerCase()}`,
    ...(exitCode === undefined ? {} : { exitCode }),
  } satisfies ErrorCodeEntry]),
);

export function errorCodeEntry(code: string): ErrorCodeEntry | undefined {
  return Object.hasOwn(errorCodes, code) ? errorCodes[code] : undefined;
}
