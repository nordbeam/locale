import { access, chmod, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse, parseExpression } from '@babel/parser';
import { discoverConfig } from 'nordbeam-locale/internal/migrate';
import { createPlan } from 'nordbeam-locale/internal/migrate';
import type { FilePlan } from 'nordbeam-locale/internal/migrate';

export type CodemodFormat = 'auto' | 'i18next' | 'next-intl' | 'formatjs' | 'lingui'
  | 'vue-i18n' | 'tolgee' | 'next-international' | 'typesafe-i18n'
  | 'svelte-i18n' | 'transloco' | 'ngx-translate' | 'react-i18next'
  | 'next-i18next' | 'react-intl' | 'lingui-react' | 'tolgee-react' | 'nuxt-i18n';

export interface CodemodChange { readonly file: string; readonly replacements: number; readonly typeImportsMoved: number }
export interface CodemodSkip {
  readonly file?: string;
  readonly callee: string;
  readonly reason: string;
  /** Character offset in the text the codemod was given; kept for compatibility. */
  readonly offset?: number;
  /** 1-based line and column of `offset`, for reports that point at source. */
  readonly line?: number;
  readonly column?: number;
  /** Stable machine-readable category for migration tooling. */
  readonly code?: string;
  /** Concrete next action for constructs that cannot be changed safely. */
  readonly action?: string;
}
export interface CodemodResult {
  readonly format: CodemodFormat;
  readonly sourceDir: string;
  readonly dryRun: boolean;
  readonly filesScanned: number;
  readonly replacements: number;
  readonly typeImportsMoved: number;
  readonly changed: readonly CodemodChange[];
  readonly skipped: readonly CodemodSkip[];
  /** Static calls that were safely lowered and the calls that still require a
   * legacy compatibility boundary. The fallback is intentionally metadata;
   * adapters decide how to lazy-load their legacy lookup/runtime. */
  readonly compatibility: CodemodCompatibilityPlan;
  /** Rewrites that were applied but need follow-up, such as a messages object the file does not bind yet. */
  readonly warnings?: readonly CodemodSkip[];
  /** Present only when requested for later stale-safe application. */
  readonly plan?: FilePlan;
}

/** Thrown only when a caller opts into fail-closed migration. The complete
 * diagnostic list is retained so CLIs and integrations can print the same
 * actionable report that a preview would have produced. */
export class CodemodStrictError extends Error {
  readonly diagnostics: readonly CodemodSkip[];
  constructor(diagnostics: readonly CodemodSkip[]) {
    const first = diagnostics[0];
    super(`Strict codemod refused to apply ${diagnostics.length} unresolved translation construct(s)${first ? `; first: ${first.file ?? '<source>'}:${first.line ?? first.offset ?? 0}${first.column ? `:${first.column}` : ''} ${first.callee} — ${first.reason}` : ''}`);
    this.name = 'CodemodStrictError';
    this.diagnostics = diagnostics;
  }
}

export interface CodemodCompatibilityPlan {
  readonly directRewrites: number;
  readonly fallbackRequired: boolean;
  readonly fallbackStrategy: 'none' | 'lazy-legacy-boundary';
  readonly fallbackCalls: readonly CodemodSkip[];
  /** Project-level audits fill this with only files containing unresolved
   * calls, so a lazy adapter need not be loaded by every migrated module. */
  readonly fallbackFiles: readonly string[];
  /** A file-scoped plan for adapters that can split the compatibility
   * boundary. Files omitted here have not been scanned; files present with
   * fallbackRequired=false need no legacy runtime import. */
  readonly files: readonly CodemodCompatibilityFile[];
}

export interface CodemodCompatibilityFile {
  readonly file: string;
  readonly directRewrites: number;
  readonly fallbackRequired: boolean;
  readonly fallbackCalls: readonly CodemodSkip[];
}

type Replacement = { start: number; end: number; text: string; rich?: boolean };
type Binding = { callee: string; namespace?: string; namespaceDynamic?: boolean; ambiguous?: boolean; provenance?: 'native' | 'custom'; kind: 'message' | 'descriptor' | 'direct' };
type AstNode = { type?: string; start?: number; end?: number; [key: string]: unknown };
type CleanupScope = { parent?: CleanupScope; bindings: Map<string, CleanupBinding>; node: AstNode };
type CleanupBinding = { name: string; scope: CleanupScope; declaration: AstNode; identifier: AstNode; references: AstNode[]; candidate?: 'local' | 'property' | 'import'; property?: AstNode; declarationNode?: AstNode; importSpecifier?: AstNode; importDeclaration?: AstNode; unsafe?: boolean };
export interface CustomTranslationCall {
  readonly callee: string;
  readonly namespace?: string;
  /** A caller may know that the namespace/key prefix was not statically
   * recoverable. Keeping this bit of proof with the custom binding prevents a
   * later merge from accidentally turning a dynamic helper into a static one. */
  readonly namespaceDynamic?: boolean;
  readonly kind?: 'message' | 'descriptor';
}
export interface CodemodSourceOptions {
  readonly messagesObject?: string;
  /** Optional module specifier for the generated messages object. When set,
   * the codemod adds or merges a value import only when it rewrites a call. */
  readonly messagesImport?: string;
  /** A hook that messagesImport exports and that returns the messages object,
   * such as `useMessages`. A formatter hook whose calls were all rewritten
   * (`const t = useT()`) becomes `const m = useMessages()`; one that skipped
   * calls keep alive gets `const m = useMessages();` on the next line. The
   * hook is imported instead of the object. JavaScript and TypeScript files only. */
  readonly messagesHook?: string;
  /** Move these named type-only imports from the selected incumbent i18n
   * package to messagesImport. This is explicit because only the application
   * adapter can guarantee that it exports a compatible replacement type. */
  readonly moveTypeImports?: readonly string[];
  readonly filename?: string;
  readonly customCalls?: readonly CustomTranslationCall[];
  readonly messageIds?: readonly string[] | ReadonlySet<string>;
  /** Maps Lingui source-message macro text to its extracted stable catalog ID. */
  readonly messageIdBySource?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  /** Legacy IDs the catalog migration renamed (`migrationIdRenames`), and their new IDs.
   * Calls name the new ID; messageIds holds the new IDs. */
  readonly messageIdRenames?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  /** A component taking `render={(m) => …}` that the caller declares. A message element outside
   * any component (module scope, a plain helper, a class) becomes `<C render={(m) => m.x()} />`,
   * which renders lazily in the current locale as Lingui's `<Trans>` did. Without it, such an
   * element becomes a call like any other, and the caller owns the m it references. */
  readonly messageComponent?: string;
  /** Message IDs whose base text has rich tags. A Lingui `<Trans components>` element whose
   * message has none becomes a plain call; by default every one becomes `rich(m.x, …)`. */
  readonly richMessageIds?: readonly string[] | ReadonlySet<string>;
  /** Refuse to return a partial migration when any recognized construct is
   * unresolved. Preview callers normally leave this false to inspect skips. */
  readonly strict?: boolean;
  /** Disable generic dead-binding cleanup when a higher-level framework
   * migration owns hook/provider placement and will reconcile declarations
   * after the call rewrite. */
  readonly cleanup?: boolean;
}
export interface CodemodSourceResult {
  readonly code: string;
  readonly replacements: number;
  readonly typeImportsMoved: number;
  readonly skipped: readonly CodemodSkip[];
  readonly compatibility: CodemodCompatibilityPlan;
}

/** Read an explicit source-text -> generated-ID map used by compatibility
 * codemods. The map is deliberately plain JSON so it can be reviewed and
 * generated by an incumbent extractor without coupling that extractor to the
 * migration process. */
export async function readMessageIdBySourceFile(file: string, root = '.'): Promise<Map<string, string>> {
  const path = resolve(root, file);
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { throw new Error(`Cannot read source-to-ID map ${path}: ${(error as Error).message}`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Source-to-ID map must be a JSON object: ${path}`);
  const result = new Map<string, string>();
  for (const [source, id] of Object.entries(parsed)) {
    if (Array.isArray(id)) throw new Error(`Source-to-ID map is ambiguous for ${JSON.stringify(source)}; candidates must be resolved before migration: ${id.map(String).join(', ')}`);
    if (!source || typeof id !== 'string' || !id) throw new Error(`Source-to-ID map entries must map nonempty source strings to nonempty IDs: ${path}`);
    result.set(source, id);
  }
  return result;
}
const concreteFormats: Exclude<CodemodFormat, 'auto'>[] = ['i18next', 'next-intl', 'formatjs', 'lingui', 'vue-i18n', 'tolgee', 'next-international', 'typesafe-i18n', 'svelte-i18n', 'transloco', 'ngx-translate'];
const extensions = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.vue', '.svelte', '.html']);
const ignored = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);
const identifier = /^[A-Za-z_$][\w$]*$/;

function normalizeFormat(format: CodemodFormat): CodemodFormat {
  if (format === 'react-i18next' || format === 'next-i18next') return 'i18next';
  if (format === 'react-intl') return 'formatjs';
  if (format === 'lingui-react') return 'lingui';
  if (format === 'tolgee-react') return 'tolgee';
  if (format === 'nuxt-i18n') return 'vue-i18n';
  return format;
}

function codeMask(text: string): Uint8Array {
  const mask = new Uint8Array(text.length);

  // JSXText is neither JavaScript comments nor regex literals. Without this
  // small AST-assisted boundary, a URL such as `https://…` in prose starts a
  // `//` comment in the lexical scanner and can hide a real helper later on
  // the same line. Parsing is attempted only for JSX-looking source and is
  // cached per source string; malformed/non-JSX snippets retain the textual
  // fallback below.
  const jsxTextRanges: Array<readonly [number, number]> = [];
  // Vue/Svelte single-file components embed executable code inside a
  // `<script>` wrapper that Babel would otherwise misclassify as JSXText.
  // Leave those wrappers to the lexical scanner; the source codemod already
  // treats their non-script template regions conservatively.
  // A standalone Svelte template can be valid JSX at the grammar level, but
  // parsing a large markup-only file here is unnecessary (and Babel's JSX
  // recovery gets increasingly expensive as the tree grows). Require a
  // lightweight JavaScript/TypeScript signal before taking this JSX path;
  // actual script-bearing JSX sources still qualify through imports,
  // declarations, functions or arrows.
  const likelyJsxProgram = /\b(?:import|export|const|let|var|function|class|return)\b|=>/.test(text);
  if (likelyJsxProgram && /<[A-Za-z]/.test(text) && />/.test(text) && !/<script\b/i.test(text)) {
    try {
      const ast = parse(text, { sourceType: 'unambiguous', errorRecovery: false, plugins: ['typescript', 'jsx', 'decorators-legacy', 'importAttributes'] });
      const seen = new Set<object>();
      const visit = (value: unknown): void => {
        if (!value || typeof value !== 'object' || seen.has(value as object)) return;
        seen.add(value as object);
        const node = value as { type?: string; start?: number; end?: number; [key: string]: unknown };
        if (node.type === 'JSXText' && typeof node.start === 'number' && typeof node.end === 'number') jsxTextRanges.push([node.start, node.end]);
        for (const [key, child] of Object.entries(node)) {
          if (key === 'type' || key === 'loc' || key === 'start' || key === 'end' || key === 'extra') continue;
          if (Array.isArray(child)) for (const item of child) visit(item);
          else visit(child);
        }
      };
      visit(ast.program);
    } catch { /* parser diagnostics are handled by astCallStarts for scripts */ }
  }
  jsxTextRanges.sort((left, right) => left[0] - right[0]);
  let jsxTextIndex = 0;
  const skipJsxText = (at: number): number | undefined => {
    while (jsxTextIndex < jsxTextRanges.length && jsxTextRanges[jsxTextIndex]![1] <= at) jsxTextIndex++;
    const range = jsxTextRanges[jsxTextIndex];
    return range && at >= range[0] && at < range[1] ? range[1] : undefined;
  };

  const previousSignificant = (start: number): string | undefined => {
    for (let index = start - 1; index >= 0; index--) if (!/\s/.test(text[index]!)) return text[index]!;
    return undefined;
  };
  const previousWord = (endExclusive: number): string | undefined => {
    let end = endExclusive;
    while (end > 0 && /\s/.test(text[end - 1]!)) end--;
    let start = end;
    while (start > 0 && /[\w$]/.test(text[start - 1]!)) start--;
    return start < end ? text.slice(start, end) : undefined;
  };
  const looksLikeRegex = (start: number): boolean => {
    const previous = previousSignificant(start);
    if (!previous) return true;
    // In markup, `</tag>` is an HTML closing tag rather than a JavaScript
    // regular expression. Returning early also avoids the suffix allocation
    // below for every closing tag in a large Svelte file.
    if (previous === '<') return false;
    if ('([{=,:;!?&|+-*%^~'.includes(previous)) return true;
    if (previous === '>' ) {
      let at = start - 1;
      while (at >= 0 && /\s/.test(text[at]!)) at--;
      if (text[at] === '>' && text[at - 1] === '=') return true;
    }
    const prefix = previousWord(start);
    return !!prefix && new Set(['case', 'delete', 'do', 'else', 'in', 'instanceof', 'new', 'of', 'return', 'throw', 'typeof', 'void', 'yield', 'await']).has(prefix);
  };
  const skipRegex = (start: number): number => {
    let index = start + 1, characterClass = false;
    for (; index < text.length; index++) {
      const character = text[index]!;
      if (character === '\\') { index++; continue; }
      if (character === '[') { characterClass = true; continue; }
      if (character === ']' && characterClass) { characterClass = false; continue; }
      if (character === '/' && !characterClass) {
        index++;
        while (index < text.length && /[A-Za-z]/.test(text[index]!)) index++;
        return index;
      }
      if (character === '\n' || character === '\r') return start + 1;
    }
    return text.length;
  };

  const startsQuotedLiteral = (start: number): boolean => {
    let previous = start - 1;
    while (previous >= 0 && /\s/.test(text[previous]!)) previous--;
    if (previous < 0) return true;
    const character = text[previous]!;
    if (character === '>' ) {
      // In TSX/JSX, `>` commonly ends an opening element and the following
      // apostrophe/double quote is plain JSXText (for example, `Don't`). Do
      // not let that prose quote hide later executable bindings. A brace or
      // another tag indicates that this is ordinary JavaScript instead.
      const afterTag = text.slice(previous + 1, start);
      const opening = text.lastIndexOf('<', previous);
      if (opening >= 0 && text[opening + 1] !== '/' && !/[<{]/.test(afterTag)) return false;
      return true;
    }
    if ('([{=,:;!?&|+-*%^~'.includes(character)) return true;
    const word = previousWord(previous + 1);
    return !!word && new Set(['as', 'case', 'delete', 'export', 'from', 'import', 'in', 'instanceof', 'new', 'of', 'return', 'throw', 'typeof', 'void', 'yield']).has(word);
  };

  // Keep quoted text and comments opaque, but do scan JavaScript embedded in
  // template interpolations. The old state machine treated the whole
  // template as opaque, so a proven call such as `${t('checkout.title')}`
  // could be silently missed even though Babel had parsed it successfully.
  const scanTemplate = (start: number): number => {
    let index = start;
    while (index < text.length) {
      const character = text[index]!, next = text[index + 1];
      if (character === '\\') { index += 2; continue; }
      if (character === '`') return index + 1;
      if (character === '$' && next === '{') {
        mask[index] = 1; mask[index + 1] = 1;
        index = scanExpression(index + 2);
        continue;
      }
      index++;
    }
    return index;
  };

  const scanExpression = (start: number): number => {
    let index = start, depth = 1;
    while (index < text.length) {
      const jsxTextEnd = skipJsxText(index);
      if (jsxTextEnd !== undefined) { index = jsxTextEnd; continue; }
      const character = text[index]!, next = text[index + 1];
      if (character === '/' && next === '/') {
        index += 2;
        while (index < text.length && text[index] !== '\n' && text[index] !== '\r') index++;
        continue;
      }
      if (character === '/' && next === '*') {
        index += 2;
        while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index++;
        index = Math.min(text.length, index + 2);
        continue;
      }
      if (character === '/' && looksLikeRegex(index)) { index = skipRegex(index); continue; }
      if (character === "'" && startsQuotedLiteral(index)) { index++; while (index < text.length) { if (text[index] === '\\') index += 2; else if (text[index++] === "'") break; } continue; }
      if (character === '"' && startsQuotedLiteral(index)) { index++; while (index < text.length) { if (text[index] === '\\') index += 2; else if (text[index++] === '"') break; } continue; }
      if (character === '`') { index = scanTemplate(index + 1); continue; }
      if (character === '{') { mask[index++] = 1; depth++; continue; }
      if (character === '}') {
        depth--;
        if (depth === 0) { mask[index] = 1; return index + 1; }
        mask[index++] = 1; continue;
      }
      mask[index++] = 1;
    }
    return index;
  };

  let index = 0;
  while (index < text.length) {
    const jsxTextEnd = skipJsxText(index);
    if (jsxTextEnd !== undefined) { index = jsxTextEnd; continue; }
    const character = text[index]!, next = text[index + 1];
    if (character === '/' && next === '/') {
      index += 2;
      while (index < text.length && text[index] !== '\n' && text[index] !== '\r') index++;
      continue;
    }
    if (character === '/' && next === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index++;
      index = Math.min(text.length, index + 2);
      continue;
    }
    if (character === '/' && looksLikeRegex(index)) { index = skipRegex(index); continue; }
    if (character === "'" && startsQuotedLiteral(index)) { index++; while (index < text.length) { if (text[index] === '\\') index += 2; else if (text[index++] === "'") break; } continue; }
    if (character === '"' && startsQuotedLiteral(index)) { index++; while (index < text.length) { if (text[index] === '\\') index += 2; else if (text[index++] === '"') break; } continue; }
    if (character === '`') { index = scanTemplate(index + 1); continue; }
    mask[index++] = 1;
  }
  return mask;
}

type SvelteTemplateMask = { mask: Uint8Array; diagnostics: CodemodSkip[] };

/**
 * Svelte permits JavaScript expressions inside quoted attribute values, for
 * example `title="{$t('search_for')} {name}"`. The generic JavaScript mask
 * quite correctly treats the whole quoted value as data, but that also hides
 * executable Svelte interpolations from the call codemod. Keep this scanner
 * deliberately narrower than an HTML parser: it only runs for `.svelte`
 * sources, only visits markup tags outside `<script>`/`<style>`, and exposes
 * only balanced `{...}` interpolation ranges. This prevents a string in a
 * JavaScript block (or an arbitrary HTML-looking string in JS) from becoming
 * executable code by accident.
 */
function svelteAttributeMask(text: string): SvelteTemplateMask {
  const mask = new Uint8Array(text.length), diagnostics: CodemodSkip[] = [];
  const rawTag = (name: string): boolean => /^(?:script|style)$/i.test(name);
  const tagName = (start: number): string | undefined => {
    // Do not slice from `start` to EOF for every tag. On a large component
    // tree that turns an otherwise linear scan into quadratic allocation and
    // copying. Read the short name directly and slice only its characters.
    let cursor = start + 1;
    while (/\s/.test(text[cursor] ?? '')) cursor++;
    if (!/[A-Za-z]/.test(text[cursor] ?? '')) return;
    const nameStart = cursor++;
    while (/[\w:.-]/.test(text[cursor] ?? '')) cursor++;
    return text.slice(nameStart, cursor);
  };
  const expressionEnd = (open: number, limit: number): number | undefined => {
    let depth = 0, quote: 'single' | 'double' | 'template' | undefined;
    for (let index = open; index < limit; index++) {
      const character = text[index]!, next = text[index + 1];
      if (quote) {
        if (character === '\\') { index++; continue; }
        if ((quote === 'single' && character === "'") || (quote === 'double' && character === '"') || (quote === 'template' && character === '`')) quote = undefined;
        continue;
      }
      if (character === "'") { quote = 'single'; continue; }
      if (character === '"') { quote = 'double'; continue; }
      if (character === '`') { quote = 'template'; continue; }
      if (character === '/' && next === '/') {
        index += 2;
        while (index < limit && text[index] !== '\n' && text[index] !== '\r') index++;
        index--;
        continue;
      }
      if (character === '/' && next === '*') {
        const close = text.indexOf('*/', index + 2);
        if (close < 0 || close >= limit) return;
        index = close + 1;
        continue;
      }
      if (character === '{') depth++;
      else if (character === '}' && --depth === 0) return index;
    }
    return;
  };
  const exposeValue = (valueStart: number, valueEnd: number): void => {
    let index = valueStart;
    while (index < valueEnd) {
      if (text[index] !== '{') { index++; continue; }
      const close = expressionEnd(index, valueEnd);
      if (close === undefined) {
        diagnostics.push({ callee: '(svelte attribute)', reason: 'quoted attribute interpolation is unclosed; repair the Svelte markup before migration', offset: index });
        return;
      }
      for (let at = index; at <= close; at++) mask[at] = 1;
      index = close + 1;
    }
  };

  let index = 0;
  while (index < text.length) {
    if (text.startsWith('<!--', index)) {
      const close = text.indexOf('-->', index + 4);
      index = close < 0 ? text.length : close + 3;
      continue;
    }
    // Svelte expressions outside an element may contain arbitrary JavaScript
    // strings that look like markup (`{@html '<button ...>'}`). Skip the
    // complete expression before looking for an opening tag so those strings
    // cannot be mistaken for real attributes.
    if (text[index] === '{') {
      const close = expressionEnd(index, text.length);
      if (close !== undefined) {
        index = close + 1;
        continue;
      }
    }
    if (text[index] !== '<' || !/[A-Za-z]/.test(text[index + 1] ?? '')) { index++; continue; }
    const name = tagName(index);
    if (!name) { index++; continue; }
    let cursor = index + 1, quote: 'single' | 'double' | undefined, quoteStart = -1, braces = 0, end = -1;
    for (; cursor < text.length; cursor++) {
      const character = text[cursor]!;
      if (quote) {
        if (character === '\\') { cursor++; continue; }
        if ((quote === 'single' && character === "'") || (quote === 'double' && character === '"')) {
          exposeValue(quoteStart + 1, cursor);
          quote = undefined; quoteStart = -1;
        }
        continue;
      }
      if (character === "'") { quote = 'single'; quoteStart = cursor; continue; }
      if (character === '"') { quote = 'double'; quoteStart = cursor; continue; }
      if (character === '{') { braces++; continue; }
      if (character === '}' && braces) { braces--; continue; }
      if (character === '>' && braces === 0) { end = cursor; break; }
    }
    if (end < 0) {
      diagnostics.push({ callee: `<${name}>`, reason: 'Svelte opening tag is unclosed; repair the markup before migration', offset: index });
      break;
    }
    const opening = text.slice(index, end + 1);
    const closing = /\/\s*>\s*$/.test(opening);
    if (!closing && rawTag(name)) {
      const closePattern = new RegExp(`</\\s*${name}\\s*>`, 'ig');
      closePattern.lastIndex = end + 1;
      const close = closePattern.exec(text);
      index = close ? close.index + close[0].length : text.length;
      continue;
    }
    index = end + 1;
  }
  return { mask, diagnostics };
}

function codeMatches(text: string, pattern: RegExp, sourceMask?: Uint8Array): RegExpStringIterator<RegExpExecArray> {
  const mask = sourceMask ?? codeMask(text);
  return [...text.matchAll(pattern)].filter(match => !!mask[match.index!])[Symbol.iterator]();
}

function hasCodeMatch(text: string, pattern: RegExp): boolean {
  return !codeMatches(text, pattern).next().done;
}

function staticString(source: string): string | undefined {
  const match = /^\s*(['"])([^'"\\]*)\1\s*$/.exec(source);
  if (match) return match[2];
  const template = /^\s*`([^`\\$]*)`\s*$/.exec(source);
  return template?.[1];
}

/** Lower a finite conditional key without introducing a dynamic catalog
 * lookup. Every leaf must be a static message ID, so generated types keep
 * checking the result and an unknown branch still fails closed. */
function conditionalMessageCall(
  source: string,
  render: (id: string) => string | undefined,
): string | undefined {
  const expression = source.trim();
  let root: AstNode;
  try {
    root = parseExpression(expression, {
      plugins: ['typescript', 'jsx', 'decorators-legacy', 'importAttributes'],
    }) as unknown as AstNode;
  } catch {
    return;
  }
  const slice = (node: AstNode): string | undefined =>
    typeof node.start === 'number' && typeof node.end === 'number'
      ? expression.slice(node.start, node.end)
      : undefined;
  const lower = (node: AstNode): string | undefined => {
    if (node.type === 'StringLiteral') {
      const value = (node as AstNode & { value?: unknown }).value;
      return typeof value === 'string' ? render(value) : undefined;
    }
    if (node.type === 'TemplateLiteral') {
      const value = staticString(slice(node) ?? '');
      return value === undefined ? undefined : render(value);
    }
    // Lingui's defineMessage({ id: 'x' }).id, or msg(), is the static ID 'x'.
    if (node.type === 'MemberExpression' && !node.computed && (node.property as AstNode & { name?: string }).name === 'id') {
      const call = node.object as AstNode & { callee?: AstNode & { name?: string }; arguments?: AstNode[] };
      const id = call.type === 'CallExpression' && /^(?:defineMessage|msg)$/.test(call.callee?.name ?? '') && call.arguments?.length === 1
        ? linguiDescriptor(slice(call.arguments[0]!) ?? '') : undefined;
      return id && !id.values ? render(id.id) : undefined;
    }
    if (node.type === 'ConditionalExpression') {
      const test = slice((node as AstNode & { test: AstNode }).test);
      const consequent = lower((node as AstNode & { consequent: AstNode }).consequent);
      const alternate = lower((node as AstNode & { alternate: AstNode }).alternate);
      return test && consequent && alternate ? `(${test} ? ${consequent} : ${alternate})` : undefined;
    }
    if (node.type === 'ParenthesizedExpression' || node.type === 'TSAsExpression'
      || node.type === 'TSSatisfiesExpression' || node.type === 'TSNonNullExpression'
      || node.type === 'TypeCastExpression') {
      const inner = (node as AstNode & { expression?: AstNode }).expression;
      return inner ? lower(inner) : undefined;
    }
    return;
  };
  return lower(root);
}

/** Where a JSX element is evaluated: at module scope, inside a component or hook (a function
 * named `Name` or `useName`, or any function within one), or in another function. Only a
 * component can bind `m` with a hook. */
type JsxOwner = 'module' | 'component' | 'function';
type JsxElementBounds = { end: number; openingEnd: number; closingStart?: number; owner: JsxOwner };

function astCallStarts(text: string): { starts: Set<number>; ends: Map<number, number>; shadowedStarts: Set<number>; jsxStarts: Set<number>; jsxChildStarts: Set<number>; jsxExpressionStatementStarts: Set<number>; jsxElements: Map<number, JsxElementBounds>; error?: string } {
  try {
    const ast = parse(text, { sourceType: 'unambiguous', errorRecovery: false, plugins: ['typescript', 'jsx', 'decorators-legacy', 'importAttributes'] });
    const starts = new Set<number>(), ends = new Map<number, number>(), shadowedStarts = new Set<number>(), jsxStarts = new Set<number>(), jsxChildStarts = new Set<number>(), jsxExpressionStatementStarts = new Set<number>(), jsxElements = new Map<number, JsxElementBounds>(), seen = new Set<object>();
    const bindingNames = (value: unknown, result = new Set<string>()): Set<string> => {
      if (!value || typeof value !== 'object') return result;
      const node = value as { type?: string; name?: string; [key: string]: unknown };
      if (node.type === 'Identifier' && typeof node.name === 'string') { result.add(node.name); return result; }
      for (const [key, child] of Object.entries(node)) {
        if (key === 'type' || key === 'loc' || key === 'start' || key === 'end' || key === 'extra') continue;
        if (Array.isArray(child)) for (const item of child) bindingNames(item, result);
        else bindingNames(child, result);
      }
      return result;
    };
    const calleeBase = (value: unknown): string | undefined => {
      if (!value || typeof value !== 'object') return;
      const node = value as { type?: string; name?: string; object?: unknown };
      if (node.type === 'Identifier') return node.name;
      if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') return calleeBase(node.object);
    };
    const nameOf = (value: unknown): string | undefined => {
      const node = value as { type?: string; name?: string; property?: unknown } | undefined;
      return node?.type === 'Identifier' ? node.name : node?.type === 'MemberExpression' ? nameOf(node.property) : undefined;
    };
    // `hint` carries the name a function expression is bound to: `const Card = memo(() => …)`.
    const visit = (value: unknown, parent?: Record<string, unknown>, scopes: readonly Set<string>[] = [], owner: JsxOwner = 'module', hint?: string): void => {
      if (!value || typeof value !== 'object' || seen.has(value as object)) return;
      seen.add(value as object);
      const node = value as { type?: string; callee?: { start?: number } | null } & Record<string, unknown>;
      if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
        if (typeof node.callee?.start === 'number') {
          starts.add(node.callee.start);
          if (typeof (node as { end?: number }).end === 'number') ends.set(node.callee.start, (node as { end: number }).end);
          const base = calleeBase(node.callee);
          if (base && scopes.some(scope => scope.has(base))) shadowedStarts.add(node.callee.start);
        }
      }
      if (node.type === 'JSXElement') {
        const opening = node.openingElement as { start?: number; end?: number } | undefined;
        const closing = node.closingElement as { start?: number } | null | undefined;
        if (typeof opening?.start === 'number') {
          jsxStarts.add(opening.start);
          if (typeof opening.end === 'number' && typeof node.end === 'number') jsxElements.set(opening.start, { end: node.end as number, openingEnd: opening.end, ...(typeof closing?.start === 'number' ? { closingStart: closing.start } : {}), owner });
          // An attribute value (`title=<Trans … />`) needs braces around a call, as a child does.
          if (parent?.type === 'JSXElement' || parent?.type === 'JSXFragment') {
            const children = parent.children;
            if (Array.isArray(children) && children.includes(node)) jsxChildStarts.add(opening.start);
          } else if (parent?.type === 'JSXAttribute') jsxChildStarts.add(opening.start);
          if (parent?.type === 'ExpressionStatement') jsxExpressionStatementStarts.add(opening.start);
        }
      }
      if (node.type === 'CatchClause') {
        const catchScope = bindingNames(node.param);
        for (const [key, child] of Object.entries(node)) {
          if (key === 'type' || key === 'param' || key === 'loc' || key === 'start' || key === 'end' || key === 'extra') continue;
          if (Array.isArray(child)) for (const item of child) visit(item, node, [...scopes, catchScope], owner);
          else visit(child, node, [...scopes, catchScope], owner);
        }
        return;
      }
      const functionLike = /Function(?:Declaration|Expression)$|^(?:ArrowFunctionExpression|ObjectMethod|ClassMethod|ClassPrivateMethod)$/.test(node.type ?? '');
      const nextScopes = functionLike ? [...scopes, bindingNames(node.params)] : scopes;
      // Methods are named by their key, so a class component's render() is not a component.
      const functionName = functionLike ? nameOf(node.id) ?? (/Method$/.test(node.type!) ? nameOf(node.key) ?? '' : hint) : undefined;
      const nextOwner: JsxOwner = !functionLike ? owner : functionName !== undefined && /^(?:[A-Z]|use[A-Z0-9])/.test(functionName) || owner === 'component' ? 'component' : 'function';
      for (const [key, child] of Object.entries(node)) {
        if (key === 'type' || key === 'loc' || key === 'start' || key === 'end' || key === 'extra') continue;
        const childHint = node.type === 'VariableDeclarator' && key === 'init' ? nameOf(node.id)
          : node.type === 'AssignmentExpression' && key === 'right' ? nameOf(node.left)
          : (node.type === 'CallExpression' && key === 'arguments') || node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' || node.type === 'ParenthesizedExpression' ? hint : undefined;
        if (Array.isArray(child)) for (const item of child) visit(item, node, nextScopes, nextOwner, childHint);
        else visit(child, node, nextScopes, nextOwner, childHint);
      }
    };
    visit(ast.program);
    return { starts, ends, shadowedStarts, jsxStarts, jsxChildStarts, jsxExpressionStatementStarts, jsxElements };
  } catch (error) { return { starts: new Set(), ends: new Map(), shadowedStarts: new Set(), jsxStarts: new Set(), jsxChildStarts: new Set(), jsxExpressionStatementStarts: new Set(), jsxElements: new Map(), error: (error as Error).message }; }
}

function closingParenthesis(text: string, open: number, mask: Uint8Array): number | undefined {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    if (!mask[index]) continue;
    if (text[index] === '(') depth++;
    else if (text[index] === ')' && --depth === 0) return index;
  }
}

function argumentsOf(text: string, open: number, close: number, mask: Uint8Array): string[] {
  const arguments_: string[] = [];
  let start = open + 1, round = 0, square = 0, curly = 0;
  for (let index = start; index < close; index++) {
    if (!mask[index]) continue;
    const character = text[index];
    if (character === '(') round++; else if (character === ')') round--;
    else if (character === '[') square++; else if (character === ']') square--;
    else if (character === '{') curly++; else if (character === '}') curly--;
    else if (character === ',' && round === 0 && square === 0 && curly === 0) { arguments_.push(text.slice(start, index).trim()); start = index + 1; }
  }
  const tail = text.slice(start, close).trim();
  if (tail || arguments_.length) arguments_.push(tail);
  return arguments_;
}

/** i18next's `namespace:key` form names its namespace inline, and that name
 * takes precedence over the hook or options namespace. Anything more complex
 * (empty parts, a second separator) is not a single namespace/key pair. */
function splitI18nextNamespace(key: string): { namespace?: string; key: string } | undefined {
  const separator = key.indexOf(':');
  if (separator < 0) return { key };
  const namespace = key.slice(0, separator), local = key.slice(separator + 1);
  if (!namespace || !local || local.includes(':') || /[\s{}'"`]/.test(namespace)) return undefined;
  return { namespace, key: local };
}

function messageAccess(root: string, id: string): string {
  const parts = id.split('.');
  const unsafePropertyNames = new Set(['__proto__', 'constructor', 'default', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'prototype', 'then', 'toLocaleString', 'toString', 'valueOf']);
  return parts.every(part => identifier.test(part) && !unsafePropertyNames.has(part))
    ? `${root}.${parts.join('.')}` : `${root}[${JSON.stringify(id)}]`;
}

function formatJsId(descriptor: string): string | undefined {
  if (!/^\s*\{[\s\S]*\}\s*$/.test(descriptor)) return;
  // Only accept a top-level own `id` property. A flat regexp can otherwise
  // select `{meta: {id: 'wrong'}}` and silently migrate the call to an
  // unrelated message. Reuse the same delimiter-aware argument scanner used
  // by the call codemod so nested objects, strings and commas are preserved.
  const trimmed = descriptor.trim(), wrapped = `(${trimmed.slice(1, -1)})`;
  const fields = argumentsOf(wrapped, 0, wrapped.length - 1, codeMask(wrapped));
  for (const field of fields) {
    const match = /^\s*(?:id|(['"])id\1)\s*:\s*([\s\S]*)$/.exec(field);
    if (!match) continue;
    return staticString(match[2]!);
  }
  return undefined;
}

/** A Lingui message descriptor, `{ id, message, values }`, bare or wrapped in msg(), t() or
 * defineMessage(). `message` is the source-locale default the catalog holds and `comment`
 * is for translators, so both go; `values` are the call's values, as Lingui reads them. Any
 * other field, a spread or a computed ID is not provably a plain descriptor. */
function linguiDescriptor(argument: string): { id: string; values?: string } | undefined {
  const inner = (/^\s*(?:msg|t|defineMessage)\s*\(([\s\S]*)\)\s*$/.exec(argument)?.[1] ?? argument).trim();
  if (!/^\{[\s\S]*\}$/.test(inner)) return;
  const wrapped = `(${inner.slice(1, -1)})`;
  let id: string | undefined, values: string | undefined;
  for (const field of argumentsOf(wrapped, 0, wrapped.length - 1, codeMask(wrapped))) {
    if (!field.trim()) continue;
    if (/^\s*values\s*$/.test(field)) { values = 'values'; continue; }
    if (/^\s*(?:message|comment)\s*$/.test(field)) continue;
    const match = /^\s*(?:([A-Za-z_$][\w$]*)|(['"])([A-Za-z_$][\w$]*)\2)\s*:\s*([\s\S]*)$/.exec(field);
    const name = match?.[1] ?? match?.[3];
    if (name === 'id') { id = staticString(match![4]!); if (id === undefined) return; }
    else if (name === 'values') values = match![4]!.trim();
    else if (name !== 'message' && name !== 'comment') return;
  }
  return id ? { id, ...(values ? { values } : {}) } : undefined;
}

function i18nextValues(argument: string | undefined): { values?: string; unsupported?: string } {
  if (!argument) return {};
  const trimmed = argument.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return { values: trimmed };
  const wrapper = `(${trimmed.slice(1, -1)})`, fields = argumentsOf(wrapper, 0, wrapper.length - 1, codeMask(wrapper));
  const unsupported = fields.find(field => /^\s*(?:returnObjects|joinArrays|context|lng|fallbackLng|interpolation|defaultValue)\s*:/.test(field));
  if (unsupported) return { unsupported: unsupported.split(':', 1)[0]!.trim() };
  const values = fields.filter(field => !/^\s*(?:ns|keyPrefix)\s*:/.test(field));
  return values.length ? { values: `{${values.join(', ')}}` } : {};
}

function importedLocals(text: string, modules: readonly string[], importedNames: readonly string[], includeUnimported = true): string[] {
  const result = new Set(includeUnimported ? importedNames : []);
  if (!modules.length) return [...result];
  const modulePattern = modules.map(item => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const pattern = new RegExp(`\\bimport\\s*\\{([^}]*)\\}\\s*from\\s*['"](?:${modulePattern})['"]`, 'g');
  for (const match of codeMatches(text, pattern)) {
    for (const field of match[1]!.split(',')) {
      const parsed = /^\s*(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(field);
      if (parsed && importedNames.includes(parsed[1]!)) result.add(parsed[2] ?? parsed[1]!);
    }
  }
  return [...result];
}

function factoryPattern(factories: string | readonly string[]): string {
  const values = typeof factories === 'string' ? [factories] : factories;
  return values.map(item => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
}

function namespaceArgumentInfo(argument: string | undefined): { namespace?: string; dynamic?: boolean } {
  if (!argument) return {};
  const direct = staticString(argument) ?? /^\s*(['"])([^'"\\]*)\1/.exec(argument)?.[2];
  if (direct) return { namespace: direct };
  const namespace = /\bnamespace\s*:\s*/.exec(argument);
  if (namespace) {
    const value = argument.slice(namespace.index + namespace[0].length);
    const quoted = /^\s*(['"])([^'"\\]*)\1/.exec(value);
    if (quoted) return { namespace: quoted[2] };
    const parsed = staticString(value.split(',')[0] ?? '');
    return parsed ? { namespace: parsed } : { dynamic: true };
  }
  // A single non-object argument is the namespace for next-intl and the
  // common i18next hook form. Never silently drop a computed namespace.
  if (!/^\s*\{/.test(argument)) return { dynamic: true };
  return {};
}

function destructuredBindings(text: string, factories: string | readonly string[], property: string, includeKeyPrefix = false, diagnostics: CodemodSkip[] = [], strictFactoryOptions = false): Array<{ name: string; namespace?: string; namespaceDynamic?: boolean }> {
  const result: Array<{ name: string; namespace?: string; namespaceDynamic?: boolean }> = [];
  const pattern = new RegExp(`\\b(?:const|let|var)\\s*\\{([^{}]*)\\}\\s*=\\s*(?:await\\s+)?(?:${factoryPattern(factories)})\\s*\\(`, 'g');
  const mask = codeMask(text);
  for (const match of codeMatches(text, pattern)) {
    const open = match.index! + match[0].lastIndexOf('('), close = closingParenthesis(text, open, mask);
    if (close === undefined) {
      diagnostics.push({ callee: property, reason: 'translation factory call is unclosed; repair the source before migration', offset: match.index });
      continue;
    }
    const argument = text.slice(open + 1, close), namespaceInfo = namespaceArgumentInfo(argument);
    const dynamicFactoryOptions = strictFactoryOptions && argument.trim() && argument.trim() !== '{}';
    const keyPrefixMatch = includeKeyPrefix ? /\bkeyPrefix\s*:\s*([^,}]+)/.exec(argument) : undefined;
    const keyPrefix = keyPrefixMatch ? staticString(keyPrefixMatch[1]!) : undefined;
    const dynamicKeyPrefix = !!keyPrefixMatch && keyPrefix === undefined;
    const prefix = [namespaceInfo.namespace, keyPrefix].filter(Boolean).join('.') || undefined;
    for (const field of match[1]!.split(',')) {
      const binding = new RegExp(`^\\s*${property}(?:\\s*:\\s*([A-Za-z_$][\\w$]*))?\\s*$`).exec(field);
      if (binding) result.push({ name: binding[1] ?? property, ...(prefix ? { namespace: prefix } : {}), ...((namespaceInfo.dynamic || dynamicKeyPrefix || dynamicFactoryOptions) ? { namespaceDynamic: true } : {}) });
    }
  }
  return result;
}

function namespaceArgument(argument: string | undefined): string | undefined {
  return namespaceArgumentInfo(argument).namespace;
}

/** A textual codemod must not bind a call to an outer translation helper when
 * a function parameter shadows that helper. Babel's parser gives us reliable
 * syntax validation, but scope analysis is intentionally kept local here so
 * this package does not depend on a second traversal runtime. The common
 * function/arrow shadowing forms are rejected conservatively; callers can
 * still migrate the call explicitly after review. */
function shadowedByParameter(text: string, name: string, offset: number, sourceMask?: Uint8Array): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mask = sourceMask ?? codeMask(text);
  const functionPattern = /(?:function\s+[A-Za-z_$][\w$]*\s*\(([^)]*)\)|\(([^)]*)\)\s*=>|([A-Za-z_$][\w$]*)\s*=>)\s*\{/g;
  for (const match of codeMatches(text, functionPattern, mask)) {
    const parameters = match[1] ?? match[2] ?? match[3] ?? '';
    if (!new RegExp(`(?:^|[,\\s])${escaped}(?:$|[,\\s=:])`).test(parameters)) continue;
    const open = text.indexOf('{', match.index!);
    // Scan braces explicitly so a parameter shadowing the call in an
    // arrow/function body is caught.
    let depth = 0, end = text.length;
    if (open >= 0) {
      for (let index = open; index < text.length; index++) {
        if (!mask[index]) continue;
        if (text[index] === '{') depth++;
        else if (text[index] === '}' && --depth === 0) { end = index; break; }
      }
    }
    if (offset > open && offset < end) return true;
  }
  // Expression-bodied arrows have no brace. Limit the rejection to the
  // expression on the same line to avoid treating an unrelated later call as
  // shadowed.
  const expressionArrow = /\(([^)]*)\)\s*=>|\b([A-Za-z_$][\w$]*)\s*=>/g;
  for (const match of codeMatches(text, expressionArrow, mask)) {
    const parameters = match[1] ?? match[2] ?? '';
    if (!new RegExp(`(?:^|[,\\s])${escaped}(?:$|[,\\s=:])`).test(parameters)) continue;
    const lineEnd = text.indexOf('\n', match.index!);
    if (offset > match.index! && (lineEnd < 0 || offset < lineEnd)) return true;
  }
  return false;
}

function enclosingBlock(text: string, offset: number, mask = codeMask(text)): number {
  const stack: number[] = [];
  for (let index = 0; index < offset; index++) {
    if (!mask[index]) continue;
    if (text[index] === '{') stack.push(index);
    else if (text[index] === '}') stack.pop();
  }
  return stack.at(-1) ?? -1;
}

function shadowedByLocal(text: string, name: string, offset: number, sourceMask?: Uint8Array): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), mask = sourceMask ?? codeMask(text);
  const blocks = new Set<number>(), stack: number[] = [];
  for (let index = 0; index < offset; index++) {
    if (!mask[index]) continue;
    if (text[index] === '{') stack.push(index);
    else if (text[index] === '}') stack.pop();
  }
  for (const block of stack) blocks.add(block);
  const declarations = new RegExp(`\\b(?:const|let|var|function|class)\\s+${escaped}\\b`, 'g');
  for (const match of codeMatches(text, declarations, mask)) {
    if (!blocks.has(enclosingBlock(text, match.index!, mask))) continue;
    const declaration = text.slice(match.index!, Math.min(text.length, match.index! + 180));
    // The generated binding itself is not a shadow. Its initializer is the
    // proof that this declaration owns the translation helper.
    if (/=\s*(?:await\s+)?(?:[A-Za-z_$][\w$]*\.)?(?:useTranslation|useTranslations|getTranslations|useIntl|useLingui|useI18n|useTranslate|useI18nContext|useT|getT|getI18n|inject|createI18nClient|createI18nServer)\s*\(/.test(declaration)) continue;
    return true;
  }
  return false;
}

function wrapperDiagnostics(text: string, callees: readonly string[]): CodemodSkip[] {
  const result: CodemodSkip[] = [];
  const seen = new Set<string>();
  for (const callee of callees) {
    const base = callee.split('.')[0]!;
    const escaped = callee.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Only report a wrapper when its body visibly delegates to a proven
    // translation binding. Calls through arbitrary higher-order values are
    // intentionally not guessed at by the codemod.
    const pattern = new RegExp(`(?:const|let|var|function)\\s+([A-Za-z_$][\\w$]*)[^\\n{}]*?(?:=>|\\{)[^\\n{}]*${escaped}\\s*\\(`, 'g');
    for (const match of codeMatches(text, pattern)) {
      const wrapper = match[1]!;
      if (wrapper === base || wrapper === callee || !identifier.test(wrapper)) continue;
      const declarationEnd = match.index! + match[0].length;
      const usage = new RegExp(`\\b${wrapper.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*\\(`, 'g');
      const invoked = [...text.matchAll(usage)].some(item => item.index! >= declarationEnd);
      if (!invoked) continue;
      const key = `${wrapper}:${match.index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ callee: wrapper, reason: `wrapper delegates to ${callee}; migrate the wrapper explicitly because its argument and fallback semantics are not statically provable`, offset: match.index });
    }
  }
  return result;
}

const incumbentPackages: Partial<Record<Exclude<CodemodFormat, 'auto'>, readonly RegExp[]>> = {
  i18next: [/^i18next(?:\/|$)/, /^react-i18next(?:\/|$)/, /^next-i18next(?:\/|$)/],
  'next-intl': [/^next-intl(?:\/|$)/],
  formatjs: [/^react-intl(?:\/|$)/, /^@formatjs\//],
  lingui: [/^@lingui\//],
  'vue-i18n': [/^vue-i18n(?:\/|$)/, /^@intlify\//, /^@nuxtjs\/i18n(?:\/|$)/],
  tolgee: [/^@tolgee\//],
  'next-international': [/^next-international(?:\/|$)/],
  'typesafe-i18n': [/^typesafe-i18n(?:\/|$)/],
  'svelte-i18n': [/^svelte-i18n(?:\/|$)/],
  transloco: [/^@jsverse\/transloco(?:\/|$)/, /^@ngneat\/transloco(?:\/|$)/],
  'ngx-translate': [/^@ngx-translate\//],
};

function runtimeImportClause(clause: string): boolean {
  const value = clause.trim();
  if (/^type\b/.test(value)) return false;
  if (!value.startsWith('{') || !value.endsWith('}')) return true;
  return value.slice(1, -1).split(',').some(item => !/^\s*type\b/.test(item));
}

function incumbentImportDiagnostics(text: string, format: Exclude<CodemodFormat, 'auto'>): CodemodSkip[] {
  const result: CodemodSkip[] = [], seen = new Set<string>(), packages = incumbentPackages[format] ?? [];
  const add = (specifier: string, offset: number): void => {
    if (!packages.some(pattern => pattern.test(specifier))) return;
    const key = `${specifier}:${offset}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push({ callee: specifier, reason: `incumbent runtime import ${JSON.stringify(specifier)} remains; remove it or use the matching framework migration before claiming a complete codemod`, offset });
  };
  for (const match of codeMatches(text, /\bimport\s+(?!\()([\s\S]*?)\s+from\s*(['"])([^'"]+)\2/g)) if (runtimeImportClause(match[1]!)) add(match[3]!, match.index!);
  for (const match of codeMatches(text, /\bimport\s*(['"])([^'"]+)\1/g)) add(match[2]!, match.index!);
  for (const match of codeMatches(text, /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g)) add(match[2]!, match.index!);
  return result;
}

/** Returns a function that adds 1-based line and column to a skip. Line starts
 * are indexed once so a large file with many diagnostics stays linear-ish. */
function sourcePositioner(text: string): (item: CodemodSkip) => CodemodSkip {
  const lineStarts = [0];
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) lineStarts.push(index + 1);
  return item => {
    if (typeof item.offset !== 'number' || item.line !== undefined) return item;
    const offset = Math.min(Math.max(item.offset, 0), text.length);
    let low = 0, high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (lineStarts[middle]! <= offset) low = middle; else high = middle - 1;
    }
    return { ...item, line: low + 1, column: offset - lineStarts[low]! + 1 };
  };
}

/** Read only the generated-output location. A codemod must not reject a
 * project because some other config field belongs to a migration step. */
async function configuredOutputDirectory(root: string): Promise<string> {
  const fallback = resolve(root, 'src/i18n');
  try {
    const value = JSON.parse(await readFile(await discoverConfig(root), 'utf8')) as { outDir?: unknown };
    return typeof value.outDir === 'string' ? resolve(root, value.outDir) : fallback;
  } catch { return fallback; }
}

async function writable(file: string): Promise<boolean> {
  try { await access(file, constants.W_OK); return true; }
  catch { return false; }
}

function actionableSkip(item: CodemodSkip): CodemodSkip {
  if (item.code && item.action) return item;
  const reason = item.reason;
  let code = 'MANUAL_REVIEW';
  let action = 'Review this boundary, migrate it explicitly, or retain the reported lazy legacy fallback for this file.';
  if (/dynamic template literal|pipe key is dynamic/.test(reason)) {
    code = 'DYNAMIC_TEMPLATE_KEY';
    action = 'Replace the computed key with a finite static branch or an explicit typed message map, then re-run the codemod.';
  } else if (/key is dynamic|no static id|dynamic expressions/.test(reason)) {
    code = 'DYNAMIC_MESSAGE_KEY';
    action = 'Use a literal key, a finite conditional, or an explicit typed message map; otherwise keep this call behind the lazy legacy boundary.';
  } else if (/incumbent runtime import/.test(reason)) {
    code = 'INCUMBENT_RUNTIME_IMPORT';
    action = 'Remove the legacy runtime/provider after its remaining consumers are migrated, or run the matching framework migration.';
  } else if (/rich|nested JSX/.test(reason)) {
    code = 'RICH_MESSAGE';
    action = 'Move this call to the Nordbeam rich-message renderer while preserving component/function value semantics.';
  } else if (/absent from generated message types/.test(reason)) {
    code = 'UNKNOWN_MESSAGE_ID';
    action = 'Add the message to the base catalog or correct the key to an existing generated ID, then re-run the codemod.';
  } else if (/source-to-id mapping/.test(reason)) {
    code = 'MESSAGE_ID_UNRESOLVED';
    action = 'Add the message to the base catalog or provide an unambiguous source-to-ID map, then re-run the codemod.';
  } else if (/did not parse|unclosed/.test(reason)) {
    code = 'SOURCE_PARSE_ERROR';
    action = 'Repair the source syntax first; the codemod intentionally made no changes at this boundary.';
  } else if (/shadowed|multiple namespace|outside the lexical scope|ambiguous/.test(reason)) {
    code = 'AMBIGUOUS_BINDING';
    action = 'Qualify or rename the translation binding so its origin and namespace are statically provable, then re-run the codemod.';
  } else if (/unsupported|default value|namespace.*dynamic|extra arguments/.test(reason)) {
    code = 'UNSUPPORTED_OPTIONS';
    action = 'Split framework-specific options from interpolation values and migrate the remaining behavior explicitly.';
  } else if (/nested translation call/.test(item.callee) || /inner call first/.test(reason)) {
    code = 'NESTED_TRANSLATION_CALL';
    action = 'Use the project codemod, which reparses and converges nested calls in one reviewed operation.';
  }
  return { ...item, code: item.code ?? code, action: item.action ?? action };
}

function actionableSkips(items: readonly CodemodSkip[]): CodemodSkip[] {
  return items.map(actionableSkip);
}

function compatibilityPlan(directRewrites: number, skipped: readonly CodemodSkip[], fallbackFiles: readonly string[] = [], files: readonly CodemodCompatibilityFile[] = []): CodemodCompatibilityPlan {
  const fallbackCalls = [...new Map(actionableSkips(skipped).map(item => [`${item.file ?? ''}:${item.offset ?? -1}:${item.callee}:${item.reason}`, item])).values()];
  return {
    directRewrites,
    fallbackRequired: fallbackCalls.length > 0,
    fallbackStrategy: fallbackCalls.length ? 'lazy-legacy-boundary' : 'none',
    fallbackCalls,
    fallbackFiles,
    files,
  };
}

function bindings(text: string, format: Exclude<CodemodFormat, 'auto'>, diagnostics: CodemodSkip[] = []): Binding[] {
  const result: Binding[] = [];
  if (format === 'next-intl') {
    const factories = importedLocals(text, ['next-intl', 'next-intl/server'], ['useTranslations', 'getTranslations']);
    const pattern = new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:await\\s+)?(?:${factoryPattern(factories)})\\s*\\(`, 'g'), mask = codeMask(text);
    for (const match of codeMatches(text, pattern)) {
      const open = match.index! + match[0].lastIndexOf('('), close = closingParenthesis(text, open, mask);
      if (close === undefined) { diagnostics.push({ callee: match[1]!, reason: 'translation factory call is unclosed; repair the source before migration', offset: match.index }); continue; }
      const info = namespaceArgumentInfo(text.slice(open + 1, close));
      const binding = { callee: match[1]!, ...(info.namespace ? { namespace: info.namespace } : {}), ...(info.dynamic ? { namespaceDynamic: true } : {}), kind: 'message' as const };
      result.push(binding);
      // `t.rich` returns React/rich-text structure rather than the plain
      // message value exposed by the generated object. Do not classify it as
      // an ordinary message call: the member audit below will report it and
      // keep framework adapters from deleting the legacy hook.
    }
  } else if (format === 'i18next') {
    const factories = importedLocals(text, ['react-i18next', 'next-i18next'], ['useTranslation']);
    for (const item of destructuredBindings(text, factories, 't', true, diagnostics)) result.push({ callee: item.name, ...(item.namespace ? { namespace: item.namespace } : {}), ...(item.namespaceDynamic ? { namespaceDynamic: true } : {}), kind: 'message' });
    for (const match of codeMatches(text, /\bimport\s+([A-Za-z_$][\w$]*)\s+from\s+['"]i18next['"]/g)) result.push({ callee: `${match[1]}.t`, kind: 'message' });
    for (const match of codeMatches(text, /\bimport\s*\{([^}]*)\}\s*from\s*['"]i18next['"]/g)) for (const field of match[1]!.split(',')) {
      const imported = /^\s*t(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(field);
      if (imported) result.push({ callee: imported[1] ?? 't', kind: 'message' });
    }
  } else if (format === 'formatjs') {
    const factories = importedLocals(text, ['react-intl'], ['useIntl']);
    for (const match of codeMatches(text, new RegExp(`\\b(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:${factoryPattern(factories)})\\(\\s*\\)`, 'g'))) result.push({ callee: `${match[1]}.formatMessage`, kind: 'descriptor' });
    for (const item of destructuredBindings(text, factories, 'formatMessage', false, diagnostics)) result.push({ callee: item.name, kind: 'descriptor' });
    if (hasCodeMatch(text, /\bfrom\s*['"]react-intl['"]/g)) result.push({ callee: 'this.props.intl.formatMessage', kind: 'descriptor' });
  } else if (format === 'lingui') {
    const factories = importedLocals(text, ['@lingui/react', '@lingui/react/macro'], ['useLingui']);
    for (const item of destructuredBindings(text, factories, 'i18n', false, diagnostics)) result.push({ callee: `${item.name}._`, kind: 'message' });
    for (const item of destructuredBindings(text, factories, '_', false, diagnostics)) result.push({ callee: item.name, kind: 'message' });
    for (const match of codeMatches(text, /\bimport\s*\{([^}]*)\}\s*from\s*['"]@lingui\/(?:core\/)?macro['"]/g)) for (const field of match[1]!.split(',')) {
      const imported = /^\s*(?:t|msg)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(field);
      if (imported) result.push({ callee: imported[1] ?? field.trim().split(/\s+/)[0]!, kind: 'descriptor' });
    }
  } else if (format === 'vue-i18n') {
    const factories = importedLocals(text, ['vue-i18n', '@nuxtjs/i18n'], ['useI18n']);
    for (const item of destructuredBindings(text, factories, 't', false, diagnostics, true)) result.push({ callee: item.name, ...(item.namespace ? { namespace: item.namespace } : {}), ...(item.namespaceDynamic ? { namespaceDynamic: true } : {}), kind: 'message' });
  } else if (format === 'tolgee') {
    const factories = importedLocals(text, ['@tolgee/react'], ['useTranslate']);
    for (const item of destructuredBindings(text, factories, 't', false, diagnostics, true)) result.push({ callee: item.name, ...(item.namespace ? { namespace: item.namespace } : {}), ...(item.namespaceDynamic ? { namespaceDynamic: true } : {}), kind: 'message' });
  } else if (format === 'next-international') {
    const factories = importedLocals(text, ['next-international', 'next-international/client'], ['useI18n']);
    for (const item of destructuredBindings(text, factories, 't', false, diagnostics, true)) result.push({ callee: item.name, ...(item.namespace ? { namespace: item.namespace } : {}), ...(item.namespaceDynamic ? { namespaceDynamic: true } : {}), kind: 'message' });
    const pattern = new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:${factoryPattern(factories)})\\s*\\(`, 'g'), mask = codeMask(text);
    for (const match of codeMatches(text, pattern)) {
      const open = match.index! + match[0].lastIndexOf('('), close = closingParenthesis(text, open, mask);
      if (close === undefined) { diagnostics.push({ callee: match[1]!, reason: 'translation factory call is unclosed; repair the source before migration', offset: match.index }); continue; }
      const dynamic = text.slice(open + 1, close).trim().length > 0;
      result.push({ callee: match[1]!, ...(dynamic ? { namespaceDynamic: true } : {}), kind: 'message' });
    }
  } else if (format === 'typesafe-i18n') {
    const factories = importedLocals(text, ['typesafe-i18n'], ['useI18nContext']);
    for (const item of destructuredBindings(text, factories, 'LL', false, diagnostics, true)) result.push({ callee: item.name, ...(item.namespace ? { namespace: item.namespace } : {}), ...(item.namespaceDynamic ? { namespaceDynamic: true } : {}), kind: 'direct' });
  } else if (format === 'svelte-i18n') {
    if (hasCodeMatch(text, /\bfrom\s*['"]svelte-i18n['"]/g)) {
      for (const local of importedLocals(text, ['svelte-i18n'], ['_', 't'])) result.push({ callee: `$${local}`, kind: 'message' });
      result.push({ callee: '$_', kind: 'message' }); result.push({ callee: '$t', kind: 'message' });
    }
  } else if (format === 'transloco') {
    const services = importedLocals(text, ['@jsverse/transloco', '@ngneat/transloco'], ['TranslocoService']);
    for (const service of services) for (const match of codeMatches(text, new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*inject\\(\\s*${factoryPattern(service)}\\s*\\)`, 'g'))) result.push({ callee: `${match[1]}.translate`, kind: 'message' });
    if (hasCodeMatch(text, /\bTranslocoService\b/g)) result.push({ callee: 'this.transloco.translate', kind: 'message' });
  } else {
    const services = importedLocals(text, ['@ngx-translate/core'], ['TranslateService']);
    for (const service of services) for (const match of codeMatches(text, new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*inject\\(\\s*${factoryPattern(service)}\\s*\\)`, 'g'))) result.push({ callee: `${match[1]}.instant`, kind: 'message' });
    if (hasCodeMatch(text, /\bTranslateService\b/g)) result.push({ callee: 'this.translate.instant', kind: 'message' });
  }
  const grouped = new Map<string, Binding[]>();
  for (const binding of result) grouped.set(binding.callee, [...(grouped.get(binding.callee) ?? []), binding]);
  const collapsed: Binding[] = [];
  for (const [callee, candidates] of grouped) {
    const fingerprints = new Set(candidates.map(candidate => JSON.stringify({ namespace: candidate.namespace ?? null, namespaceDynamic: candidate.namespaceDynamic ?? false, kind: candidate.kind })));
    const first = candidates[0]!;
    collapsed.push(fingerprints.size > 1 ? { ...first, ambiguous: true } : first);
  }
  return collapsed;
}

/** Angular service APIs are substantially broader than the one plain string
 * lookup that can be lowered to a generated message call. Report the known
 * observable/mutation methods instead of silently leaving a service runtime
 * behind after an otherwise static rewrite. */
function angularServiceDiagnostics(text: string, format: Exclude<CodemodFormat, 'auto'>, diagnostics: CodemodSkip[], parsedStarts?: ReadonlySet<number>): void {
  if (format !== 'transloco' && format !== 'ngx-translate') return;
  const serviceType = format === 'transloco' ? 'TranslocoService' : 'TranslateService';
  const variables = new Set<string>();
  const injectPattern = new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*inject\\(\\s*${serviceType}\\s*\\)`, 'g');
  for (const match of codeMatches(text, injectPattern)) variables.add(match[1]!);
  if (new RegExp(`\\b${serviceType}\\b`).test(text)) variables.add(format === 'transloco' ? 'this.transloco' : 'this.translate');
  const allowed = format === 'transloco' ? new Set(['translate']) : new Set(['instant']);
  for (const variable of variables) {
    const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b${escaped}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\(`, 'g');
    for (const match of codeMatches(text, pattern)) {
      if (parsedStarts && !parsedStarts.has(match.index!)) continue;
      const member = match[1]!;
      if (allowed.has(member)) continue;
      diagnostics.push({ callee: `${variable}.${member}`, reason: `${format} service member is not equivalent to a generated message call; migrate this Angular service API manually`, offset: match.index });
    }
  }
}

/** Merge adapter-supplied helper declarations with bindings proven directly
 * from source. Custom calls are deliberately folded before ambiguity is
 * collapsed; appending them after `bindings()` used to let a dynamic
 * declaration be paired with a static custom duplicate and rewrite it
 * unsafely. */
function mergeBindings(native: readonly Binding[], custom: readonly CustomTranslationCall[]): Binding[] {
  const all: Binding[] = [
    ...native.map(binding => ({ ...binding, provenance: binding.provenance ?? 'native' as const })),
    ...custom.map(call => ({
      callee: call.callee,
      ...(call.namespace ? { namespace: call.namespace } : {}),
      ...(call.namespaceDynamic ? { namespaceDynamic: true } : {}),
      provenance: 'custom' as const,
      kind: call.kind ?? 'message',
    } as Binding)),
  ];
  const grouped = new Map<string, Binding[]>();
  for (const binding of all) grouped.set(binding.callee, [...(grouped.get(binding.callee) ?? []), binding]);
  const collapsed: Binding[] = [];
  for (const [callee, candidates] of grouped) {
    const fingerprints = new Set(candidates.map(candidate => JSON.stringify({ namespace: candidate.namespace ?? null, namespaceDynamic: candidate.namespaceDynamic ?? false, kind: candidate.kind })));
    const first = candidates[0]!;
    const custom = candidates.find(candidate => candidate.provenance === 'custom');
    // Svelte's store adapter synthesizes `$t` even when no declaration exists.
    // When an explicit application proof names that same helper, retain the
    // custom provenance so parameter/local shadow checks can be bypassed. Any
    // differing semantic fingerprint (or pre-existing ambiguity) remains
    // fail-closed.
    collapsed.push(fingerprints.size > 1 || candidates.some(candidate => candidate.ambiguous)
      ? { ...first, ambiguous: true }
      : custom ?? first);
  }
  return collapsed;
}

/** Return the lexical brace stack at an offset. Translation helpers are
 * local bindings, not file-global names; comparing declaration and call
 * stacks prevents a hook in one component from capturing an unrelated call
 * in another function. */
function lexicalBlocks(text: string, offset: number, mask = codeMask(text)): number[] {
  const stack: number[] = [];
  for (let index = 0; index < offset; index++) {
    if (!mask[index]) continue;
    if (text[index] === '{') stack.push(index);
    else if (text[index] === '}') stack.pop();
  }
  return stack;
}

type BindingDeclarationScope = { start: number; block: number };

function bindingDeclarationScopes(text: string, name: string, mask = codeMask(text)): BindingDeclarationScope[] {
  if (!identifier.test(name)) return [];
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declaration = new RegExp(`\\b(?:const|let|var)\\s+(?:${escaped}\\b|\\{[^}\\n]*\\b${escaped}\\b[^}\\n]*\\})\\s*=`, 'g');
  const result: Array<{ start: number; block: number }> = [];
  for (const match of codeMatches(text, declaration, mask)) {
    const tail = text.slice(match.index!, Math.min(text.length, match.index! + 260));
    if (!/=\s*(?:await\s+)?(?:[A-Za-z_$][\w$]*\.)?(?:useTranslation|useTranslations|getTranslations|useIntl|useLingui|useI18n|useTranslate|useI18nContext|useT|getT|getI18n|inject|createI18nClient|createI18nServer)\s*\(/.test(tail)) continue;
    const stack = lexicalBlocks(text, match.index!, mask);
    result.push({ start: match.index!, block: stack.at(-1) ?? -1 });
  }
  return result;
}

function bindingScopeAvailable(text: string, callee: string, offset: number, mask = codeMask(text), cache?: Map<string, BindingDeclarationScope[]>): boolean {
  const base = callee.split('.')[0]!;
  let declarations = cache?.get(base);
  if (declarations === undefined) {
    declarations = bindingDeclarationScopes(text, base, mask);
    cache?.set(base, declarations);
  }
  // Explicit custom wrappers and imports without a local factory declaration
  // retain their historical behaviour; there is no scope proof to compare.
  if (!declarations.length) return true;
  const callBlocks = lexicalBlocks(text, offset, mask);
  return declarations.some(declaration => declaration.start < offset
    && (declaration.block < 0 || callBlocks.includes(declaration.block)));
}

function balancedBrace(text: string, open: number): number | undefined {
  const mask = codeMask(text); let depth = 0;
  for (let index = open; index < text.length; index++) {
    if (!mask[index]) continue;
    if (text[index] === '{') depth++; else if (text[index] === '}' && --depth === 0) return index;
  }
}

function openingJsxTag(source: string): string {
  let quote: 'single' | 'double' | undefined, braces = 0;
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!;
    if (quote) {
      if (character === '\\') { index++; continue; }
      if ((quote === 'single' && character === "'") || (quote === 'double' && character === '"')) quote = undefined;
      continue;
    }
    if (character === "'") { quote = 'single'; continue; }
    if (character === '"') { quote = 'double'; continue; }
    if (character === '{') { braces++; continue; }
    if (character === '}') { if (braces) braces--; continue; }
    if (character === '>' && braces === 0) return source.slice(0, index + 1);
  }
  return source;
}

/** Return a top-level JSX attribute value. Nested object fields such as
 * `values={{id: 'nested'}}` are deliberately ignored. Undefined means the
 * attribute is absent or not statically representable. */
function jsxAttribute(source: string, name: string): string | undefined {
  return jsxField(source, name)?.value;
}

/** A JSX attribute's value and whether it was written as an `{expression}`. */
function jsxField(source: string, name: string): { value: string | undefined; expression: boolean } | undefined {
  const tag = openingJsxTag(source);
  const tagName = /^\s*<([A-Za-z_$][\w$:.!-]*)/.exec(tag)?.[1];
  if (!tagName) return;
  let index = tag.indexOf(tagName) + tagName.length;
  while (index >= tagName.length && index < tag.length) {
    while (/\s/.test(tag[index] ?? '')) index++;
    if (tag[index] === '/' || tag[index] === '>') break;
    const field = /^([A-Za-z_$][\w$:.!-]*)/.exec(tag.slice(index));
    if (!field) { index++; continue; }
    const fieldName = field[1]!, fieldStart = index;
    index += fieldName.length;
    while (/\s/.test(tag[index] ?? '')) index++;
    if (tag[index] !== '=') {
      if (fieldName === name) return { value: '', expression: false };
      continue;
    }
    index++;
    while (/\s/.test(tag[index] ?? '')) index++;
    const valueStart = index, quote = tag[index];
    let value: string | undefined;
    if (quote === "'" || quote === '"') {
      index++;
      while (index < tag.length) {
        if (tag[index] === '\\') { index += 2; continue; }
        if (tag[index] === quote) break;
        index++;
      }
      value = index < tag.length ? tag.slice(valueStart + 1, index) : undefined;
      index++;
    } else if (quote === '{') {
      let depth = 0, nestedQuote: 'single' | 'double' | 'template' | undefined;
      for (; index < tag.length; index++) {
        const character = tag[index]!;
        if (nestedQuote) {
          if (character === '\\') { index++; continue; }
          if ((nestedQuote === 'single' && character === "'") || (nestedQuote === 'double' && character === '"') || (nestedQuote === 'template' && character === '`')) nestedQuote = undefined;
          continue;
        }
        if (character === "'") { nestedQuote = 'single'; continue; }
        if (character === '"') { nestedQuote = 'double'; continue; }
        if (character === '`') { nestedQuote = 'template'; continue; }
        if (character === '{') depth++;
        else if (character === '}' && --depth === 0) { value = tag.slice(valueStart + 1, index).trim(); index++; break; }
      }
    } else {
      while (index < tag.length && !/\s|\//.test(tag[index]!)) index++;
      value = tag.slice(valueStart, index);
    }
    if (fieldName === name) return { value, expression: quote === '{' };
    // Keep `fieldStart` explicit to make it clear that this scanner advances
    // one complete top-level field at a time; it also avoids a future lint
    // regression when the parser gains spread-attribute handling.
    void fieldStart;
  }
  return undefined;
}

/** A JSX `id`: its string (`id="x"`, `id={'x'}`, id={`x`}), or the expression it is set to. */
function jsxIdAttribute(source: string): { id?: string; expression?: string } {
  const field = jsxField(source, 'id');
  if (!field || field.value === undefined) return {};
  if (!field.expression) return { id: field.value };
  const id = staticString(field.value);
  return id !== undefined ? { id } : { expression: field.value };
}

const voidElements = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/** Lingui's `components` prop (`[<a href="/x" />]` or `{{ 0: <a /> }}`) as rich() slot callbacks.
 * A message's `<N>…</N>` renders element N with the message's children; `<N/>` and an empty
 * `<N></N>` render it as written, as Lingui's formatElements does. An HTML element without
 * children of its own renders the same either way. Undefined when an entry is not a JSX element. */
function linguiSlots(expression: string | undefined): string[] | undefined {
  if (!expression) return;
  let node: AstNode;
  try { node = parseExpression(expression, { plugins: ['typescript', 'jsx'] }) as unknown as AstNode; }
  catch { return; }
  const entries: Array<[number, AstNode]> = [];
  if (node.type === 'ArrayExpression') (node.elements as Array<AstNode | null>).forEach((item, index) => { if (item) entries.push([index, item]); });
  else if (node.type === 'ObjectExpression') for (const property of node.properties as AstNode[]) {
    const key = property.key as (AstNode & { value?: unknown; name?: unknown }) | undefined;
    const index = property.type === 'ObjectProperty' && !property.computed ? Number(key?.type === 'Identifier' ? key.name : key?.value) : NaN;
    if (!Number.isInteger(index) || index < 0) return;
    entries.push([index, property.value as AstNode]);
  } else return;
  const slots: string[] = [];
  for (const [index, element] of entries) {
    if (element.type !== 'JSXElement') return;
    const opening = element.openingElement as AstNode & { selfClosing?: boolean; name: AstNode };
    const source = expression.slice(element.start!, element.end!), name = expression.slice(opening.name.start!, opening.name.end!);
    const head = expression.slice(opening.start!, opening.end!).replace(/\s*\/>$/, '>');
    const withChildren = `${head}{children}</${name}>`;
    slots.push(`tag${index}: ${opening.selfClosing && voidElements.has(name) ? `() => ${source}`
      : opening.selfClosing && /^[a-z]/.test(name) ? `(children) => ${withChildren}`
      : `(children) => children.length ? ${withChildren} : ${source}`}`);
  }
  return slots;
}

type JsxContext = {
  sourceIds?: ReadonlyMap<string, string>; allowedIds?: ReadonlySet<string>; renamed: (id: string) => string;
  jsxStarts?: ReadonlySet<number>; jsxChildStarts?: ReadonlySet<number>; jsxStatementStarts?: ReadonlySet<number>; jsxElements?: ReadonlyMap<number, JsxElementBounds>;
  messageComponent?: string; richIds?: ReadonlySet<string>;
};

function jsxReplacements(text: string, format: Exclude<CodemodFormat, 'auto'>, root: string, mask: Uint8Array, skipped: CodemodSkip[], context: JsxContext): Replacement[] {
  const { sourceIds, allowedIds, renamed, jsxStarts, jsxChildStarts, jsxElements } = context;
  const expressionContext = (start: number): boolean => jsxExpressionContext(text, start, jsxChildStarts, context.jsxStatementStarts, jsxElements);
  const component = format === 'formatjs' ? 'FormattedMessage' : format === 'lingui' || format === 'i18next' ? 'Trans' : undefined;
  const idAttribute = format === 'i18next' ? 'i18nKey' : 'id';
  const proven = format === 'formatjs' ? hasCodeMatch(text, /(?:\bfrom\s*['"]react-intl['"]|\buseIntl\s*\()/g)
    : format === 'lingui' ? hasCodeMatch(text, /(?:\bfrom\s*['"]@lingui\/|\buseLingui\s*\()/g)
    : format === 'i18next' ? hasCodeMatch(text, /(?:\bfrom\s*['"](?:react-i18next|next-i18next)['"]|\buseTranslation\s*\()/g) : false;
  if (!component || !proven) return [];
  const modules = format === 'formatjs' ? ['react-intl'] : format === 'lingui' ? ['@lingui/react', '@lingui/react/macro'] : ['react-i18next', 'next-i18next'];
  const components = [...new Set([component, ...importedLocals(text, modules, [component])])];
  if (!components.some(item => new RegExp(`\\b${item}\\b`).test(text))) return [];
  const componentPattern = components.map(item => item.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')).join('|');
  const result: Replacement[] = [], pattern = new RegExp(`<(?:(?:${componentPattern}))\\b[\\s\\S]*?\\/>|<(?:(?:${componentPattern}))\\b(?:[^>"']|"[^"]*"|'[^']*')*>([\\s\\S]*?)<\\/(?:${componentPattern})\\s*>`, 'g');
  // The pattern ends an element at its first `/>`, which may belong to a nested element
  // (`components={[<br />]}`) or a later one, so parsed source walks its elements instead.
  const head = new RegExp(`<(?:${componentPattern})(?![\\w$.:-])`, 'y');
  const elements = jsxElements
    ? [...jsxElements.keys()].sort((left, right) => left - right).filter(start => { head.lastIndex = start; return head.test(text); }).map(start => ({ 0: '', 1: undefined, index: start }))
    : [...text.matchAll(pattern)].map(found => ({ 0: found[0], 1: found[1], index: found.index! }));
  for (const found of elements) {
    if (jsxStarts && !jsxStarts.has(found.index)) continue;
    const bounds = jsxElements?.get(found.index);
    const match: { 0: string; 1: string | undefined; index: number } = bounds
      ? { 0: text.slice(found.index, bounds.end), 1: bounds.closingStart === undefined ? undefined : text.slice(bounds.openingEnd, bounds.closingStart), index: found.index }
      : found;
    if (!mask[match.index!] && !jsxStarts?.has(match.index!)) {
      skipped.push({ callee: /^<([A-Za-z_$][\w$]*)/.exec(match[0])?.[1] ? `<${/^<([A-Za-z_$][\w$]*)/.exec(match[0])![1]}>` : '<message>', reason: 'component range is not provably executable JSX; review this component manually', offset: match.index });
      continue;
    }
    const componentName = /^<([A-Za-z_$][\w$]*)/.exec(match[0])?.[1] ?? component;
    const children = match[1];
    if (children !== undefined && /[<{]/.test(children)) {
      skipped.push({ callee: `<${componentName}>`, reason: 'non-self-closing component contains rich or expression children', offset: match.index });
      continue;
    }
    // An element outside any component renders lazily, in the current locale; a call there would
    // run once (at import, for module scope) or need an m no hook can bind. With a message
    // component it stays an element; without one, the caller owns m and the call stays as before.
    const outside = context.messageComponent !== undefined && (bounds?.owner === 'module' || bounds?.owner === 'function');
    const opening = text.slice(match.index!, bounds ? bounds.openingEnd : match.index! + match[0].indexOf('>'));
    // Lingui components passed by reference (`components={[link]}`) cannot be rebuilt around the
    // message's children; that matters only when the message has tags, decided below.
    const components = format === 'lingui' ? jsxAttribute(match[0], 'components') : undefined;
    const slots = components !== undefined ? linguiSlots(components) : undefined;
    if (opening.slice(componentName.length + 1).includes('<') && (!slots || (format === 'lingui' && jsxAttribute(match[0], 'render') !== undefined))) {
      skipped.push({ callee: `<${componentName}>`, reason: 'component contains nested JSX and requires a rich-component migration', offset: match.index });
      continue;
    }
    const idField = idAttribute === 'id' ? jsxIdAttribute(match[0]) : { id: new RegExp(`\\b${idAttribute}\\s*=\\s*(['"])([^'"\\\\]*)\\1`).exec(match[0])?.[2]
      ?? new RegExp(`\\b${idAttribute}\\s*=\\s*\\{\\s*(['"])([^'"\\\\]*)\\1\\s*\\}`).exec(match[0])?.[2] };
    if (format === 'lingui' && idField.expression !== undefined && !slots) {
      // A finite conditional (`id={open ? 'a' : 'b'}`) lowers to one static call per branch.
      const values = jsxAttribute(match[0], 'values');
      const lowered = values?.includes('<') || jsxAttribute(match[0], 'render') !== undefined ? undefined : conditionalMessageCall(idField.expression, localId => {
        const id = renamed(localId);
        return allowedIds && !allowedIds.has(id) ? undefined : `${messageAccess(root, id)}(${values ?? ''})`;
      });
      if (!lowered) { skipped.push({ callee: `<${componentName}>`, reason: `component id is the expression ${idField.expression}, so the message key is dynamic`, offset: match.index }); continue; }
      result.push({ start: match.index!, end: match.index! + match[0].length, text: outside ? `<${context.messageComponent} render={(${root}) => ${lowered}} />` : expressionContext(match.index!) ? lowered : `{${lowered}}` });
      continue;
    }
    const localId = idField.id ?? (format === 'lingui' && children !== undefined ? sourceIds?.get(children.trim()) : undefined);
    if (!localId || !/^[^{}]+$/.test(localId)) { skipped.push({ callee: `<${componentName}>`, reason: 'component has no static id', offset: match.index }); continue; }
    const keyParts = format === 'i18next' ? splitI18nextNamespace(localId) : { key: localId };
    if (!keyParts) { skipped.push({ callee: `<${componentName}>`, reason: `i18next key ${JSON.stringify(localId)} has an unsupported namespace separator; migrate this component manually`, offset: match.index, code: 'UNSUPPORTED_NAMESPACE_SYNTAX' }); continue; }
    const namespace = format === 'i18next' ? jsxAttribute(match[0], 'ns') : undefined;
    const prefix = keyParts.namespace ?? (namespace && /^[^{}'"\s]+$/.test(namespace) ? namespace : undefined);
    const id = renamed(prefix ? `${prefix}.${keyParts.key}` : keyParts.key);
    if (allowedIds && !allowedIds.has(id)) { skipped.push({ callee: `<${componentName}>`, reason: `message id ${JSON.stringify(id)} is absent from generated message types`, offset: match.index, code: 'UNKNOWN_MESSAGE_ID' }); continue; }
    let values = jsxAttribute(match[0], 'values');
    const tagName = jsxAttribute(match[0], 'tagName');
    if (tagName) { skipped.push({ callee: `<${componentName}>`, reason: 'component tagName changes rendered markup and requires a rich-component migration', offset: match.index }); continue; }
    if (values?.includes('<')) { skipped.push({ callee: `<${componentName}>`, reason: 'component values contain JSX and require a rich-component migration', offset: match.index }); continue; }
    const count = format === 'i18next' ? jsxAttribute(match[0], 'count') : undefined;
    if (count) values = values ? `{...(${values}),count:${count}}` : `{count:${count}}`;
    if (format === 'lingui' && jsxAttribute(match[0], 'render') !== undefined) { skipped.push({ callee: `<${componentName}>`, reason: 'component render prop changes rendered markup and requires a rich-component migration', offset: match.index }); continue; }
    // A message without tags in the base catalog never used its components.
    const richCall = components !== undefined && (!context.richIds || context.richIds.has(id));
    if (richCall && !slots) { skipped.push({ callee: `<${componentName}>`, reason: 'component passes its components by reference and requires a rich-component migration', offset: match.index }); continue; }
    const objectValues = values !== undefined && /^\{[\s\S]*\}$/.test(values.trim()) ? values.trim().slice(1, -1).trim().replace(/,$/, '') : undefined;
    const call = richCall
      ? `rich(${messageAccess(root, id)}, { ${[...(values === undefined ? [] : objectValues !== undefined ? (objectValues ? [objectValues] : []) : [`...${values}`]), ...slots!].join(', ')} })`
      : `${messageAccess(root, id)}(${values ?? ''})`;
    result.push({ start: match.index!, end: match.index! + match[0].length, ...(richCall ? { rich: true } : {}),
      text: outside ? `<${context.messageComponent} render={(${root}) => ${call}} />` : expressionContext(match.index!) ? call : `{${call}}` });
  }
  return result;
}

/** Whether a call can replace the element as written, or needs `{…}` around it: a JSX child
 * or attribute value does. Parsed source says so exactly, even past a comment; otherwise the
 * preceding token decides. */
function jsxExpressionContext(text: string, start: number, jsxChildStarts?: ReadonlySet<number>, jsxStatementStarts?: ReadonlySet<number>, jsxElements?: ReadonlyMap<number, JsxElementBounds>): boolean {
  // A statement keeps its braces, as a block: `{m.x()};`.
  if (jsxElements?.has(start)) return !jsxChildStarts?.has(start) && !jsxStatementStarts?.has(start);
  if (jsxChildStarts?.has(start)) return false;
  return /(?:[({[=?:,]|=>|&&|\|\||\b(?:return|export\s+default|yield|await|throw))\s*$/.test(text.slice(0, start).trimEnd());
}

type SvelteScriptBlock = { start: number; end: number; module: boolean };

function moduleChildren(node: AstNode, key: string): AstNode[] {
  return Array.isArray(node[key])
    ? (node[key] as unknown[]).filter((item): item is AstNode => !!item && typeof item === 'object' && typeof (item as AstNode).type === 'string')
    : [];
}

function moduleChild(node: AstNode, key: string): AstNode | undefined {
  const value = node[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AstNode : undefined;
}

function moduleIdentifierName(node: AstNode | undefined): string | undefined {
  if (!node) return;
  if (node.type === 'Identifier' && typeof node.name === 'string') return node.name;
  if (node.type === 'StringLiteral' && typeof node.value === 'string') return node.value;
}

function moduleImportSource(node: AstNode): string | undefined {
  const source = moduleChild(node, 'source');
  return typeof source?.value === 'string' ? source.value : undefined;
}

function moduleParser(text: string): AstNode {
  return parse(text, { sourceType: 'unambiguous', errorRecovery: false, plugins: ['typescript', 'jsx', 'decorators-legacy', 'importAttributes'] }).program as unknown as AstNode;
}

function escapedRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function quoteModuleSpecifier(specifier: string, quote: "'" | '"'): string {
  return quote + specifier.replaceAll('\\', '\\\\').replaceAll(quote, '\\' + quote) + quote;
}

function importQuote(text: string, node: AstNode | undefined): "'" | '"' {
  const source = node ? moduleChild(node, 'source') : undefined;
  const first = typeof source?.start === 'number' ? text[source.start] : undefined;
  return first === '"' ? '"' : "'";
}

function moduleInsertionOffset(text: string, program: AstNode, imports: readonly AstNode[]): number {
  const firstImport = imports.find(item => typeof item.start === 'number');
  if (firstImport?.start !== undefined) return firstImport.start;
  const directives = moduleChildren(program, 'directives');
  const lastDirective = directives.at(-1);
  if (lastDirective?.end !== undefined) {
    const lineEnd = text.indexOf('\n', lastDirective.end);
    return lineEnd < 0 ? text.length : lineEnd + 1;
  }
  if (text.startsWith('#!')) {
    const lineEnd = text.indexOf('\n');
    return lineEnd < 0 ? text.length : lineEnd + 1;
  }
  return 0;
}

function patternContainsIdentifier(pattern: AstNode | undefined, name: string): boolean {
  if (!pattern) return false;
  if (pattern.type === 'Identifier') return pattern.name === name;
  if (pattern.type === 'RestElement' || pattern.type === 'AssignmentPattern' || pattern.type === 'TSParameterProperty') {
    return patternContainsIdentifier(moduleChild(pattern, pattern.type === 'AssignmentPattern' ? 'left' : pattern.type === 'TSParameterProperty' ? 'parameter' : 'argument'), name);
  }
  if (pattern.type === 'ObjectPattern' || pattern.type === 'ArrayPattern') {
    for (const item of moduleChildren(pattern, pattern.type === 'ObjectPattern' ? 'properties' : 'elements')) {
      if (item.type === 'ObjectProperty') {
        if (patternContainsIdentifier(moduleChild(item, 'value') ?? moduleChild(item, 'argument'), name)) return true;
      } else if (patternContainsIdentifier(item, name)) return true;
    }
  }
  return false;
}

function hasTopLevelBinding(program: AstNode, name: string): boolean {
  const declarationBinds = (node: AstNode): boolean => {
    if (node.type === 'VariableDeclaration') return moduleChildren(node, 'declarations').some(item => patternContainsIdentifier(moduleChild(item, 'id'), name));
    if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration' || node.type === 'TSEnumDeclaration' || node.type === 'TSModuleDeclaration') return moduleIdentifierName(moduleChild(node, 'id')) === name;
    return false;
  };
  for (const item of moduleChildren(program, 'body')) {
    if (declarationBinds(item)) return true;
    const declaration = moduleChild(item, 'declaration');
    if ((item.type === 'ExportNamedDeclaration' || item.type === 'ExportDefaultDeclaration') && declaration && declarationBinds(declaration)) return true;
  }
  return false;
}

function insertMessagesImport(text: string, local: string, specifier: string): string {
  if (!specifier.trim() || /[\r\n]/.test(specifier)) throw new TypeError('messagesImport must be a nonempty module specifier without line breaks.');
  let program: AstNode;
  try { program = moduleParser(text); }
  catch (error) { throw new Error('cannot add messages import because the script does not parse: ' + (error as Error).message); }
  const imports = moduleChildren(program, 'body').filter(item => item.type === 'ImportDeclaration');
  const exact = imports.filter(item => moduleImportSource(item) === specifier);
  const isTypeOnly = (node: AstNode, specifierNode?: AstNode): boolean => node.importKind === 'type' || specifierNode?.importKind === 'type';
  const specifiers = (node: AstNode): AstNode[] => moduleChildren(node, 'specifiers');
  const localName = (specifierNode: AstNode): string | undefined => moduleIdentifierName(moduleChild(specifierNode, 'local'));
  const importedName = (specifierNode: AstNode): string | undefined => moduleIdentifierName(moduleChild(specifierNode, 'imported'));

  // A value binding with the requested local name from another module (or an
  // alias that happens to use the same local) would make the generated import
  // syntactically invalid. Fail closed rather than guessing which value wins.
  for (const declaration of imports) {
    for (const item of specifiers(declaration)) {
      if (localName(item) !== local || isTypeOnly(declaration, item)) continue;
      if (item.type !== 'ImportSpecifier' || importedName(item) !== local) {
        throw new Error('cannot add messages import: local identifier ' + local + ' is already bound by another value import');
      }
    }
  }
  if (hasTopLevelBinding(program, local)) {
    throw new Error('cannot add messages import: local identifier ' + local + ' is already declared in this module');
  }
  const typeOnlyLocal = imports.some(declaration => specifiers(declaration).some(item => localName(item) === local && isTypeOnly(declaration, item)));
  if (typeOnlyLocal) {
    throw new Error('cannot add messages import: local identifier ' + local + ' is already bound by a type-only import');
  }
  for (const declaration of exact) {
    if (declaration.importKind === 'type') continue;
    for (const item of specifiers(declaration)) {
      if (item.type !== 'ImportSpecifier' || isTypeOnly(declaration, item)) continue;
      if (localName(item) === local && importedName(item) === local) return text;
    }
  }

  // Merge into a value import from the requested module whenever that import
  // has named/default specifiers. Namespace and side-effect imports cannot be
  // extended, so a separate named value import is emitted below.
  const merge = exact.find(item => item.importKind !== 'type' && specifiers(item).length > 0 && !specifiers(item).some(specifierNode => specifierNode.type === 'ImportNamespaceSpecifier'));
  if (merge) {
    const items = specifiers(merge), named = items.filter(item => item.type === 'ImportSpecifier');
    if (named.length) {
      const last = named.at(-1)!;
      if (last.end === undefined) throw new Error('cannot add messages import: malformed import specifier');
      return text.slice(0, last.end) + ', ' + local + text.slice(last.end);
    }
    const defaultSpecifier = items.find(item => item.type === 'ImportDefaultSpecifier');
    if (defaultSpecifier?.end !== undefined) {
      return text.slice(0, defaultSpecifier.end) + ', { ' + local + ' }' + text.slice(defaultSpecifier.end);
    }
  }
  // A side-effect import of the module becomes the named import; both run the module.
  const bare = exact.find(item => item.importKind !== 'type' && specifiers(item).length === 0);
  const bareSource = bare ? moduleChild(bare, 'source') : undefined;
  if (bare?.start !== undefined && bareSource?.start !== undefined) {
    return text.slice(0, bare.start) + 'import { ' + local + ' } from ' + text.slice(bareSource.start);
  }

  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const quote = importQuote(text, exact[0] ?? imports[0]);
  const importText = 'import { ' + local + ' } from ' + quoteModuleSpecifier(specifier, quote) + ';' + newline;
  const offset = moduleInsertionOffset(text, program, imports);
  return text.slice(0, offset) + importText + text.slice(offset);
}

function moveTypeImportsInModule(text: string, format: CodemodFormat, names: readonly string[], target: string): { code: string; moved: number } {
  if (!target.trim() || /[\r\n]/.test(target)) throw new TypeError('messagesImport must be a nonempty module specifier without line breaks.');
  const requested = new Set(names);
  for (const name of requested) if (!identifier.test(name)) throw new TypeError(`moveTypeImports contains an invalid imported type name: ${JSON.stringify(name)}`);
  if (!requested.size) return { code: text, moved: 0 };
  const program = moduleParser(text), imports = moduleChildren(program, 'body').filter(item => item.type === 'ImportDeclaration');
  const normalized = normalizeFormat(format);
  const formats = normalized === 'auto' ? concreteFormats : [normalized as Exclude<CodemodFormat, 'auto'>];
  const incumbent = formats.flatMap(activeFormat => incumbentPackages[activeFormat] ?? []);
  const candidates = new Map<AstNode, AstNode[]>(), additions: string[] = [];
  for (const declaration of imports) {
    const source = moduleImportSource(declaration);
    if (!source || source === target || !incumbent.some(pattern => pattern.test(source))) continue;
    for (const specifier of moduleChildren(declaration, 'specifiers')) {
      if (specifier.type !== 'ImportSpecifier') continue;
      const imported = moduleIdentifierName(moduleChild(specifier, 'imported'));
      if (!imported || !requested.has(imported)) continue;
      if (declaration.importKind !== 'type' && specifier.importKind !== 'type') continue;
      const group = candidates.get(declaration) ?? [];
      group.push(specifier); candidates.set(declaration, group);
      additions.push(text.slice(specifier.start!, specifier.end!).replace(/^type\s+/, ''));
    }
  }
  if (!additions.length) return { code: text, moved: 0 };

  const removals: Replacement[] = [];
  const trimWholeLine = (replacement: Replacement): Replacement => {
    const lineStart = text.lastIndexOf('\n', replacement.start - 1) + 1;
    const lineEnd = text.indexOf('\n', replacement.end);
    const end = lineEnd < 0 ? text.length : lineEnd;
    if (text.slice(lineStart, replacement.start).trim() || text.slice(replacement.end, end).trim()) return replacement;
    return { start: lineStart, end: lineEnd < 0 ? end : lineEnd + 1, text: '' };
  };
  for (const [declaration, selected] of candidates) {
    const list = moduleChildren(declaration, 'specifiers');
    const indexes = selected.map(item => list.indexOf(item)).sort((left, right) => left - right);
    if (indexes.length === list.length) {
      removals.push(trimWholeLine({ start: declaration.start!, end: declaration.end!, text: '' }));
      continue;
    }
    let first = indexes[0]!, previous = first;
    const flush = (last: number): void => {
      const left = first > 0 ? list[first - 1]!.end! : list[first]!.start!;
      // Remove either the preceding comma or the following comma, never both.
      // Taking both separators would concatenate the surrounding specifiers.
      const right = first > 0 ? list[last]!.end!
        : last < list.length - 1 ? list[last + 1]!.start! : list[last]!.end!;
      removals.push({ start: left, end: right, text: '' });
    };
    for (let index = 1; index < indexes.length; index++) {
      const current = indexes[index]!;
      if (current !== previous + 1) { flush(previous); first = current; }
      previous = current;
    }
    flush(previous);
  }
  removals.sort((left, right) => right.start - left.start);
  let code = text;
  for (const removal of removals) code = code.slice(0, removal.start) + code.slice(removal.end);
  const updatedProgram = moduleParser(code);
  const updatedImports = moduleChildren(updatedProgram, 'body').filter(item => item.type === 'ImportDeclaration');
  const newline = code.includes('\r\n') ? '\r\n' : '\n';
  const quote = importQuote(code, updatedImports.find(item => moduleImportSource(item) === target) ?? updatedImports[0]);
  const unique = [...new Set(additions)];
  const importText = `import type { ${unique.join(', ')} } from ${quoteModuleSpecifier(target, quote)};${newline}`;
  const offset = moduleInsertionOffset(code, updatedProgram, updatedImports);
  code = code.slice(0, offset) + importText + code.slice(offset);
  moduleParser(code);
  return { code, moved: additions.length };
}

function svelteScriptBlocks(text: string): SvelteScriptBlock[] {
  const blocks: SvelteScriptBlock[] = [];
  const lexicalMask = codeMask(text);
  const opening = /<script\b/gi;
  const closing = /<\/script\s*>/gi;
  for (const match of text.matchAll(opening)) {
    if (!lexicalMask[match.index!]) continue;
    const commentStart = text.lastIndexOf('<!--', match.index!);
    if (commentStart > text.lastIndexOf('-->', match.index!)) continue;
    let start = match.index! + match[0].length;
    let quote: "'" | '"' | undefined;
    for (; start < text.length; start++) {
      const character = text[start]!;
      if (quote) {
        if (character === quote && text[start - 1] !== '\\') quote = undefined;
      } else if (character === "'" || character === '"') quote = character;
      else if (character === '>') { start++; break; }
    }
    if (start > text.length || text[start - 1] !== '>') throw new Error('cannot add messages import because a Svelte script tag is unclosed');
    const openingText = text.slice(match.index!, start);
    closing.lastIndex = start;
    let endMatch: RegExpExecArray | null = null;
    for (const candidate of text.matchAll(closing)) {
      if (candidate.index! < start) continue;
      if (!lexicalMask[candidate.index!]) continue;
      endMatch = candidate;
      break;
    }
    if (!endMatch) throw new Error('cannot add messages import because a Svelte script block is unclosed');
    const module = /\bcontext\s*=\s*(['"])module\1/i.test(openingText) || /\bmodule(?:\s|>|$)/i.test(openingText);
    blocks.push({ start, end: endMatch.index, module });
  }
  return blocks;
}

function svelteFallbackImportModules(text: string): readonly string[] {
  if (!hasCodeMatch(text, /\bfrom\s*['"]svelte-i18n['"]/g)) return [];
  const locals = importedLocals(text, ['svelte-i18n'], ['_', 't'], false);
  // A custom `$t` parameter can remain in a function declaration after every
  // proven call has been lowered (and is renamed by cleanup below). Only a
  // residual store invocation needs the native runtime as a fallback. This
  // avoids retaining the whole framework import merely because the declaration
  // itself still contains the `$t` spelling.
  const residualStore = locals.some(local => new RegExp('\\$' + escapedRegExp(local) + '\\s*(?:\\?\\.\\s*)?\\(').test(text));
  return residualStore ? ['svelte-i18n'] : [];
}

function cleanupSvelteFormatterBindings(text: string, format: CodemodFormat, rewritten: number, provenNames: readonly string[], explicitNames: readonly string[]): { code: string; diagnostics: CodemodSkip[] } {
  const blocks = svelteScriptBlocks(text), preserveModules = svelteFallbackImportModules(text);
  let result = text;
  const diagnostics: CodemodSkip[] = [];
  for (const block of [...blocks].sort((left, right) => right.start - left.start)) {
    const body = result.slice(block.start, block.end);
    const cleanup = cleanupFormatterBindings(body, format, rewritten, provenNames, explicitNames, preserveModules);
    result = result.slice(0, block.start) + cleanup.code + result.slice(block.end);
    diagnostics.push(...cleanup.diagnostics);
  }
  return { code: result, diagnostics };
}

function insertSvelteMessagesImport(text: string, local: string, specifier: string): string {
  const blocks = svelteScriptBlocks(text);
  const access = new RegExp('(?:^|[^A-Za-z0-9_$])' + escapedRegExp(local) + '\\s*(?:\\.|\\[)');
  const targets = blocks.map((block, index) => access.test(text.slice(block.start, block.end)) ? index : -1).filter(index => index >= 0);
  let outsideAccess = false;
  let cursor = 0;
  for (const block of blocks) {
    if (access.test(text.slice(cursor, block.start))) outsideAccess = true;
    cursor = block.end;
  }
  if (access.test(text.slice(cursor))) outsideAccess = true;
  const instance = blocks.findIndex(block => !block.module);
  let addInstanceScript = false;
  if (outsideAccess && instance >= 0) targets.push(instance);
  else if (outsideAccess) addInstanceScript = true;
  if (!targets.length && instance >= 0) targets.push(instance);
  else if (!targets.length) addInstanceScript = true;
  let result = text;
  for (const index of [...new Set(targets)].sort((left, right) => right - left)) {
    const block = blocks[index]!;
    const body = result.slice(block.start, block.end);
    const updated = insertMessagesImport(body, local, specifier);
    result = result.slice(0, block.start) + updated + result.slice(block.end);
  }
  if (addInstanceScript) result = '<script>\nimport { ' + local + ' } from ' + quoteModuleSpecifier(specifier, "'") + ';\n</script>\n' + result;
  return result;
}

function ensureMessagesImport(text: string, filename: string | undefined, local: string, specifier: string): string {
  const lower = filename?.toLowerCase();
  if (lower?.endsWith('.svelte')) return insertSvelteMessagesImport(text, local, specifier);
  if (filename && !/(?:^|\.)[cm]?[jt]sx?$/.test(lower!)) throw new Error('messagesImport is supported only for JavaScript/TypeScript files and Svelte components');
  return insertMessagesImport(text, local, specifier);
}

function moveTypeImports(text: string, filename: string | undefined, format: CodemodFormat, names: readonly string[], target: string): { code: string; moved: number } {
  if (filename?.toLowerCase().endsWith('.svelte')) {
    let code = text, moved = 0;
    for (const block of [...svelteScriptBlocks(text)].sort((left, right) => right.start - left.start)) {
      const result = moveTypeImportsInModule(code.slice(block.start, block.end), format, names, target);
      code = code.slice(0, block.start) + result.code + code.slice(block.end);
      moved += result.moved;
    }
    return { code, moved };
  }
  if (filename && !/(?:^|\.)[cm]?[jt]sx?$/.test(filename.toLowerCase())) return { code: text, moved: 0 };
  return moveTypeImportsInModule(text, format, names, target);
}

function validateCodemodOutput(text: string, filename: string | undefined): void {
  if (filename?.toLowerCase().endsWith('.svelte')) {
    for (const block of svelteScriptBlocks(text)) moduleParser(text.slice(block.start, block.end));
    return;
  }
  if (!filename || /(?:^|\.)[cm]?[jt]sx?$/.test(filename.toLowerCase())) moduleParser(text);
}

function svelteI18nValues(argument: string | undefined): { values?: string; unsupported?: string } {
  const source = argument?.trim();
  if (!source) return {};
  const prefix = 'const __nordbeam_svelte_values = ';
  let program: AstNode;
  try { program = moduleParser(prefix + source + ';'); }
  catch { return { values: source }; }
  const declaration = moduleChildren(program, 'body').find(item => item.type === 'VariableDeclaration');
  const declarator = declaration ? moduleChildren(declaration, 'declarations')[0] : undefined;
  const initializer = declarator ? moduleChild(declarator, 'init') : undefined;
  if (initializer?.type !== 'ObjectExpression') return { values: source };
  const properties = moduleChildren(initializer, 'properties');
  if (properties.length !== 1 || properties[0]?.type !== 'ObjectProperty' || properties[0]?.computed) {
    return { unsupported: 'second argument has Svelte i18n metadata beyond the values wrapper' };
  }
  const property = properties[0]!;
  const key = moduleIdentifierName(moduleChild(property, 'key'));
  const value = moduleChild(property, 'value');
  if (key !== 'values' || !value || value.start === undefined || value.end === undefined) {
    return { unsupported: 'second argument is not a values-only wrapper' };
  }
  return { values: source.slice(value.start - prefix.length, value.end - prefix.length).trim() };
}

type CleanupConfig = { modules: readonly string[]; factories?: readonly string[]; properties?: readonly string[]; direct?: readonly string[]; services?: readonly string[] };
type CleanupImport = { node: AstNode; specifier: AstNode; imported?: string; local: string; module: string };

/**
 * Remove only framework bindings whose references disappeared as a result of
 * a proven call rewrite. This deliberately uses a tiny lexical resolver
 * instead of a text-wide identifier count: an inner `t` must not keep (or
 * make us delete) an outer formatter binding, and exported bindings are part
 * of the public API even when their local call was lowered.
 */
function cleanupFormatterBindings(text: string, format: CodemodFormat, rewritten: number, provenNames: readonly string[], explicitNames: readonly string[] = [], preserveImportModules: readonly string[] = [], messagesBinding?: { readonly local: string; readonly hook: string }): { code: string; diagnostics: CodemodSkip[]; hookBindings?: number } {
  if (!rewritten) return { code: text, diagnostics: [] };
  let ast: AstNode;
  try {
    ast = parse(text, { sourceType: 'unambiguous', errorRecovery: false, plugins: ['typescript', 'jsx', 'decorators-legacy', 'importAttributes'] }).program as unknown as AstNode;
  } catch { return { code: text, diagnostics: [] }; }

  const normalized = normalizeFormat(format);
  const formats = normalized === 'auto' ? concreteFormats : [normalized as Exclude<CodemodFormat, 'auto'>];
  const configs: CleanupConfig[] = [];
  const add = (config: CleanupConfig): void => { configs.push(config); };
  for (const active of formats) {
    if (active === 'next-intl') add({ modules: ['next-intl', 'next-intl/server'], factories: ['useTranslations', 'getTranslations'] });
    else if (active === 'i18next') add({ modules: ['react-i18next', 'next-i18next', 'i18next'], factories: ['useTranslation'], properties: ['t'], direct: ['t', 'Trans'] });
    else if (active === 'formatjs') add({ modules: ['react-intl'], factories: ['useIntl'], properties: ['formatMessage'], direct: ['FormattedMessage'] });
    else if (active === 'lingui') add({ modules: ['@lingui/react', '@lingui/react/macro', '@lingui/core/macro', '@lingui/macro'], factories: ['useLingui'], properties: ['i18n', '_'], direct: ['Trans', 't', 'msg'] });
    else if (active === 'vue-i18n') add({ modules: ['vue-i18n', '@nuxtjs/i18n'], factories: ['useI18n'], properties: ['t'] });
    else if (active === 'tolgee') add({ modules: ['@tolgee/react'], factories: ['useTranslate'], properties: ['t'] });
    else if (active === 'next-international') add({ modules: ['next-international', 'next-international/client'], factories: ['useI18n'], properties: ['t'] });
    else if (active === 'typesafe-i18n') add({ modules: ['typesafe-i18n'], factories: ['useI18nContext'], properties: ['LL'] });
    else if (active === 'svelte-i18n') add({ modules: ['svelte-i18n'], direct: ['_', 't'] });
    else if (active === 'transloco') add({ modules: ['@jsverse/transloco', '@ngneat/transloco'], services: ['TranslocoService'] });
    else if (active === 'ngx-translate') add({ modules: ['@ngx-translate/core'], services: ['TranslateService'] });
  }
  const moduleMatches = (module: string, modules: readonly string[]): boolean => modules.includes(module);
  const nodeChildren = (node: AstNode): AstNode[] => {
    const result: AstNode[] = [];
    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra' || key === 'comments' || key === 'tokens') continue;
      if (Array.isArray(value)) {
        for (const item of value) if (item && typeof item === 'object' && typeof (item as AstNode).type === 'string') result.push(item as AstNode);
      } else if (value && typeof value === 'object' && typeof (value as unknown as AstNode).type === 'string') result.push(value as unknown as AstNode);
    }
    return result;
  };
  const child = (node: AstNode, key: string): AstNode | undefined => {
    const value = node[key];
    return value && typeof value === 'object' && !Array.isArray(value) ? value as AstNode : undefined;
  };
  const children = (node: AstNode, key: string): AstNode[] => Array.isArray(node[key]) ? (node[key] as unknown[]).filter((item): item is AstNode => !!item && typeof item === 'object' && typeof (item as AstNode).type === 'string') : [];
  const identifierName = (node: AstNode | undefined): string | undefined => {
    if (!node) return;
    if (node.type === 'Identifier' && typeof node.name === 'string') return node.name;
    if (node.type === 'StringLiteral' && typeof node.value === 'string') return node.value;
  };
  const patternIds = (pattern: AstNode | undefined, result: AstNode[] = []): AstNode[] => {
    if (!pattern) return result;
    if (pattern.type === 'Identifier') { result.push(pattern); return result; }
    if (pattern.type === 'RestElement') return patternIds(child(pattern, 'argument'), result);
    if (pattern.type === 'AssignmentPattern') return patternIds(child(pattern, 'left'), result);
    if (pattern.type === 'ObjectPattern') {
      for (const property of children(pattern, 'properties')) {
        if (property.type === 'RestElement') patternIds(child(property, 'argument'), result);
        else patternIds(child(property, 'value') ?? child(property, 'argument'), result);
      }
      return result;
    }
    if (pattern.type === 'ArrayPattern') for (const element of children(pattern, 'elements')) patternIds(element, result);
    return result;
  };
  const rootScope: CleanupScope = { bindings: new Map(), node: ast };
  const scopeByNode = new WeakMap<object, CleanupScope>(), parentByNode = new WeakMap<object, AstNode>(), declarationIds = new WeakSet<object>();
  const bindingByIdentifier = new WeakMap<object, CleanupBinding>();
  const parameterIds = new WeakSet<object>(), allCleanupBindings: CleanupBinding[] = [];
  const variableDeclarators: Array<{ node: AstNode; declaration: AstNode; scope: CleanupScope; id: AstNode; init?: AstNode }> = [];
  const imports: CleanupImport[] = [];
  const addBinding = (scope: CleanupScope, identifier: AstNode, declaration: AstNode, kind: 'local' | 'import'): CleanupBinding => {
    const name = identifierName(identifier)!;
    const existing = scope.bindings.get(name);
    if (existing) { existing.unsafe = true; return existing; }
    const result: CleanupBinding = { name, scope, declaration, identifier, references: [] };
    scope.bindings.set(name, result); bindingByIdentifier.set(identifier, result); declarationIds.add(identifier); allCleanupBindings.push(result);
    if (kind === 'import') result.candidate = 'import';
    return result;
  };
  const nearestFunction = (scope: CleanupScope): CleanupScope => {
    let current: CleanupScope | undefined = scope;
    while (current && current.node.type !== 'FunctionDeclaration' && current.node.type !== 'FunctionExpression' && current.node.type !== 'ArrowFunctionExpression' && current.node.type !== 'Program') current = current.parent;
    return current ?? rootScope;
  };
  const addPatternBindings = (pattern: AstNode | undefined, scope: CleanupScope, declaration: AstNode, kind: 'local' | 'import' = 'local'): void => {
    for (const identifier of patternIds(pattern)) addBinding(scope, identifier, declaration, kind);
  };
  const build = (node: AstNode, scope: CleanupScope, parent?: AstNode): void => {
    if (parent) parentByNode.set(node, parent);
    if (node.type === 'Program') {
      scopeByNode.set(node, scope);
      for (const item of children(node, 'body')) build(item, scope, node);
      return;
    }
    if (node.type === 'BlockStatement') {
      const block: CleanupScope = { parent: scope, bindings: new Map(), node };
      scopeByNode.set(node, block);
      for (const item of children(node, 'body')) build(item, block, node);
      return;
    }
    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      const id = child(node, 'id');
      if (node.type === 'FunctionDeclaration' && id) addPatternBindings(id, scope, node);
      const fn: CleanupScope = { parent: scope, bindings: new Map(), node };
      scopeByNode.set(node, fn);
      if (node.type !== 'ArrowFunctionExpression' && id) addPatternBindings(id, fn, node);
      for (const parameter of children(node, 'params')) { addPatternBindings(parameter, fn, node); for (const identifier of patternIds(parameter)) parameterIds.add(identifier); }
      const body = child(node, 'body'); if (body) build(body, fn, node);
      return;
    }
    if (node.type === 'CatchClause') {
      const catcher: CleanupScope = { parent: scope, bindings: new Map(), node };
      scopeByNode.set(node, catcher);
      addPatternBindings(child(node, 'param'), catcher, node);
      const body = child(node, 'body'); if (body) build(body, catcher, node);
      return;
    }
    if (node.type === 'VariableDeclaration') {
      const target = node.kind === 'var' ? nearestFunction(scope) : scope;
      for (const declaration of children(node, 'declarations')) {
        const id = child(declaration, 'id'), init = child(declaration, 'init');
        parentByNode.set(declaration, node);
        if (id) parentByNode.set(id, declaration);
        if (id) addPatternBindings(id, target, declaration);
        if (id) variableDeclarators.push({ node: declaration, declaration: node, scope: target, id, ...(init ? { init } : {}) });
        if (init) build(init, scope, declaration);
      }
      return;
    }
    if (node.type === 'ImportDeclaration') {
      const module = identifierName(child(node, 'source')) ?? '';
      for (const specifier of children(node, 'specifiers')) {
        const local = child(specifier, 'local');
        if (!local) continue;
        const record = addBinding(scope, local, specifier, 'import');
        record.importSpecifier = specifier; record.importDeclaration = node;
        imports.push({ node, specifier, local: identifierName(local)!, ...(identifierName(child(specifier, 'imported')) ? { imported: identifierName(child(specifier, 'imported')) } : {}), module });
      }
      return;
    }
    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      if (node.type === 'ClassDeclaration') { const id = child(node, 'id'); if (id) addPatternBindings(id, scope, node); }
    }
    scopeByNode.set(node, scope);
    for (const item of nodeChildren(node)) build(item, scope, node);
  };
  build(ast, rootScope);
  const resolveBinding = (scope: CleanupScope, name: string): CleanupBinding | undefined => {
    let current: CleanupScope | undefined = scope;
    while (current) { const result = current.bindings.get(name); if (result) return result; current = current.parent; }
    return undefined;
  };
  const isReference = (node: AstNode, parent: AstNode | undefined): boolean => {
    if (!parent) return true;
    if (parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') return parent.computed === true || parent.object === node;
    if ((parent.type === 'ObjectProperty' || parent.type === 'ObjectMethod' || parent.type === 'ClassProperty' || parent.type === 'ClassMethod') && parent.key === node && !parent.computed) return false;
    if (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') return false;
    if (parent.type === 'JSXAttribute' && parent.name === node) return false;
    if (parent.type === 'JSXIdentifier' || parent.type === 'JSXMemberExpression' || parent.type === 'JSXNamespacedName') return false;
    if (parent.type === 'ImportSpecifier' || parent.type === 'ImportDefaultSpecifier' || parent.type === 'ImportNamespaceSpecifier') return parent.local === node;
    if (parent.type === 'ImportDeclaration') return false;
    return true;
  };
  const unboundMessageScopes: CleanupScope[] = [];
  const collectReferences = (node: AstNode, scope: CleanupScope, parent?: AstNode): void => {
    if (node.type === 'Program') scope = scopeByNode.get(node) ?? scope;
    else if (node.type === 'BlockStatement' || node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression' || node.type === 'CatchClause') scope = scopeByNode.get(node) ?? scope;
    if (node.type === 'Identifier' && !declarationIds.has(node) && isReference(node, parent)) {
      const record = resolveBinding(scope, identifierName(node)!);
      if (record) record.references.push(node);
      else if (messagesBinding && identifierName(node) === messagesBinding.local) unboundMessageScopes.push(scope);
    }
    // JSX component names are JSXIdentifier nodes, not Identifier nodes. An
    // uppercase tag (or the root of a member tag such as <Foo.Bar>) keeps an
    // imported component alive, so a remaining <Trans> must block import removal.
    if (node.type === 'JSXIdentifier' && typeof node.name === 'string' && /^[A-Z]/.test(node.name) && ((parent?.type === 'JSXOpeningElement' && parent.name === node) || (parent?.type === 'JSXMemberExpression' && parent.object === node))) {
      resolveBinding(scope, node.name)?.references.push(node);
    }
    for (const item of nodeChildren(node)) collectReferences(item, scope, node);
  };
  collectReferences(ast, rootScope);

  const importedFactoryLocals = new Set<string>(), importedDirectLocals = new Set<string>(), importedServiceLocals = new Set<string>();
  for (const item of imports) for (const config of configs) if (moduleMatches(item.module, config.modules)) {
    if (item.imported && config.factories?.includes(item.imported)) importedFactoryLocals.add(item.local);
    if (item.imported && config.direct?.includes(item.imported)) importedDirectLocals.add(item.local);
    if (item.imported && config.services?.includes(item.imported)) importedServiceLocals.add(item.local);
  }
  const properties = new Set(configs.flatMap(config => config.properties ?? []));
  const factoryLocals = new Set([...importedFactoryLocals]);
  const serviceLocals = new Set([...importedServiceLocals]);
  const proven = new Set(provenNames.filter(name => identifier.test(name)));
  const calleeName = (init: AstNode | undefined): string | undefined => {
    let value = init;
    while (value?.type === 'AwaitExpression' || value?.type === 'TSAsExpression' || value?.type === 'TSTypeAssertion') value = child(value, 'argument') ?? child(value, 'expression');
    const callee = value?.type === 'CallExpression' ? child(value, 'callee') : undefined;
    return callee?.type === 'Identifier' ? identifierName(callee) : undefined;
  };
  const isExported = (node: AstNode): boolean => {
    const parent = parentByNode.get(node);
    return parent?.type === 'ExportNamedDeclaration' || parent?.type === 'ExportDefaultDeclaration';
  };
  const removals: Replacement[] = [];
  function removeListItem(node: AstNode, list: AstNode[], _parent: AstNode): Replacement {
    const index = list.indexOf(node), start = node.start!, end = node.end!;
    if (list.length === 1) return { start, end, text: '' };
    if (index < list.length - 1) return { start, end: list[index + 1]!.start!, text: '' };
    return { start: list[index - 1]!.end!, end, text: '' };
  }
  const trimWholeLine = (replacement: Replacement): Replacement => {
    const lineStart = text.lastIndexOf('\n', replacement.start - 1) + 1;
    const lineEnd = text.indexOf('\n', replacement.end);
    const end = lineEnd < 0 ? text.length : lineEnd;
    if (text.slice(lineStart, replacement.start).trim() || text.slice(replacement.end, end).trim()) return replacement;
    return { start: lineStart, end: lineEnd < 0 ? end : lineEnd + 1, text: replacement.text };
  };
  const fullDeclarations = new Set<AstNode>();
  const formatterDeclarations: typeof variableDeclarators = [];
  for (const item of variableDeclarators) {
    const call = calleeName(item.init);
    const serviceCall = call === 'inject' && children(item.init ?? {}, 'arguments').length === 1 && serviceLocals.size > 0;
    const idName = identifierName(item.id);
    const provenFactory = !!call && (factoryLocals.has(call) || (!!idName && proven.has(idName)) || (serviceCall && serviceLocals.size > 0));
    if (!provenFactory || isExported(item.declaration)) continue;
    formatterDeclarations.push(item);
    if (item.id.type === 'Identifier') {
      const record = resolveBinding(item.scope, identifierName(item.id)!);
      if (record && !record.unsafe && !record.references.length) { record.candidate = 'local'; record.declarationNode = item.declaration; fullDeclarations.add(item.node); }
      continue;
    }
    if (item.id.type !== 'ObjectPattern') continue;
    const candidateProperties: AstNode[] = [];
    for (const property of children(item.id, 'properties')) {
      if (property.type !== 'ObjectProperty' || property.computed) continue;
      const key = identifierName(child(property, 'key'));
      const value = child(property, 'value');
      if (!key || !properties.has(key) || !value || value.type !== 'Identifier') continue;
      const record = resolveBinding(item.scope, identifierName(value)!);
      if (record && !record.unsafe && !record.references.length) { record.candidate = 'property'; record.property = property; record.declarationNode = item.declaration; candidateProperties.push(property); }
    }
    if (!candidateProperties.length) continue;
    const allProperties = children(item.id, 'properties');
    const removable = allProperties.every(property => candidateProperties.includes(property));
    if (removable) { fullDeclarations.add(item.node); continue; }
    for (const property of candidateProperties) removals.push(removeListItem(property, allProperties, item.id));
  }
  // With a messages hook, each formatter declaration in a scope that uses the rewritten calls
  // gets the hook's binding: a dead `const t = useT()` turns into `const m = useMessages()`,
  // and one that dynamic calls keep alive gets `const m = useMessages();` on the next line.
  // One binding per scope chain; an awaited server factory is never a hook.
  const encloses = (outer: CleanupScope, inner: CleanupScope): boolean => {
    for (let current: CleanupScope | undefined = inner; current; current = current.parent) if (current === outer) return true;
    return false;
  };
  const hookScopes: CleanupScope[] = [], hookTargets = new Map<AstNode, 'replace' | 'insert'>();
  if (messagesBinding) for (const item of [...formatterDeclarations].sort((left, right) => left.node.start! - right.node.start!)) {
    if (item.init?.type !== 'CallExpression' || resolveBinding(item.scope, messagesBinding.local)) continue;
    if (!unboundMessageScopes.some(scope => encloses(item.scope, scope)) || hookScopes.some(scope => encloses(scope, item.scope))) continue;
    const replace = fullDeclarations.has(item.node), parent = parentByNode.get(item.declaration);
    if (!replace && parent?.type !== 'BlockStatement' && parent?.type !== 'Program') continue;
    hookScopes.push(item.scope);
    hookTargets.set(item.node, replace ? 'replace' : 'insert');
  }
  for (const [declarator, target] of hookTargets) {
    if (target !== 'insert') continue;
    const declaration = parentByNode.get(declarator)!;
    const end = text[declaration.end!] === ';' ? declaration.end! + 1 : declaration.end!;
    const lineStart = text.lastIndexOf('\n', declaration.start! - 1) + 1, indent = text.slice(lineStart, declaration.start!);
    removals.push({ start: end, end, text: `\n${/^[ \t]*$/.test(indent) ? indent : ''}const ${messagesBinding!.local} = ${messagesBinding!.hook}();` });
  }
  for (const declarator of fullDeclarations) {
    const declaration = parentByNode.get(declarator)!;
    if (!declaration || declaration.type !== 'VariableDeclaration') continue;
    const list = children(declaration, 'declarations');
    if (hookTargets.get(declarator) === 'replace') {
      const binding = `${messagesBinding!.local} = ${messagesBinding!.hook}()`;
      if (list.length > 1) { removals.push({ start: declarator.start!, end: declarator.end!, text: binding }); continue; }
      const end = text[declaration.end!] === ';' ? declaration.end! + 1 : declaration.end!;
      removals.push({ start: declaration.start!, end, text: `${String(declaration.kind)} ${binding}${text[end - 1] === ';' ? ';' : ''}` });
      continue;
    }
    const replacement = removeListItem(declarator, list, declaration);
    if (list.length === 1) { replacement.start = declaration.start!; replacement.end = declaration.end!; if (text[replacement.end] === ';') replacement.end++; }
    if (list.length === 1) Object.assign(replacement, trimWholeLine(replacement));
    removals.push(replacement);
  }
  const removalRanges = removals.map(item => [item.start, item.end] as const);
  const hasRemainingReferences = (record: CleanupBinding): boolean => record.references.some(reference => !removalRanges.some(([start, end]) => reference.start! >= start && reference.end! <= end));
  const explicit = new Set(explicitNames);
  const customRemovedImportLocals = new Set<string>();
  for (const variable of variableDeclarators) {
    if (!fullDeclarations.has(variable.node) || variable.id.type !== 'Identifier' || !explicit.has(identifierName(variable.id)!)) continue;
    const call = calleeName(variable.init);
    if (call) customRemovedImportLocals.add(call);
  }
  const removableImports = new Map<AstNode, Array<{ item: CleanupImport; customImport: boolean }>>();
  for (const item of imports) {
    const record = rootScope.bindings.get(item.local);
    if (!record || record.unsafe) continue;
    if (preserveImportModules.includes(item.module)) continue;
    const customImport = customRemovedImportLocals.has(item.local);
    const eligible = importedFactoryLocals.has(item.local) || importedDirectLocals.has(item.local) || importedServiceLocals.has(item.local) || customImport;
    if (!eligible) continue;
    // A mixed destructuring declaration can lose only its formatter property
    // while retaining another returned field. The factory import is still
    // required by that surviving initializer even though the property's
    // reference count disappeared.
    if ((importedFactoryLocals.has(item.local) || importedServiceLocals.has(item.local)) && variableDeclarators.some(variable => calleeName(variable.init) === item.local && !fullDeclarations.has(variable.node))) continue;
    if (hasRemainingReferences(record)) continue;
    const group = removableImports.get(item.node) ?? [];
    group.push({ item, customImport });
    removableImports.set(item.node, group);
  }
  // Build non-overlapping ranges per import declaration. Calling
  // removeListItem independently for adjacent specifiers makes ranges such
  // as `[a.start, b.start]` and `[a.end, b.end]` overlap, which can produce
  // invalid output and force the atomic parse guard to restore the import.
  for (const [declaration, group] of removableImports) {
    const list = children(declaration, 'specifiers');
    const indexes = group.map(entry => list.indexOf(entry.item.specifier)).filter(index => index >= 0).sort((left, right) => left - right);
    if (!indexes.length) continue;
    const allFramework = group.every(({ item }) => importedFactoryLocals.has(item.local) || importedDirectLocals.has(item.local) || importedServiceLocals.has(item.local));
    const hasCustomImport = group.some(({ customImport }) => customImport);
    if (indexes.length === list.length) {
      const replacement: Replacement = { start: declaration.start!, end: declaration.end!, text: '' };
      if (text[replacement.end] === ';') replacement.end++;
      Object.assign(replacement, trimWholeLine(replacement));
      // For an application-owned custom formatter import, retain module side
      // effects when its final named specifier became dead. Known framework
      // imports are side-effect-free runtime adapters and may be removed whole.
      // The kept import takes the line it replaces, newline and quotes included.
      if (hasCustomImport && !allFramework) {
        const source = child(declaration, 'source');
        const specifier = source?.start !== undefined && source.end !== undefined ? text.slice(source.start, source.end) : JSON.stringify(group[0]!.item.module);
        replacement.text = `import ${specifier};${text[replacement.end - 1] === '\n' ? '\n' : ''}`;
      }
      removals.push(replacement);
      continue;
    }
    let start = indexes[0]!;
    let previous = start;
    const flush = (last: number): void => {
      const first = list[start]!, final = list[last]!;
      const left = start > 0 ? list[start - 1]!.end! : first.start!;
      const right = start > 0 ? final.end!
        : last < list.length - 1 ? list[last + 1]!.start! : final.end!;
      removals.push({ start: left, end: right, text: '' });
    };
    for (let position = 1; position < indexes.length; position++) {
      const index = indexes[position]!;
      if (index !== previous + 1) { flush(previous); start = index; }
      previous = index;
    }
    flush(previous);
  }
  const renameDiagnostics: CodemodSkip[] = [], sourceMask = codeMask(text);
  for (const record of allCleanupBindings) {
    if (!parameterIds.has(record.identifier) || !explicit.has(record.name)) continue;
    if (record.references.length) {
      renameDiagnostics.push({ callee: record.name, reason: 'custom formatter parameter remains referenced outside rewritten calls; preserve the callback/API parameter and migrate the remaining use manually', offset: record.identifier.start });
      continue;
    }
    const renamed = record.name.startsWith('$') ? `_${record.name.slice(1)}` : `_${record.name}`;
    const functionNode = record.scope.node;
    let conflict = !identifier.test(renamed) || record.scope.bindings.has(renamed);
    if (!conflict && typeof functionNode.start === 'number' && typeof functionNode.end === 'number') {
      const escaped = renamed.replace(/[.*+?^${}()|[\\]\\]/g, '\\\\$&');
      for (const match of text.matchAll(new RegExp(`\\b${escaped}\\b`, 'g'))) {
        if (match.index! >= functionNode.start && match.index! < functionNode.end && sourceMask[match.index!]) { conflict = true; break; }
      }
    }
    if (conflict) renameDiagnostics.push({ callee: record.name, reason: `custom formatter parameter is unused but cannot be safely renamed to ${renamed}; preserve the callback/API parameter`, offset: record.identifier.start });
    // Babel includes a TypeScript parameter annotation in Identifier.end for
    // bindings such as `$t: MessageFormatter`. Replace only the identifier
    // token so the application-owned type contract survives the migration.
    else removals.push({ start: record.identifier.start!, end: record.identifier.start! + record.name.length, text: renamed });
  }
  if (!removals.length) return { code: text, diagnostics: renameDiagnostics };
  removals.sort((left, right) => right.start - left.start);
  const hookBindings = hookScopes.length;
  let result = text;
  for (const replacement of removals) result = result.slice(0, replacement.start) + replacement.text + result.slice(replacement.end);
  try { parse(result, { sourceType: 'unambiguous', errorRecovery: false, plugins: ['typescript', 'jsx', 'decorators-legacy', 'importAttributes'] }); return { code: result, diagnostics: renameDiagnostics, hookBindings }; }
  catch { return { code: text, diagnostics: [] }; }
}

/** Vue templates are not rewritten as JavaScript. Report the vue-i18n template
 * constructs that remain, so they cannot disappear from the migration report
 * as silent residue. */
function vueTemplateDiagnostics(text: string, callees: readonly string[], replacements: readonly Replacement[]): CodemodSkip[] {
  const diagnostics: CodemodSkip[] = [];
  const covered = (offset: number): boolean => replacements.some(item => item.start <= offset && offset < item.end);
  for (const match of text.matchAll(/(?<![\w$.])\$t\s*\(/g)) {
    if (covered(match.index!)) continue;
    diagnostics.push({ callee: '$t', reason: 'Vue template $t() uses the global vue-i18n translator, which the generated messages object does not replace; migrate this call manually', offset: match.index, code: 'VUE_GLOBAL_TRANSLATOR', action: 'Bind the generated messages object in the component (for example const m = ...) and rewrite this call to m.<key>(), or keep the vue-i18n runtime for this template.' });
  }
  const template = /<template\b[^>]*>([\s\S]*)<\/template>/.exec(text);
  if (template) {
    const base = template.index + template[0].indexOf('>') + 1;
    const helpers = [...new Set(['$t', ...callees.filter(callee => identifier.test(callee))])].map(name => name.replace(/[$]/g, '\\$'));
    const helperCall = new RegExp(`(?<![\\w$.])(?:${helpers.join('|')})\\s*\\(`);
    // Only dynamic bindings (:x, v-bind:x, @x, v-on:x) evaluate JavaScript;
    // a static attribute such as title="t('x')" is literal text.
    for (const attribute of template[1]!.matchAll(/\s(?::|@|v-bind:|v-on:)[\w.:-]+\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      const value = attribute[1] ?? attribute[2] ?? '';
      if (!helperCall.test(value)) continue;
      diagnostics.push({ callee: '<attribute>', reason: 'Vue attribute binding calls a translation helper; attribute values are not rewritten by the template codemod', offset: base + attribute.index!, code: 'VUE_ATTRIBUTE_TRANSLATION', action: 'Compute the translated string in script (or a computed property) with the generated messages object, then bind the attribute to that value.' });
    }
  }
  for (const match of text.matchAll(/<i18n-t\b/g)) diagnostics.push({ callee: '<i18n-t>', reason: 'the vue-i18n <i18n-t> component renders through the runtime and is not rewritten', offset: match.index, code: 'VUE_I18N_COMPONENT', action: 'Replace <i18n-t keypath> with a generated message call in the template and move slot content into explicit markup.' });
  return diagnostics;
}

export function codemodSource(text: string, format: CodemodFormat, options: CodemodSourceOptions = {}): CodemodSourceResult {
  const root = options.messagesObject ?? 'm';
  if (!identifier.test(root)) throw new TypeError('messagesObject must be a JavaScript identifier.');
  if (options.moveTypeImports?.length && options.messagesImport === undefined) throw new TypeError('moveTypeImports requires messagesImport so the replacement type module is explicit.');
  if (options.messagesHook !== undefined && !identifier.test(options.messagesHook)) throw new TypeError('messagesHook must be a JavaScript identifier.');
  if (options.messagesHook !== undefined && options.messagesImport === undefined) throw new TypeError('messagesHook requires messagesImport, the module that exports the hook.');
  const mask = codeMask(text), replacements: Replacement[] = [], skipped: CodemodSkip[] = [], occupied = new Set<string>();
  // Only Svelte files get the narrow template overlay. Keeping the filename
  // gate here is important: a JavaScript/TypeScript string that happens to
  // contain HTML must remain opaque to the source codemod.
  let svelteTemplateMask: Uint8Array | undefined;
  if (options.filename?.toLowerCase().endsWith('.svelte')) {
    const template = svelteAttributeMask(text);
    svelteTemplateMask = template.mask;
    for (let index = 0; index < mask.length; index++) if (template.mask[index]) mask[index] = 1;
    skipped.push(...template.diagnostics);
  }
  const scriptLike = !options.filename || /\.(?:[cm]?[jt]sx?)$/.test(options.filename);
  const parsedCalls = scriptLike ? astCallStarts(text) : undefined;
  if (parsedCalls?.error) {
    const skipped = [{ callee: '(parser)', reason: `source did not parse; no rewrites applied: ${parsedCalls.error}` }];
    if (options.strict) throw new CodemodStrictError(skipped);
    const files = options.filename ? [{ file: options.filename, directRewrites: 0, fallbackRequired: true, fallbackCalls: skipped }] : [];
    return { code: text, replacements: 0, typeImportsMoved: 0, skipped: actionableSkips(skipped), compatibility: compatibilityPlan(0, skipped, options.filename ? [options.filename] : [], files) };
  }
  const parsedCallStarts = parsedCalls?.starts;
  const parsedCallEnds = parsedCalls?.ends;
  const parsedShadowedStarts = parsedCalls?.shadowedStarts;
  const bindingScopeCache = new Map<string, BindingDeclarationScope[]>();
  const executableCall = (start: number): boolean => parsedCallStarts ? parsedCallStarts.has(start) : !!mask[start];
  const allowedIds = options.messageIds ? new Set(options.messageIds) : undefined;
  const renames: ReadonlyMap<string, string> = options.messageIdRenames instanceof Map ? options.messageIdRenames : new Map(Object.entries(options.messageIdRenames ?? {}));
  const renamed = (id: string): string => renames.get(id) ?? id;
  const sourceIds = options.messageIdBySource instanceof Map ? new Map(options.messageIdBySource) : new Map(Object.entries(options.messageIdBySource ?? {}));
  for (const [source, id] of sourceIds) {
    if (!source || typeof id !== 'string' || !id) throw new TypeError('messageIdBySource entries must map nonempty source strings to nonempty IDs.');
    sourceIds.set(source, renamed(id));
  }
  const normalized = normalizeFormat(format);
  const formats = normalized === 'auto' ? concreteFormats : [normalized as Exclude<CodemodFormat, 'auto'>];
  const native = formats.map(activeFormat => ({ activeFormat, bindings: bindings(text, activeFormat, skipped) }));
  // Each custom call belongs to one pass. Under `auto` that is the format that detected
  // the same callee, or else a pass of its own that passes values through unchanged.
  // Merged into every format, one pass rewrote a call and the others reported it as
  // unsupported (svelte-i18n's values wrapper, i18next's default values).
  const customCalls = options.customCalls ?? [];
  const owner = (call: CustomTranslationCall): Exclude<CodemodFormat, 'auto'> | undefined => normalized === 'auto'
    ? native.find(set => set.bindings.some(binding => binding.callee === call.callee))?.activeFormat
    : formats[0];
  const bindingSets: { activeFormat: Exclude<CodemodFormat, 'auto'> | undefined; bindings: Binding[] }[] = native.map(({ activeFormat, bindings: found }) => ({ activeFormat, bindings: mergeBindings(found, customCalls.filter(call => owner(call) === activeFormat)) }));
  const unowned = customCalls.filter(call => owner(call) === undefined);
  if (unowned.length) bindingSets.push({ activeFormat: undefined, bindings: mergeBindings([], unowned) });
  const allBindings = bindingSets.flatMap(item => item.bindings);
  const customBinding = (binding: Binding): boolean => binding.provenance === 'custom' && !binding.ambiguous;
  for (const { activeFormat } of native) angularServiceDiagnostics(text, activeFormat, skipped, parsedCallStarts);
  for (const { activeFormat, bindings: activeBindings } of bindingSets) for (const binding of activeBindings) {
    // `$t(` is a different identifier from a binding named `t`, even though
    // `\b` treats the `$` as a boundary. Vue templates rely on that distinction.
    const boundary = /^[A-Za-z_]/.test(binding.callee) ? '(?<![\\w$])' : '';
    if (binding.kind === 'direct') {
      const pattern = new RegExp(`${boundary}${binding.callee.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}((?:\\.[A-Za-z_$][\\w$]*)+)\\s*\\(`, 'g');
      for (const match of text.matchAll(pattern)) {
        if (!executableCall(match.index!)) continue;
        if (binding.ambiguous) {
          skipped.push({ callee: binding.callee, reason: 'translation binding has multiple namespace or scope declarations; qualify the helper before migration', offset: match.index });
          continue;
        }
        if (!customBinding(binding) && !svelteTemplateMask?.[match.index!] && !bindingScopeAvailable(text, binding.callee, match.index!, mask, bindingScopeCache)) {
          skipped.push({ callee: binding.callee, reason: 'translation binding is outside the lexical scope of its factory declaration; rewrite this call manually', offset: match.index });
          continue;
        }
        if (!customBinding(binding) && parsedShadowedStarts?.has(match.index!)) {
          skipped.push({ callee: binding.callee, reason: 'translation binding is shadowed by a function parameter or local scope binding; rewrite this call manually', offset: match.index });
          continue;
        }
        if (binding.namespaceDynamic) {
          skipped.push({ callee: binding.callee, reason: 'translation namespace or keyPrefix is dynamic; provide a static namespace or migrate this boundary manually', offset: match.index });
          continue;
        }
        if (!customBinding(binding) && !svelteTemplateMask?.[match.index!] && (shadowedByParameter(text, binding.callee, match.index!, mask) || shadowedByLocal(text, binding.callee, match.index!, mask))) {
          skipped.push({ callee: binding.callee, reason: 'translation binding is shadowed by a function parameter or local scope binding; rewrite this call manually', offset: match.index });
          continue;
        }
        const open = match.index! + match[0].lastIndexOf('('), close = parsedCallEnds?.get(match.index!) !== undefined
          ? parsedCallEnds.get(match.index!)! - 1 : closingParenthesis(text, open, mask);
        if (close === undefined) continue;
        const key = `${match.index}:${close}`; if (occupied.has(key)) continue; occupied.add(key);
        const id = renamed(match[1]!.slice(1)), args = text.slice(open + 1, close);
        replacements.push({ start: match.index!, end: close + 1, text: `${messageAccess(root, id)}(${args})` });
      }
      const dynamic = new RegExp(`${boundary}${binding.callee.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(?:\\?\\.)?\\[`, 'g');
      for (const match of text.matchAll(dynamic)) {
        if (executableCall(match.index!) && (customBinding(binding) || svelteTemplateMask?.[match.index!] || bindingScopeAvailable(text, binding.callee, match.index!, mask, bindingScopeCache))) {
          skipped.push({ callee: binding.callee, reason: binding.kind === 'direct' ? 'message key is dynamic' : 'message key is dynamic or computed; provide a literal key before migration', offset: match.index });
        }
      }
      continue;
    }
    // TypeScript explicit type arguments (`t<string>('title')`) do not change
    // the message key, so they are accepted between the callee and its arguments.
    const pattern = new RegExp(`${boundary}${binding.callee.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(?:<[A-Za-z_$][^()<>;\\n]*>\\s*)?(\\?\\.)?\\(`, 'g');
    for (const match of text.matchAll(pattern)) {
      const start = match.index!;
      if (!executableCall(start)) continue;
      if (binding.ambiguous) {
        skipped.push({ callee: binding.callee, reason: 'translation binding has multiple namespace or scope declarations; qualify the helper before migration', offset: start });
        continue;
      }
      if (!customBinding(binding) && !svelteTemplateMask?.[start] && !bindingScopeAvailable(text, binding.callee, start, mask, bindingScopeCache)) {
        skipped.push({ callee: binding.callee, reason: 'translation binding is outside the lexical scope of its factory declaration; rewrite this call manually', offset: start });
        continue;
      }
      if (!customBinding(binding) && parsedShadowedStarts?.has(start)) {
        skipped.push({ callee: binding.callee, reason: 'translation binding is shadowed by a function parameter or local scope binding; rewrite this call manually', offset: start });
        continue;
      }
      if (!customBinding(binding) && !svelteTemplateMask?.[start] && (shadowedByParameter(text, binding.callee.split('.')[0]!, start, mask) || shadowedByLocal(text, binding.callee.split('.')[0]!, start, mask))) {
        skipped.push({ callee: binding.callee, reason: 'translation binding is shadowed by a function parameter or local scope binding; rewrite this call manually', offset: start });
        continue;
      }
      if (match[1]) {
        skipped.push({ callee: binding.callee, reason: 'optional translation call changes undefined/null semantics and requires a manual rewrite', offset: start });
        continue;
      }
      if (binding.namespaceDynamic) {
        skipped.push({ callee: binding.callee, reason: 'translation namespace or keyPrefix is dynamic; provide a static namespace or migrate this boundary manually', offset: start });
        continue;
      }
      const open = start + match[0].lastIndexOf('('), close = parsedCallEnds?.get(start) !== undefined
        ? parsedCallEnds.get(start)! - 1 : closingParenthesis(text, open, mask);
      if (close === undefined) { skipped.push({ callee: binding.callee, reason: 'unclosed call', offset: start }); continue; }
      const args = argumentsOf(text, open, close, mask);
      const descriptor = activeFormat === 'lingui' && binding.kind !== 'descriptor' && staticString(args[0] ?? '') === undefined ? linguiDescriptor(args[0] ?? '') : undefined;
      const localId = binding.kind === 'descriptor' ? formatJsId(args[0] ?? '')
        : activeFormat === 'lingui' ? staticString(args[0] ?? '') ?? descriptor?.id
        : staticString(args[0] ?? '');
      if (!localId) {
        const first = args[0]?.trim() ?? '';
        const conditionalNamespace = activeFormat === 'i18next' && args[1]
          ? /\bns\s*:\s*(['"])([^'"\\]*)\1/.exec(args[1])?.[2] ?? binding.namespace
          : binding.namespace;
        const conditionalValues = activeFormat === 'i18next'
          ? i18nextValues(args[1])
          : activeFormat === 'svelte-i18n'
            ? svelteI18nValues(args[1])
            : { values: args[1]?.trim() };
        const canLowerConditional = binding.kind !== 'descriptor' && args.length <= 2
          && !(activeFormat === 'i18next' && args[1] && staticString(args[1]))
          && !(activeFormat === 'i18next' && args[1] && /\bns\s*:/.test(args[1]) && !/\bns\s*:\s*(['"])[^'"\\]*\1/.test(args[1]))
          && !conditionalValues.unsupported;
        const conditional = canLowerConditional
          ? conditionalMessageCall(first, localKey => {
            const keyParts = activeFormat === 'i18next' ? splitI18nextNamespace(localKey) : { key: localKey };
            if (!keyParts) return;
            const id = renamed((keyParts.namespace ?? conditionalNamespace) ? `${keyParts.namespace ?? conditionalNamespace}.${keyParts.key}` : keyParts.key);
            if (allowedIds && !allowedIds.has(id)) return;
            return `${messageAccess(root, id)}(${conditionalValues.values || ''})`;
          })
          : undefined;
        if (conditional) {
          const key = `${start}:${close}`;
          if (!occupied.has(key)) {
            occupied.add(key);
            replacements.push({ start, end: close + 1, text: conditional });
            pattern.lastIndex = close + 1;
          }
          continue;
        }
        const reason = binding.kind === 'descriptor' ? 'descriptor has no static id'
          : first.startsWith('`') && first.includes('${') ? 'message key is a dynamic template literal'
          : 'message key is dynamic';
        skipped.push({ callee: binding.callee, reason, offset: start }); continue;
      }
      if (args.length > 2) { skipped.push({ callee: binding.callee, reason: 'call has unsupported extra arguments', offset: start }); continue; }
      if (activeFormat === 'i18next' && args[1] && staticString(args[1])) {
        skipped.push({ callee: binding.callee, reason: 'second argument is an i18next default value, not a values object', offset: start }); continue;
      }
      if (activeFormat === 'i18next' && args[1] && /\bns\s*:/.test(args[1]) && !/\bns\s*:\s*(['"])[^'"\\]*\1/.test(args[1])) {
        skipped.push({ callee: binding.callee, reason: 'i18next namespace option is dynamic; provide a static namespace before migration', offset: start }); continue;
      }
      const keyParts = activeFormat === 'i18next' ? splitI18nextNamespace(localId) : { key: localId };
      if (!keyParts) { skipped.push({ callee: binding.callee, reason: `i18next key ${JSON.stringify(localId)} has an unsupported namespace separator; migrate this call manually`, offset: start, code: 'UNSUPPORTED_NAMESPACE_SYNTAX' }); continue; }
      const callNamespace = activeFormat === 'i18next' && args[1] ? /\bns\s*:\s*(['"])([^'"\\]*)\1/.exec(args[1])?.[2] : undefined;
      const prefix = keyParts.namespace ?? callNamespace ?? binding.namespace;
      const id = renamed(prefix ? `${prefix}.${keyParts.key}` : keyParts.key);
      if (allowedIds && !allowedIds.has(id)) { skipped.push({ callee: binding.callee, reason: `message id ${JSON.stringify(id)} is absent from generated message types`, offset: start, code: 'UNKNOWN_MESSAGE_ID' }); continue; }
      // Lingui's i18n._(descriptor, values) reads the descriptor's own values first.
      const migratedValues = activeFormat === 'i18next' ? i18nextValues(args[1]) : activeFormat === 'svelte-i18n' ? svelteI18nValues(args[1]) : { values: descriptor?.values ?? args[1]?.trim() };
      if (migratedValues.unsupported) {
        skipped.push({ callee: binding.callee, reason: activeFormat === 'svelte-i18n' ? `unsupported svelte-i18n option: ${migratedValues.unsupported}` : `unsupported i18next option ${migratedValues.unsupported}`, offset: start }); continue;
      }
      const values = migratedValues.values;
      const key = `${start}:${close}`; if (occupied.has(key)) continue; occupied.add(key);
      replacements.push({ start, end: close + 1, text: `${messageAccess(root, id)}(${values || ''})` });
      pattern.lastIndex = close + 1;
    }
  }
  skipped.push(...wrapperDiagnostics(text, allBindings.map(binding => binding.callee)));
  if (formats.includes('lingui')) {
    const tagNames = destructuredBindings(text, importedLocals(text, ['@lingui/react', '@lingui/react/macro'], ['useLingui']), 't', false, skipped).map(item => item.name);
    if (hasCodeMatch(text, /\bfrom\s*['"]@lingui\/(?:core\/)?macro['"]/g)) tagNames.push(...importedLocals(text, ['@lingui/core/macro', '@lingui/macro', '@lingui/react/macro'], ['t', 'msg']));
    for (const name of new Set(tagNames)) {
      const pattern = new RegExp(`\\b${name}\\s*\\x60([^\\x60]*)\\x60`, 'g');
      for (const match of text.matchAll(pattern)) {
        if (match[1]!.includes('${')) { skipped.push({ callee: `${name}\u0060…\u0060`, reason: 'Lingui tagged macro has dynamic expressions', offset: match.index }); continue; }
        const source = match[1]!, id = sourceIds.get(source) ?? (allowedIds?.has(renamed(source)) ? renamed(source) : undefined);
        if (!id) { skipped.push({ callee: `${name}\u0060…\u0060`, reason: 'Lingui source macro needs an unambiguous catalog source-to-id mapping', offset: match.index }); continue; }
        if (allowedIds && !allowedIds.has(id)) { skipped.push({ callee: `${name}\u0060…\u0060`, reason: `message id ${JSON.stringify(id)} is absent from generated message types`, offset: match.index }); continue; }
        replacements.push({ start: match.index!, end: match.index! + match[0].length, text: `${messageAccess(root, id)}()` });
      }
    }
  }
  const jsxContext: JsxContext = { sourceIds, allowedIds, renamed, jsxStarts: parsedCalls?.jsxStarts, jsxChildStarts: parsedCalls?.jsxChildStarts, jsxStatementStarts: parsedCalls?.jsxExpressionStatementStarts, jsxElements: parsedCalls?.jsxElements,
    messageComponent: options.messageComponent, ...(options.richMessageIds ? { richIds: new Set(options.richMessageIds) } : {}) };
  for (const activeFormat of formats) for (const replacement of jsxReplacements(text, activeFormat, root, mask, skipped, jsxContext)) {
    const key = `${replacement.start}:${replacement.end - 1}`; if (!occupied.has(key)) { occupied.add(key); replacements.push(replacement); }
  }
  // A recognized hook binding may expose framework-specific members that have
  // no equivalent on the generated message object. Report these explicitly
  // instead of silently leaving a call that would reference a removed helper
  // (Next's t.raw/t.has/t.markup are the common example).
  for (const { activeFormat, bindings: activeBindings } of bindingSets) {
    const allowedMembers = new Set<string>();
    for (const binding of activeBindings) {
      if (binding.kind === 'direct' || binding.callee.includes('.')) continue;
      const escaped = binding.callee.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');
      for (const match of text.matchAll(new RegExp(`\\b${escaped}\\s*(?:\\?\\.|\\.)\\s*([A-Za-z_$][\\w$]*)\\s*\\(`, 'g'))) {
        if (parsedCallStarts && !parsedCallStarts.has(match.index!)) continue;
        if (allowedMembers.has(match[1]!)) continue;
        skipped.push({ callee: `${binding.callee}.${match[1]}`, reason: `${activeFormat ?? 'custom'} translation helper member is not supported by the generated messages object; migrate this member manually`, offset: match.index });
      }
    }
  }
  if (options.filename?.endsWith('.html') && (normalized === 'transloco' || normalized === 'ngx-translate')) {
    const pipe = normalized === 'transloco' ? 'transloco' : 'translate';
    const pattern = new RegExp(`(['"])([^'"\\n]+)\\1\\s*\\|\\s*${pipe}\\b`, 'g');
    for (const match of text.matchAll(pattern)) {
      const id = renamed(match[2]!);
      const suffix = text.slice(match.index! + match[0].length);
      if (/^\s*:/.test(suffix)) {
        skipped.push({ callee: `| ${pipe}`, reason: 'translation pipe options are not statically equivalent; migrate the pipe arguments manually', offset: match.index });
        continue;
      }
      if (allowedIds && !allowedIds.has(id)) { skipped.push({ callee: `| ${pipe}`, reason: `message id ${JSON.stringify(id)} is absent from generated message types`, offset: match.index }); continue; }
      replacements.push({ start: match.index!, end: match.index! + match[0].length, text: `${messageAccess(root, id)}()` });
    }
    const dynamicPattern = new RegExp(`\\{\\{([\\s\\S]*?)\\|\\s*${pipe}\\b`, 'g');
    for (const match of text.matchAll(dynamicPattern)) {
      const expression = match[1]!.trim();
      // A quoted expression (including one with explicit pipe arguments) was
      // already handled by the literal pass; avoid emitting a second,
      // contradictory dynamic diagnostic for the same source span.
      if (/^(['"])[^'"\n]+\1(?:\s*:|\s*$)/.test(expression)) continue;
      skipped.push({ callee: `| ${pipe}`, reason: 'translation pipe key is dynamic; use a literal key or migrate the template manually', offset: match.index });
    }
    const directivePattern = normalized === 'transloco'
      ? /(?:\*transloco|\[transloco(?:Params|Scope)?\]|\btransloco(?:Params|Scope)?)\s*=/g
      : /(?:\*translate|\[translate(?:Params|Scope)?\]|\btranslate(?:Params|Scope)?)\s*=/g;
    for (const match of text.matchAll(directivePattern)) skipped.push({
      callee: normalized === 'transloco' ? 'transloco directive' : 'translate directive',
      reason: 'Angular translation directive controls template rendering or parameters; migrate the directive manually instead of flattening it to a message call',
      offset: match.index,
    });
    const bareDirective = normalized === 'transloco'
      ? /<[A-Za-z][^>]*\btransloco(?=\s|\/?>)/g
      : /<[A-Za-z][^>]*\btranslate(?=\s|\/?>)/g;
    for (const match of text.matchAll(bareDirective)) skipped.push({
      callee: normalized === 'transloco' ? 'transloco directive' : 'translate directive',
      reason: 'Angular translation directive controls template rendering or parameters; migrate the directive manually instead of flattening it to a message call',
      offset: match.index,
    });
  }
  // Applying both sides of a nested translation expression with offsets from
  // the original source corrupts the outer replacement after the inner one
  // changes its length. Migrate the innermost call now and make the outer call
  // an explicit follow-up. This keeps every individual write source-safe.
  // Replacements are usually disjoint, but a wrapper can contain another
  // translation call. The old pairwise search compared every replacement to
  // every other replacement, which became quadratic for large Svelte files
  // after quoted-attribute interpolations were made visible. A sorted active
  // interval stack finds the nearest containing replacement in linear time
  // (apart from the one deterministic sort).
  if (options.filename?.toLowerCase().endsWith('.vue') && (normalized === 'auto' || normalized === 'vue-i18n')) skipped.push(...vueTemplateDiagnostics(text, allBindings.map(binding => binding.callee), replacements));
  const containingNestedCall = new Set<Replacement>();
  const orderedReplacements = [...replacements].sort((left, right) => left.start - right.start || right.end - left.end);
  const activeReplacements: Replacement[] = [];
  for (const replacement of orderedReplacements) {
    while (activeReplacements.length && activeReplacements.at(-1)!.end < replacement.end) activeReplacements.pop();
    const parent = activeReplacements.at(-1);
    if (parent && replacement.start > parent.start && replacement.end <= parent.end) containingNestedCall.add(parent);
    activeReplacements.push(replacement);
  }
  for (const replacement of containingNestedCall) skipped.push({
    callee: 'nested translation call',
    reason: 'call contains another migratable translation call; migrate the inner call first and re-run after review',
    offset: replacement.start,
  });
  const safeReplacements = replacements.filter(replacement => !containingNestedCall.has(replacement));
  safeReplacements.sort((left, right) => left.start - right.start);
  let code = text;
  // Assemble the output once. Repeatedly slicing and replacing the complete
  // source copies an increasingly large string for every call, which made a
  // large Svelte component quadratic even after the interval audit above.
  if (safeReplacements.length) {
    const pieces: string[] = [];
    let cursor = 0;
    for (const replacement of safeReplacements) {
      pieces.push(text.slice(cursor, replacement.start), replacement.text);
      cursor = replacement.end;
    }
    pieces.push(text.slice(cursor));
    code = pieces.join('');
  }
  let appliedReplacements = safeReplacements;
  let typeImportsMoved = 0;
  if (safeReplacements.length && scriptLike) {
    try {
      parse(code, { sourceType: 'unambiguous', errorRecovery: false, plugins: ['typescript', 'jsx', 'decorators-legacy', 'importAttributes'] });
    } catch (error) {
      // Replacements are never allowed to turn a parseable source file into a
      // syntax error. Return the original bytes and retain an actionable
      // diagnostic so strict/project callers can fail before writing.
      skipped.push({ callee: '(output)', reason: `rewritten source did not parse; no rewrites applied: ${(error as Error).message}` });
      code = text;
      appliedReplacements = [];
    }
  }
  if (appliedReplacements.some(replacement => replacement.rich)) {
    try { code = insertMessagesImport(code, 'rich', '@nordbeam/locale/react/rich'); }
    catch (error) {
      skipped.push({ callee: '(rich-import)', reason: `rich() import could not be added; no rewrites applied: ${(error as Error).message}` });
      code = text;
      appliedReplacements = [];
    }
  }
  // Only clean bindings after at least one call was actually lowered. This
  // keeps previews idempotent and avoids deleting a possibly intentional
  // framework hook in an otherwise untouched source file.
  let hookBindings = 0;
  if (appliedReplacements.length && options.cleanup !== false && (scriptLike || options.filename?.toLowerCase().endsWith('.svelte'))) {
    const cleanup = scriptLike
      ? cleanupFormatterBindings(code, format, appliedReplacements.length, allBindings.map(binding => binding.callee.split('.')[0]!), (options.customCalls ?? []).map(call => call.callee.split('.')[0]!), [], options.messagesHook === undefined ? undefined : { local: root, hook: options.messagesHook })
      : cleanupSvelteFormatterBindings(code, format, appliedReplacements.length, allBindings.map(binding => binding.callee.split('.')[0]!), (options.customCalls ?? []).map(call => call.callee.split('.')[0]!));
    code = cleanup.code;
    hookBindings = (cleanup as { hookBindings?: number }).hookBindings ?? 0;
    skipped.push(...cleanup.diagnostics);
  }
  // Importing the generated messages object is deliberately opt-in. Apply it
  // only after all call rewrites and binding cleanup so a failed parse can
  // restore the original bytes atomically instead of leaving an unbound `m`.
  // With a hook, the hook is imported, and only when a declaration became its binding;
  // calls outside such a scope stay unbound and are reported as MISSING_MESSAGES_BINDING.
  if (appliedReplacements.length && options.messagesImport !== undefined && (options.messagesHook === undefined || hookBindings > 0)) {
    try {
      code = ensureMessagesImport(code, options.filename, options.messagesHook ?? root, options.messagesImport);
      validateCodemodOutput(code, options.filename);
    } catch (error) {
      skipped.push({ callee: '(messages-import)', reason: `messages import could not be added; no rewrites applied: ${(error as Error).message}` });
      code = text;
      appliedReplacements = [];
    }
  }
  if (options.moveTypeImports?.length && options.messagesImport !== undefined) {
    try {
      const moved = moveTypeImports(code, options.filename, format, options.moveTypeImports, options.messagesImport);
      code = moved.code;
      typeImportsMoved = moved.moved;
      validateCodemodOutput(code, options.filename);
    } catch (error) {
      skipped.push({ callee: '(type-import)', reason: `type-only import could not be moved; no rewrites applied: ${(error as Error).message}` });
      code = text;
      appliedReplacements = [];
      typeImportsMoved = 0;
    }
  }
  // Strict source migration audits the final bytes. A framework import that
  // became dead is safe to remove; a surviving import still indicates an
  // unresolved integration boundary.
  if (options.strict) for (const activeFormat of formats) skipped.push(...incumbentImportDiagnostics(code, activeFormat));
  const positionOf = sourcePositioner(text);
  const uniqueSkips = [...new Map(actionableSkips(skipped).map(item => [`${item.file ?? ''}:${item.offset ?? -1}:${item.callee}:${item.reason}`, positionOf(item)])).values()];
  skipped.length = 0; skipped.push(...uniqueSkips);
  const files = options.filename ? [{
    file: options.filename,
    directRewrites: appliedReplacements.length,
    fallbackRequired: skipped.length > 0,
    fallbackCalls: [...new Map(skipped.map(item => [`${item.offset ?? -1}:${item.callee}:${item.reason}`, item])).values()],
  }] : [];
  if (options.strict && skipped.length) throw new CodemodStrictError(skipped);
  return { code, replacements: appliedReplacements.length, typeImportsMoved, skipped, compatibility: compatibilityPlan(appliedReplacements.length, skipped, options.filename && skipped.length ? [options.filename] : [], files) };
}

const generatedHeaderMarker = '// Generated by Nordbeam Locale. Do not edit.';
const scopeContainers = new Set(['Program', 'BlockStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'SwitchStatement', 'CatchClause', 'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const functionContainers = new Set(['Program', 'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const skippedAstKeys = new Set(['loc', 'start', 'end', 'extra', 'comments', 'leadingComments', 'trailingComments', 'innerComments', 'tokens', 'typeAnnotation', 'returnType', 'typeParameters', 'superTypeParameters', 'implements']);

/** Count references to a generated-messages identifier that have no visible
 * declaration. This is intentionally small: declarations are visible in their
 * nearest block (or function for `var`), and TypeScript-only nodes are ignored.
 * It is enough to prove that a rewrite introduced an unbound `m` reference. */
function messageBindingAudit(source: string, name: string, filename: string | undefined): { declares: boolean; unbound: number; first?: number } | undefined {
  if (filename && /\.(?:vue|svelte)$/i.test(filename)) {
    const blocks = [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
    let declares = false;
    for (const block of blocks) {
      const audit = messageBindingAudit(block[1]!, name, undefined);
      if (!audit) return undefined;
      declares ||= audit.declares;
    }
    if (declares) return { declares, unbound: 0 };
    const references = [...source.matchAll(new RegExp(`(?<![\\w$.])${name.replace(/[$]/g, '\\$')}(?=\\s*[.[(])`, 'g'))];
    return { declares, unbound: references.length, ...(references[0] ? { first: references[0].index } : {}) };
  }
  let program: AstNode;
  try { program = parse(source, { sourceType: 'unambiguous', errorRecovery: false, plugins: ['typescript', 'jsx', 'decorators-legacy', 'importAttributes'] }).program as unknown as AstNode; }
  catch { return undefined; }
  const declarationScopes: Array<{ start: number; end: number }> = [], references: AstNode[] = [], declarationIds = new WeakSet<object>();
  let declares = false;
  const nodeChildren = (node: AstNode): Array<[string, AstNode]> => {
    const result: Array<[string, AstNode]> = [];
    for (const [key, value] of Object.entries(node)) {
      if (skippedAstKeys.has(key)) continue;
      for (const item of Array.isArray(value) ? value : [value]) if (item && typeof item === 'object' && typeof (item as AstNode).type === 'string') result.push([key, item as AstNode]);
    }
    return result;
  };
  const patternIdentifiers = (pattern: AstNode | undefined, result: AstNode[] = []): AstNode[] => {
    if (!pattern) return result;
    if (pattern.type === 'Identifier') result.push(pattern);
    else if (pattern.type === 'AssignmentPattern') patternIdentifiers(pattern.left as AstNode, result);
    else if (pattern.type === 'RestElement') patternIdentifiers(pattern.argument as AstNode, result);
    else if (pattern.type === 'ObjectPattern') for (const property of (pattern.properties as AstNode[] | undefined) ?? []) patternIdentifiers(property.type === 'RestElement' ? property : property.value as AstNode, result);
    else if (pattern.type === 'ArrayPattern') for (const element of (pattern.elements as Array<AstNode | null> | undefined) ?? []) if (element) patternIdentifiers(element, result);
    return result;
  };
  const declare = (pattern: AstNode | undefined, scope: AstNode): void => {
    for (const identifier of patternIdentifiers(pattern)) {
      if (identifier.name !== name) continue;
      declares = true; declarationIds.add(identifier);
      declarationScopes.push({ start: scope.start!, end: scope.end! });
    }
  };
  const walk = (node: AstNode, parent: AstNode | undefined, key: string, containers: AstNode[]): void => {
    // TypeScript type-only nodes never reference a runtime binding. Expression
    // wrappers (`x as T`, `x!`) do contain runtime expressions and are walked.
    const typeOnly = node.type?.startsWith('TS') && !['TSAsExpression', 'TSNonNullExpression', 'TSSatisfiesExpression', 'TSTypeAssertion'].includes(node.type);
    if (typeOnly) return;
    const top = containers.at(-1)!;
    let scoped = containers;
    if (scopeContainers.has(node.type!)) scoped = [...containers, node];
    if (node.type === 'VariableDeclaration') {
      const target = node.kind === 'var' ? [...containers].reverse().find(item => functionContainers.has(item.type!)) ?? top : top;
      for (const declarator of (node.declarations as AstNode[] | undefined) ?? []) declare(declarator.id as AstNode, target);
    } else if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
      if (node.id) declare(node.id as AstNode, top);
      if (node.type === 'FunctionDeclaration') for (const parameter of (node.params as AstNode[] | undefined) ?? []) declare(parameter, node);
    } else if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      for (const parameter of (node.params as AstNode[] | undefined) ?? []) declare(parameter, node);
    } else if (node.type === 'CatchClause') {
      declare(node.param as AstNode | undefined, node);
    } else if (node.type === 'ImportSpecifier' || node.type === 'ImportDefaultSpecifier' || node.type === 'ImportNamespaceSpecifier') {
      declare(node.local as AstNode, containers[0]!);
    }
    if (node.type === 'Identifier' && node.name === name && !declarationIds.has(node)) {
      const isMemberProperty = (parent?.type === 'MemberExpression' || parent?.type === 'OptionalMemberExpression') && key === 'property' && !parent.computed;
      const isObjectKey = (parent?.type === 'ObjectProperty' || parent?.type === 'ObjectMethod' || parent?.type === 'ClassProperty' || parent?.type === 'ClassMethod') && key === 'key' && !parent.computed;
      if (!isMemberProperty && !isObjectKey) references.push(node);
    }
    for (const [childKey, child] of nodeChildren(node)) walk(child, node, childKey, scoped);
  };
  walk(program, undefined, 'program', []);
  const unbound = references.filter(reference => !declarationScopes.some(scope => scope.start <= reference.start! && reference.end! <= scope.end));
  return { declares, unbound: unbound.length, ...(unbound[0] ? { first: unbound[0].start } : {}) };
}

async function sourceFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isDirectory() && !ignored.has(entry.name)) await visit(resolve(current, entry.name));
      else if (entry.isFile() && extensions.has(extname(entry.name))) result.push(resolve(current, entry.name));
    }
  }
  await visit(directory);
  return result;
}

async function replaceFiles(files: Map<string, string>): Promise<void> {
  const staged: Array<{ file: string; temporary: string }> = [];
  const backups: Array<{ file: string; backup: string }> = [];
  const committed: string[] = [];
  let complete = false;
  try {
    for (const [file, text] of files) {
      await mkdir(dirname(file), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      // Rename replaces the directory entry, so the original permissions must
      // be copied explicitly or an executable script silently becomes 0644.
      const mode = (await stat(file).catch(() => undefined))?.mode;
      await writeFile(temporary, text, { flag: 'wx' });
      if (mode !== undefined) await chmod(temporary, mode & 0o7777);
      staged.push({ file, temporary });
    }
    // Keep originals until every replacement has been committed. A failed
    // rename must restore all prior files; a migration can never leave a
    // half-rewritten source tree behind.
    for (const item of staged) {
      const backup = `${item.file}.${randomUUID()}.bak`;
      try {
        await rename(item.file, backup);
        backups.push({ file: item.file, backup });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    for (const item of staged) { await rename(item.temporary, item.file); committed.push(item.file); }
    complete = true;
  } finally {
    if (!complete) {
      for (const file of committed) await unlink(file).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
      for (const item of [...backups].reverse()) await rename(item.backup, item.file).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    } else {
      for (const item of backups) await unlink(item.backup).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    }
    for (const item of staged) await unlink(item.temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
  }
}

/** Preview or apply conservative source rewrites. Imports/providers remain an
 * explicit framework migration step unless callers opt into messagesImport;
 * only proven calls with static IDs move. */
export async function codemodProject(options: { root?: string; sourceDir?: string; format: CodemodFormat; messagesObject?: string; messagesImport?: string; messagesHook?: string; moveTypeImports?: readonly string[]; customCalls?: readonly CustomTranslationCall[]; messageIds?: readonly string[] | ReadonlySet<string>; messageIdBySource?: ReadonlyMap<string, string> | Readonly<Record<string, string>>; messageIdBySourceFile?: string; messageIdRenames?: ReadonlyMap<string, string> | Readonly<Record<string, string>>; richMessageIds?: readonly string[] | ReadonlySet<string>; write?: boolean; plan?: boolean; strict?: boolean;
  /** Standalone CLI runs have no framework integration to bind the generated
   * object. `true` refuses a rewrite that would reference an unbound `m` per
   * file; `'warn'` applies it and reports MISSING_MESSAGES_BINDING in
   * `warnings`. Migration flows bind the object themselves and leave this off. */
  requireMessagesBinding?: boolean | 'warn' }): Promise<CodemodResult> {
  const root = resolve(options.root ?? '.');
  const sourceDir = resolve(root, options.sourceDir ?? 'src');
  const sourceIds = options.messageIdBySource instanceof Map
    ? new Map(options.messageIdBySource)
    : new Map(Object.entries(options.messageIdBySource ?? {}));
  if (options.messageIdBySourceFile) for (const [source, id] of await readMessageIdBySourceFile(options.messageIdBySourceFile, root)) sourceIds.set(source, id);
  // Generated catalogs and the typed runtime are the migration target, not
  // application source. Scanning them would rewrite generated code or report
  // its declarations as unresolved calls.
  const generatedDirectory = await configuredOutputDirectory(root);
  const candidates = (await sourceFiles(sourceDir)).filter(file => file !== generatedDirectory && !file.startsWith(`${generatedDirectory}/`));
  const files: string[] = [], changed: CodemodChange[] = [], skipped: CodemodSkip[] = [], warnings: CodemodSkip[] = [], fallbackCalls: CodemodSkip[] = [], compatibilityFiles: CodemodCompatibilityFile[] = [], outputs = new Map<string, string>();
  for (const file of candidates) {
    const source = await readFile(file, 'utf8');
    if (source.slice(0, 512).includes(generatedHeaderMarker)) continue;
    files.push(file);
    let code = source, replacements = 0, typeImportsMoved = 0;
    let result: CodemodSourceResult;
    const revisions = new Set<string>([source]);
    // The single-source API deliberately lowers an innermost call first so
    // every replacement uses offsets from one revision. At project level we
    // can safely reparse the exact output and converge in one reviewed run.
    for (;;) {
      result = codemodSource(code, options.format, { messagesObject: options.messagesObject, messagesImport: options.messagesImport, messagesHook: options.messagesHook, moveTypeImports: options.moveTypeImports, filename: file, customCalls: options.customCalls, messageIds: options.messageIds, messageIdBySource: sourceIds, messageIdRenames: options.messageIdRenames, richMessageIds: options.richMessageIds });
      replacements += result.replacements;
      typeImportsMoved += result.typeImportsMoved;
      if (result.code === code) break;
      if (revisions.has(result.code)) throw new Error(`Codemod did not converge for ${file}; no files were written.`);
      revisions.add(result.code);
      code = result.code;
    }
    const bindingSkips: CodemodSkip[] = [];
    // Without messagesImport the codemod cannot add the generated binding, so
    // a rewrite that introduces an unbound `m` would compile-fail while still
    // reporting success. Leave such a file unchanged and say why; preview and
    // write share this decision. A hook binds `m` only in the scopes of the
    // declarations it replaced, so those files are audited too.
    if (options.requireMessagesBinding && (!options.messagesImport || options.messagesHook) && code !== source) {
      const messagesObject = options.messagesObject ?? 'm';
      const before = messageBindingAudit(source, messagesObject, file), after = messageBindingAudit(code, messagesObject, file);
      if (before && after && after.unbound > before.unbound) {
        const binding = `server: const { messages: ${messagesObject} } = await loadLocale(locale); client: const ${messagesObject} = i18n.useMessages()`;
        if (options.requireMessagesBinding === 'warn') {
          warnings.push(sourcePositioner(code)({ file, callee: messagesObject, reason: `rewritten calls reference ${messagesObject}, which this file does not bind yet`, code: 'MISSING_MESSAGES_BINDING', action: `Bind ${messagesObject} in this file (${binding}), or re-run with --messages-import <specifier>.`, ...(after.first !== undefined ? { offset: after.first } : {}) }));
        } else {
          bindingSkips.push(sourcePositioner(code)({ file, callee: messagesObject, reason: `rewritten calls would reference ${messagesObject} without a binding in this file; ${replacements} call(s) left unchanged`, code: 'MISSING_MESSAGES_BINDING', action: `Pass --messages-import <specifier>, or bind ${messagesObject} first (${binding}), then re-run the codemod.`, ...(after.first !== undefined ? { offset: after.first } : {}) }));
          code = source; replacements = 0; typeImportsMoved = 0;
        }
      }
    }
    if (code !== source && !(await writable(file))) {
      bindingSkips.push({ file, callee: '(file)', reason: 'file is read-only; its rewrites were not applied', code: 'READ_ONLY_FILE', action: 'Make the file writable (chmod u+w) or migrate its calls manually, then re-run the codemod.' });
      code = source; replacements = 0; typeImportsMoved = 0;
    }
    const allSkips = [...result.skipped, ...bindingSkips];
    result = { ...result, code, replacements, typeImportsMoved, skipped: allSkips, compatibility: compatibilityPlan(replacements, allSkips,
      allSkips.length ? [file] : [], [{ file, directRewrites: replacements, fallbackRequired: allSkips.length > 0, fallbackCalls: allSkips }]) };
    const normalized = normalizeFormat(options.format);
    const residueFormats = normalized === 'auto' ? concreteFormats : [normalized as Exclude<CodemodFormat, 'auto'>];
    const residue = residueFormats.flatMap(activeFormat => incumbentImportDiagnostics(result.code, activeFormat));
    const fileSkips = actionableSkips([...result.skipped, ...residue]);
    skipped.push(...fileSkips.map(item => ({ ...item, file })));
    // Import residue is an integration audit, not a legacy call fallback. It
    // must be visible in the report and must fail strict mode, but it should
    // not cause an otherwise completely static call migration to acquire a
    // lazy lookup boundary.
    const callSkips = result.skipped;
    fallbackCalls.push(...callSkips.map(item => ({ ...item, file })));
    compatibilityFiles.push({ file, directRewrites: result.compatibility.directRewrites, fallbackRequired: callSkips.length > 0, fallbackCalls: callSkips.map(item => ({ ...item, file })) });
    if (result.code === source) continue;
    changed.push({ file, replacements: result.replacements, typeImportsMoved: result.typeImportsMoved });
    if (options.write || options.plan) outputs.set(file, result.code);
  }
  if (options.strict && skipped.length) throw new CodemodStrictError(skipped);
  if (options.write) await replaceFiles(outputs);
  const plan = options.plan ? await createPlan({ root, operation: {
    command: 'codemod', format: options.format, sourceDir: relative(root, sourceDir).replaceAll('\\', '/'),
    messagesObject: options.messagesObject ?? null, messagesImport: options.messagesImport ?? null, ...(options.messagesHook === undefined ? {} : { messagesHook: options.messagesHook }), moveTypeImports: options.moveTypeImports ?? [],
  }, changes: [...outputs].map(([file, content]) => ({ path: relative(root, file).replaceAll('\\', '/'), content })) }) : undefined;
  const replacements = changed.reduce((sum, item) => sum + item.replacements, 0);
  const typeImportsMoved = changed.reduce((sum, item) => sum + item.typeImportsMoved, 0);
  const compatibility = compatibilityPlan(replacements, fallbackCalls, [...new Set(fallbackCalls.map(item => item.file).filter((file): file is string => !!file))].sort(), compatibilityFiles);
  return { format: options.format, sourceDir, dryRun: !options.write, filesScanned: files.length,
    replacements, typeImportsMoved, changed, skipped, compatibility, ...(warnings.length ? { warnings } : {}), ...(plan ? { plan } : {}) };
}
