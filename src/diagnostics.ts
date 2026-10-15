export interface Diagnostic {
  code: string;
  message: string;
  locale?: string;
  messageId?: string;
  /** Location within the ICU message, not the containing JSON file. */
  line?: number;
  column?: number;
  /** UTF-16 offset within the decoded ICU message. */
  offset?: number;
  source?: string;
  /** Original parser reason, when the diagnostic describes invalid ICU. */
  reason?: string;
  hint?: string;
  /** Absolute source path, available for file-based operations. */
  file?: string;
  /** Position in the source file: one-based line/column, zero-based UTF-16 offset. */
  location?: { line: number; column: number; offset: number };
  frame?: string;
}

export class CompileError extends Error {
  readonly diagnostics: readonly Diagnostic[];

  constructor(diagnostics: Diagnostic[]) {
    super(diagnostics.map(diagnostic => formatDiagnostic(diagnostic)).join('\n\n'));
    this.name = 'CompileError';
    this.diagnostics = diagnostics;
  }
}

export function formatDiagnostic(d: Diagnostic): string { return renderDiagnostic(d, true); }

/** Internal bundler view: its overlay renders the frame separately. */
export function diagnosticSummary(d: Diagnostic): string { return renderDiagnostic(d, false); }

function renderDiagnostic(d: Diagnostic, includeFrame: boolean): string {
  const context = [d.locale, d.messageId].filter(x => x !== undefined).join(':');
  const location = d.line ? ` (message ${d.line}:${d.column ?? 1})` : '';
  const file = d.file ? `${d.file}${d.location ? `:${d.location.line}:${d.location.column}` : ''}\n` : '';
  const heading = `${file}[${d.code}] ${context ? `${context}${d.file ? '' : location}: ` : ''}${d.message}`;
  const hint = d.hint ? `\nHint: ${d.hint}` : '';
  if (!includeFrame) return heading + hint;
  if (d.frame) return `${heading}\n${d.frame}${hint}`;
  if (!d.source || !d.line) return heading + hint;
  const line = d.source.split('\n')[d.line - 1] ?? '';
  return `${heading}\n  ${line}\n  ${' '.repeat(Math.max(0, (d.column ?? 1) - 1))}^${hint}`;
}

const icuHints: Record<string, [string, string?]> = {
  EXPECT_ARGUMENT_CLOSING_BRACE: ['An ICU argument is missing its closing brace.', 'Close the argument with }. To display a literal brace, quote it with ICU apostrophes.'],
  EMPTY_ARGUMENT: ['An ICU argument has no name.', 'Use a named argument such as {name}.'],
  MALFORMED_ARGUMENT: ['An ICU argument is malformed.', 'Use {name} or {name, type, style}.'],
  EXPECT_ARGUMENT_TYPE: ['An argument type is missing after the comma.', 'Use number, date, time, select, plural or selectordinal.'],
  INVALID_ARGUMENT_TYPE: ['The argument type is not supported.', 'Use number, date, time, select, plural or selectordinal.'],
  EXPECT_ARGUMENT_STYLE: ['An argument style is missing after the comma.'],
  INVALID_NUMBER_SKELETON: ['The number skeleton is invalid.'],
  INVALID_DATE_TIME_SKELETON: ['The date/time skeleton is invalid.'],
  EXPECT_NUMBER_SKELETON: ['A number skeleton is missing after ::.'],
  EXPECT_DATE_TIME_SKELETON: ['A date/time skeleton is missing after ::.'],
  UNCLOSED_QUOTE_IN_ARGUMENT_STYLE: ['An apostrophe quote in the argument style is not closed.'],
  EXPECT_SELECT_ARGUMENT_OPTIONS: ['The select argument needs options.', 'Add branches such as yes {Yes} other {No}.'],
  EXPECT_PLURAL_ARGUMENT_OFFSET_VALUE: ['The plural offset needs a numeric value.'],
  INVALID_PLURAL_ARGUMENT_OFFSET_VALUE: ['The plural offset is not a valid integer.'],
  EXPECT_SELECT_ARGUMENT_SELECTOR: ['The select argument needs a branch name.'],
  EXPECT_PLURAL_ARGUMENT_SELECTOR: ['The plural argument needs a selector.', 'Use a category such as one or other, or an exact match such as =0.'],
  EXPECT_SELECT_ARGUMENT_SELECTOR_FRAGMENT: ['The select branch needs a message in braces.'],
  EXPECT_PLURAL_ARGUMENT_SELECTOR_FRAGMENT: ['The plural branch needs a message in braces.'],
  INVALID_PLURAL_ARGUMENT_SELECTOR: ['The exact plural selector is invalid.', 'Use an integer after =, such as =0.'],
  DUPLICATE_PLURAL_ARGUMENT_SELECTOR: ['A plural selector appears more than once.', 'Give each branch a distinct selector.'],
  DUPLICATE_SELECT_ARGUMENT_SELECTOR: ['A select branch name appears more than once.', 'Give each branch a distinct name.'],
  MISSING_OTHER_CLAUSE: ['A plural or select argument is missing its other branch.', 'Add other {…} to handle values without a matching branch.'],
  INVALID_TAG: ['A rich-text tag is malformed.', 'Use paired named tags such as <strong>text</strong>. Put HTML attributes and props in the application callback.'],
  INVALID_TAG_NAME: ['The rich-text tag name is invalid.', 'Use a named slot such as <strong>text</strong>.'],
  UNMATCHED_CLOSING_TAG: ['A closing rich-text tag does not match its opening tag.'],
  UNCLOSED_TAG: ['A rich-text tag is not closed.', 'Add a matching closing tag, such as </strong> for <strong>.'],
};

export function describeIcuError(reason: string): Pick<Diagnostic, 'message' | 'reason' | 'hint'> {
  const description = icuHints[reason];
  return { reason, message: description?.[0] ?? reason, ...(description?.[1] ? { hint: description[1] } : {}) };
}
