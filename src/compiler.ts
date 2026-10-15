import { parse, TYPE } from '@formatjs/icu-messageformat-parser';
import type { MessageFormatElement, NumberElement, DateElement, TimeElement } from '@formatjs/icu-messageformat-parser';
import { CompileError, describeIcuError } from './diagnostics.js';
import { droppedTagDiagnostic, pluralCategories, pluralCategoryDiagnostic } from './contracts.js';
import type { Diagnostic } from './diagnostics.js';
import { declarationGroups, sameDeclarationLayout, type DeclarationGroup } from './type-layout.js';
import { quote, header, jsHeader, rewriteGeneratedIdentifiers, substituteTextParameters } from './codegen.js';
import { Projection } from './projection.js';
import { isCatalogSnapshot } from './catalog-input.js';
import { foldLiteralSelect } from './literal-folding.js';
import type { LiteralSelect } from './literal-folding.js';
import { nestedMessageRuntime, nestedMessageTypeLiteral } from './nested-messages.js';
import { validateKeyPolicy } from './key-policy.js';
import type { KeyPattern } from './key-policy.js';
export { quote } from './codegen.js';
export { CompileError, formatDiagnostic } from './diagnostics.js';
export type { Diagnostic } from './diagnostics.js';
export { locateDiagnostics } from './catalog-diagnostics.js';
export type { CatalogSource } from './catalog-diagnostics.js';
export { matchesKeyPattern, patternsOverlap, resolveKeyPolicy, validateKeyPatterns, validateKeyPolicy } from './key-policy.js';
export type { KeyPattern, KeyPolicyDecision, KeyPolicyOptions, ResolvedKeyPolicy } from './key-policy.js';
export { compareContract, describeCatalog, describeMessageContract } from './contracts.js';
export type { CatalogDescription, CompareContractOptions, ContractArgumentKind, ContractDiagnostic, DescribeCatalogOptions, DescribedMessage, MessageArgumentContract, MessageBranchContract, MessageContract } from './contracts.js';
export { updateCatalogText } from './catalog-text.js';
export type { CatalogTextChanges } from './catalog-text.js';

export interface Catalog { [key: string]: string | Catalog }
export interface Formats {
  number?: Record<string, Intl.NumberFormatOptions>;
  date?: Record<string, Intl.DateTimeFormatOptions>;
  time?: Record<string, Intl.DateTimeFormatOptions>;
}
export interface CompilerOptions {
  baseLocale: string;
  catalogs: Record<string, Catalog>;
  /** Missing messages use the base message AND its locale's formatting rules. */
  missing?: 'fallback' | 'error';
  /** Include helpful argument validation. Production output trusts generated types. */
  development?: boolean;
  formats?: Formats;
  /** Applied to date/time formatters unless a named format overrides it. */
  timeZone?: string;
  /** Exact IDs or prefix patterns ending in .*; each scope has its own loader. */
  scopes?: Record<string, readonly string[]>;
  /** Scopes whose development loader logs each read of a message they leave out.
   * Generation sets it for scopes computed from code. */
  checkedScopes?: readonly string[];
  /** Source text is copied verbatim and never sent to a translation model. */
  lockedKeys?: readonly KeyPattern[];
  /** Messages are omitted from translation work. Exact IDs or prefix patterns. */
  ignoredKeys?: readonly KeyPattern[];
  /** Output artifact set. `typed` is the default; `runtime` omits declarations;
   * `loader` also omits public named-import locale modules. */
  artifacts?: 'typed' | 'runtime' | 'loader' | 'loader-typed';
  /** Include original ICU source beside loaded messages for compatibility
   * renderers. `rich` retains only messages containing tags; `all` retains all. */
  includeSources?: 'rich' | 'all' | readonly string[];
  /** Opt into a shared plain-literal module for cold loader artifacts. */
  shareLiterals?: boolean;
  /** Notes about messages, by message ID. Typed output shows each beside its
   * message in editor hovers; IDs that are not in the base catalog are ignored. */
  notes?: Readonly<Record<string, string>>;
}
export interface CompilerCacheOptions {
  /** Estimated retained message-body budget; excludes catalogs and final output. Default: 64 MiB. Use 0 to disable body caching. */
  maxMessageCacheBytes?: number;
}
export interface CompiledProject {
  files: Record<string, string>;
  locales: string[];
  /** Message IDs available from each generated loader, for build integrations. */
  groups: Record<string, readonly string[]>;
  warnings: Diagnostic[];
}
type Kind = 'value' | 'number' | 'date' | 'select' | 'slot';
interface Argument { kind: Kind; choices: Set<string> }
interface Message {
  id: string;
  locale: string;
  source: string;
  ast?: MessageFormatElement[];
  args: Map<string, Argument>;
  emitted?: EmittedMessage;
  /** The complete text when the message is literal text only; such a message emits without its AST. */
  text?: string;
}
interface EmittedMessage {
  options: string; args: Map<string, Argument>; body: string; helpers: Helper[]; rich: boolean; texts?: string[]; templateEligible: boolean;
  /** The quoted text of a `$literal(...)` body, so assembly need not take it apart again. */
  literalText: string | undefined;
}
type Schema = Map<string, Map<string, Argument>>;
interface Formatter { key: string; kind: 'NumberFormat' | 'DateTimeFormat' | 'PluralRules'; locale: string; options: object }
interface Factory { key: string; kind: 'Factory'; body: string; parameters: number; dependencies: readonly Formatter[] }
type Helper = Formatter | Factory;
/** Temporary text collection for one render. Snapshots have independent,
 * compact storage; oversized scratch arrays are dropped before the next use. */
class TextBuffer {
  private values: string[] = [];
  private characters = 0;
  length = 0;
  reset(): this {
    if (this.values.length > 64 || this.characters > 4096) this.values = [];
    this.length = 0;
    this.characters = 0;
    return this;
  }
  push(value: string): void {
    this.values[this.length++] = value;
    this.characters += value.length;
  }
  slice(): string[] { return this.values.slice(0, this.length); }
}
interface Assembly {
  prefix: number;
  literals: number;
  rich: number;
  offsets: Uint32Array;
  signatures: Uint32Array;
  sequences: readonly (readonly Helper[])[];
  formatters: readonly Helper[];
  factories: ReadonlyMap<string, number>;
}
interface ColdCatalogTemplate {
  codeTail: string;
  fullTail: string;
  helpers: readonly Helper[];
  factories: ReadonlyMap<string, number>;
  literals: number;
  fullLiterals: number;
  rich: number;
}
interface RenderedCatalog { code: string; assembly?: Assembly; fullCode?: string; coldTemplate?: ColdCatalogTemplate }
interface CatalogOutput extends RenderedCatalog {
  schema: Schema; options: string; ids: readonly string[];
  catalog: Map<string, Message>; base: Map<string, Message>; messages: Message[];
  eligible: WeakSet<Map<string, Argument>> | null;
}
interface TypeGroupOutput {
  file: string;
  ids: readonly string[];
  namedOnly: boolean;
  split: boolean;
  contracts: readonly (Map<string, Argument> | undefined)[];
  docs: readonly string[];
  code: string;
}
interface TypeOutput {
  schema: Schema;
  ids: string[];
  docs: readonly string[];
  files: Record<string, string>;
  groups: readonly TypeGroupOutput[];
  layout: readonly DeclarationGroup[];
}
interface EmissionCache { entries: Map<Message, number>; bytes: number; limit: number }
function trimEmissions(cache: EmissionCache): void {
  // One iterator avoids rescanning Map tombstones for each eviction.
  for (const [old, cost] of cache.entries) {
    if (cache.bytes <= cache.limit) break;
    old.emitted = undefined;
    cache.entries.delete(old);
    cache.bytes -= cost;
  }
}
function forgetEmission(cache: EmissionCache, message: Message): void {
  const cost = cache.entries.get(message);
  if (cost === undefined) return;
  cache.entries.delete(message);
  cache.bytes -= cost;
  message.emitted = undefined;
}
interface CompilationState {
  parsed: Map<string, Map<string, Message>>;
  inputs: Map<string, { catalog: Catalog; arguments: Set<Map<string, Argument>> }>;
  schema: Schema;
  baseLocale: string;
  missing: CompilerOptions['missing'];
  warnings: Diagnostic[];
  outputs: Map<string, CatalogOutput>;
  types: Map<string, TypeOutput>;
  // Ordered IDs are shared by all generated artifacts. Keeping this identity
  // outside declaration state lets runtime-only sessions reuse catalog output.
  groupIds: Map<string, string[]>;
  argumentPool: Map<string, Map<string, Argument>>;
  argumentKeys: WeakMap<Map<string, Argument>, string>;
  emissions: EmissionCache;
}
const sameItems = <T>(a: readonly T[], b: readonly T[]) => a === b || (a.length === b.length && a.every((value, i) => value === b[i]));

// Unlike JSON.stringify alone, keep explicit undefined and non-finite numbers
// distinct. Both can affect Intl option validation or override named defaults.
function optionKey(value: unknown, parents = new Set<object>()): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'undefined': return 'undefined';
    case 'string': return JSON.stringify(value);
    case 'number': return `number:${String(value)}`;
    case 'boolean': return String(value);
    case 'object': {
      if (parents.has(value)) throw new TypeError('Format options must not contain cycles.');
      parents.add(value);
      const key = Array.isArray(value) ? `[${value.map(item => optionKey(item, parents)).join(',')}]`
        : `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}:${optionKey(item, parents)}`).join(',')}}`;
      parents.delete(value);
      return key;
    }
    default: throw new TypeError('Format options must contain only data.');
  }
}

const own = (object: object, key: PropertyKey) => Object.hasOwn(object, key);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
// Unicode mode treats a valid surrogate pair as one code point outside this
// range. Lone surrogates are valid property keys, but invalid ESM export names.
const unpairedSurrogate = /[\uD800-\uDFFF]/u;
const namedMessage = (id: string): boolean => id !== 'then' && id !== 'default' && !unpairedSurrogate.test(id);
// TypeScript 5.5 does not parse the newer string-literal export-alias form
// (`export { value as "arbitrary-key" }`) emitted by older declaration output.
// Keep arbitrary IDs in the default catalog type and only emit direct named
// exports for identifiers that are valid, non-reserved TypeScript names.
const declarationIdentifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const declarationReserved = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false',
  'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let',
  'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try',
  'typeof', 'var', 'void', 'while', 'with', 'yield',
  '__proto__', 'then', 'Key', 'messages', '$Messages', '$FlatMessages', '$Namespace',
  '$Nest', '$UnionToIntersection', '$Nested', 'MessageId', 'SelectedMessages',
  'Locale', 'Messages', 'LoadedLocale', 'LoadedSelection',
]);
const namedDeclaration = (id: string): boolean => namedMessage(id)
  && declarationIdentifier.test(id)
  && !declarationReserved.has(id)
  && !/^\$(?:m|T)\d+$/.test(id);
// Identifier properties are shorter than JSON-computed keys and remain safe
// for ordinary catalog IDs. Keep prototype-sensitive keys computed even on a
// null-prototype object because `__proto__` is special in object literals.
const identifierProperty = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const propertyKey = (id: string): string => id !== '__proto__' && identifierProperty.test(id) ? id : `[${quote(id)}]`;

function fail(code: string, message: string, context: Partial<Diagnostic> = {}): never {
  throw new CompileError([{ ...context, code, message }]);
}

function validateLocale(locale: string): void {
  try {
    const canonical = Intl.getCanonicalLocales(locale)[0];
    if (locale !== canonical) fail('INVALID_LOCALE', `Use the canonical locale ${quote(canonical)} instead of ${quote(locale)}.`, { locale });
  } catch (error) {
    if (error instanceof CompileError) throw error;
    fail('INVALID_LOCALE', `Invalid BCP 47 locale ${quote(locale)}.`, { locale });
  }
}

type Report = (diagnostic: Diagnostic) => void;
interface CatalogComparison { messages: ReadonlyMap<string, Message> | undefined; unchanged: boolean; changes?: { id: string; source: string }[] }
function flatten(catalog: Catalog, locale: string, report?: Report): Map<string, string>;
function flatten(catalog: Catalog, locale: string, report: undefined, comparison: CatalogComparison, snapshot?: boolean): Map<string, string | Message>;
function flatten(catalog: Catalog, locale: string, report?: Report, comparison?: CatalogComparison, snapshot = false): Map<string, string | Message> {
  const result = new Map<string, string | Message>();
  const ancestors = new Set<object>();
  function problem(code: string, message: string, messageId?: string): void {
    const diagnostic = { code, message, locale, ...(messageId === undefined ? {} : { messageId }) };
    if (report) report(diagnostic); else throw new CompileError([diagnostic]);
  }
  function visit(value: unknown, prefix: string): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { problem('INVALID_CATALOG', 'Expected an object containing strings or nested catalogs.', prefix); return; }
    if (ancestors.has(value)) { problem('INVALID_CATALOG', 'Catalog contains a circular reference.', prefix); return; }
    ancestors.add(value);
    for (const [key, entry] of Object.entries(value)) {
      if (!key) { problem('INVALID_KEY', 'Message keys must not be empty.', report ? prefix : undefined); continue; }
      const id = prefix ? `${prefix}.${key}` : key;
      if (typeof entry === 'string') {
        if (result.has(id)) { problem('DUPLICATE_KEY', `Nested and flat keys both resolve to ${quote(id)}.`, id); continue; }
        const cached = comparison?.messages?.get(id);
        const equal = cached?.source === entry;
        // Carry validated cached records into changed-table construction too,
        // so an edit near the end does not repeat every successful lookup.
        result.set(id, equal ? cached! : entry);
        if (comparison?.unchanged && !equal) comparison.unchanged = false;
        if (!equal && comparison?.changes) {
          // Bound temporary change tracking; added IDs need canonical rebuilding.
          if (!cached || comparison.changes.length === 32) comparison.changes = undefined;
          else comparison.changes.push({ id, source: entry });
        }
      } else visit(entry, id);
    }
    ancestors.delete(value);
  }
  // Private snapshots are owned JSON parse results. Their property reads have
  // no getters or mutation effects, so avoid an entry-pair array for every key.
  // Public catalogs keep Object.entries' eager reads in visit above.
  function visitSnapshot(value: unknown, prefix: string): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { problem('INVALID_CATALOG', 'Expected an object containing strings or nested catalogs.', prefix); return; }
    if (ancestors.has(value)) { problem('INVALID_CATALOG', 'Catalog contains a circular reference.', prefix); return; }
    ancestors.add(value);
    for (const key of Object.keys(value)) {
      if (!key) { problem('INVALID_KEY', 'Message keys must not be empty.', report ? prefix : undefined); continue; }
      const id = prefix ? `${prefix}.${key}` : key;
      const entry = (value as Catalog)[key];
      if (typeof entry === 'string') {
        if (result.has(id)) { problem('DUPLICATE_KEY', `Nested and flat keys both resolve to ${quote(id)}.`, id); continue; }
        const cached = comparison?.messages?.get(id);
        const equal = cached?.source === entry;
        result.set(id, equal ? cached! : entry);
        if (comparison?.unchanged && !equal) comparison.unchanged = false;
        if (!equal && comparison?.changes) {
          // Bound temporary change tracking; added IDs need canonical rebuilding.
          if (!cached || comparison.changes.length === 32) comparison.changes = undefined;
          else comparison.changes.push({ id, source: entry });
        }
      } else visitSnapshot(entry, id);
    }
    ancestors.delete(value);
  }
  // File-backed catalogs are owned JSON parse results, whatever the caller's mode.
  if (snapshot || isCatalogSnapshot(catalog)) visitSnapshot(catalog, ''); else visit(catalog, '');
  return result;
}

function argumentContext(message: Message, name: string): Partial<Diagnostic> {
  function find(nodes: MessageFormatElement[]): Partial<Diagnostic> | undefined {
    for (const node of nodes) {
      if (node.type === TYPE.literal || node.type === TYPE.pound) continue;
      if (node.value === name) return node.location?.start;
      if (node.type === TYPE.tag) { const found = find(node.children); if (found) return found; }
      else if (node.type === TYPE.select || node.type === TYPE.plural) {
        for (const branch of Object.values(node.options)) { const found = find(branch.value); if (found) return found; }
      }
    }
  }
  const ast = message.ast ?? parse(message.source, { captureLocation: true, shouldParseSkeletons: false });
  return { locale: message.locale, messageId: message.id, source: message.source, ...find(ast) };
}

/** `context` may be a function, so callers build diagnostic context only on failure. */
function mergeArgument(target: Map<string, Argument>, name: string, arg: Argument, context: Partial<Diagnostic> | (() => Partial<Diagnostic>), message?: Message): void {
  const previous = target.get(name);
  if (!previous) { target.set(name, { kind: arg.kind, choices: new Set(arg.choices) }); return; }
  const where = () => message ? argumentContext(message, name) : typeof context === 'function' ? context() : context;
  if ((previous.kind === 'slot' || arg.kind === 'slot') && previous.kind !== arg.kind) {
    fail('ARGUMENT_TYPE_CONFLICT', `${quote(name)} is used as both ${previous.kind} and ${arg.kind}. Use separate names for values and rich-text slots.`, where());
  }
  if (previous.kind === 'value') previous.kind = arg.kind;
  else if (arg.kind !== 'value' && arg.kind !== previous.kind) {
    fail('ARGUMENT_TYPE_CONFLICT', `${quote(name)} is used as both ${previous.kind} and ${arg.kind}. Use separate arguments.`, where());
  }
  for (const choice of arg.choices) previous.choices.add(choice);
}

// Parser and emitter recursion is limited by the JavaScript stack, not by ICU.
function isStackOverflow(error: unknown): boolean {
  return error instanceof RangeError && /call stack/i.test(error.message);
}

function tooDeep(context: Partial<Diagnostic>): never {
  fail('MESSAGE_TOO_DEEP', 'The message is nested too deeply to compile.', { ...context,
    hint: 'Flatten nested select/plural branches, or split the message into smaller messages.' });
}

// Interned contracts are never mutated (schema merging copies first), so
// messages without arguments, and arguments without choices, share these.
const noArguments = new Map<string, Argument>();
const noChoices = new Set<string>();
// Quotes, tags and line terminators always take the ICU parser.
const parserCharacters = /['<\r\n\u2028\u2029]/;
const identifierStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;
const identifierPart = (c: number) => identifierStart(c) || (c >= 48 && c <= 57);

/** Plain one-line text and simple ASCII placeholders need none of the ICU
 * parser's plural/skeleton machinery. Returns undefined at the first
 * non-simple opening brace, so acceptance and diagnostics stay parser-defined. */
function simpleMessage(id: string, source: string, locale: string): Message | undefined {
  if (parserCharacters.test(source)) return;
  let open = source.indexOf('{');
  // Literal nodes carry no location: diagnostics only locate arguments and formats.
  if (open < 0) return { id, locale, source, ast: source ? [{ type: TYPE.literal, value: source }] : [], args: noArguments, emitted: undefined, text: source };
  const ast: MessageFormatElement[] = [];
  let args: Map<string, Argument> | undefined;
  let position = 0;
  for (; ; open = source.indexOf('{', position)) {
    const end = open < 0 ? source.length : open;
    if (end > position) ast.push({ type: TYPE.literal, value: source.slice(position, end) });
    if (open < 0) break;
    let close = open + 1;
    if (!identifierStart(source.charCodeAt(close))) return;
    while (identifierPart(source.charCodeAt(++close)));
    if (source.charCodeAt(close) !== 125) return;
    const name = source.slice(open + 1, close++);
    ast.push({ type: TYPE.argument, value: name,
      location: { start: { offset: open, line: 1, column: open + 1 }, end: { offset: close, line: 1, column: close + 1 } } });
    args ??= new Map();
    if (!args.has(name)) args.set(name, { kind: 'value', choices: noChoices });
    position = close;
    if (position === source.length) break;
  }
  return { id, locale, source, ast, args: args ?? noArguments, emitted: undefined };
}

function readMessage(id: string, source: string, locale: string, intlLocale: Intl.Locale): Message {
  return simpleMessage(id, source, locale) ?? parsedMessage(id, source, locale, intlLocale);
}

// ASCII name characters that are identifier characters for the ICU parser too.
// "$" is ICU pattern syntax, so names containing it take the parser.
const icuNamePart = (c: number) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95;
const surrogates = /[\ud800-\udfff]/;
let structuredSource = '', structuredAt = 0;
// Deeper messages take the ICU parser, whose own stack limit decides MESSAGE_TOO_DEEP.
const structuredDepthLimit = 16;
const span = (start: number, end: number) => ({ start: { offset: start, line: 1, column: start + 1 }, end: { offset: end, line: 1, column: end + 1 } });
function skipSpaces(): void {
  while (structuredSource.charCodeAt(structuredAt) === 32) structuredAt++;
}

/** The ICU parser's AST for one-line text with placeholders and
 * plural/select/selectordinal arguments whose selectors are plain names or
 * `=N`, without quotes, tags, offsets or astral characters. Returns undefined
 * for anything else, so the ICU parser keeps defining acceptance and
 * diagnostics. Located nodes match the parser's locations; literal, pound and
 * option nodes carry none, as diagnostics never locate them. */
function structuredAst(source: string): MessageFormatElement[] | undefined {
  if (parserCharacters.test(source) || surrogates.test(source)) return;
  structuredSource = source;
  structuredAt = 0;
  try { return structuredMessage(false, false, 0); }
  catch (error) { if (isStackOverflow(error)) return; throw error; }
  finally { structuredSource = ''; }
}
function structuredMessage(nested: boolean, pound: boolean, depth: number): MessageFormatElement[] | undefined {
  const source = structuredSource, nodes: MessageFormatElement[] = [];
  while (structuredAt < source.length) {
    const c = source.charCodeAt(structuredAt);
    if (c === 123) {
      const node = structuredArgument(depth);
      if (!node) return;
      nodes.push(node);
    } else if (c === 125 && nested) break;
    else if (c === 35 && pound) { nodes.push({ type: TYPE.pound }); structuredAt++; }
    else {
      const start = structuredAt;
      while (++structuredAt < source.length) {
        const d = source.charCodeAt(structuredAt);
        if (d === 123 || (d === 125 && nested) || (d === 35 && pound)) break;
      }
      nodes.push({ type: TYPE.literal, value: source.slice(start, structuredAt) });
    }
  }
  return nodes;
}
function structuredArgument(depth: number): MessageFormatElement | undefined {
  const source = structuredSource, open = structuredAt++;
  skipSpaces();
  let start = structuredAt;
  while (icuNamePart(source.charCodeAt(structuredAt))) structuredAt++;
  if (structuredAt === start) return;
  const value = source.slice(start, structuredAt);
  skipSpaces();
  const next = source.charCodeAt(structuredAt++);
  if (next === 125) return { type: TYPE.argument, value, location: span(open, structuredAt) };
  if (next !== 44) return;
  skipSpaces();
  start = structuredAt;
  while (icuNamePart(source.charCodeAt(structuredAt))) structuredAt++;
  const kind = source.slice(start, structuredAt);
  if ((kind !== 'plural' && kind !== 'select' && kind !== 'selectordinal') || depth === structuredDepthLimit) return;
  const plural = kind !== 'select';
  skipSpaces();
  if (source.charCodeAt(structuredAt++) !== 44) return;
  skipSpaces();
  const entries: [string, { value: MessageFormatElement[] }][] = [];
  let other = false;
  for (;;) {
    start = structuredAt;
    if (plural && source.charCodeAt(structuredAt) === 61) {
      while (source.charCodeAt(++structuredAt) >= 48 && source.charCodeAt(structuredAt) <= 57);
      // Up to 15 digits is always a safe integer.
      if (structuredAt === start + 1 || structuredAt - start > 16) return;
    } else {
      while (icuNamePart(source.charCodeAt(structuredAt))) structuredAt++;
      if (structuredAt === start) break;
    }
    const selector = source.slice(start, structuredAt);
    if ((plural && selector === 'offset') || entries.some(entry => entry[0] === selector)) return;
    if (selector === 'other') other = true;
    skipSpaces();
    if (source.charCodeAt(structuredAt++) !== 123) return;
    const branch = structuredMessage(true, plural, depth + 1);
    if (!branch || source.charCodeAt(structuredAt++) !== 125) return;
    entries.push([selector, { value: branch }]);
    skipSpaces();
  }
  if (!other || source.charCodeAt(structuredAt++) !== 125) return;
  const options = Object.fromEntries(entries);
  return plural
    ? { type: TYPE.plural, value, options, offset: 0, pluralType: kind === 'plural' ? 'cardinal' : 'ordinal', location: span(open, structuredAt) }
    : { type: TYPE.select, value, options, location: span(open, structuredAt) };
}

function parseAst(source: string, locale: Intl.Locale): MessageFormatElement[] {
  return structuredAst(source) ?? parse(source, { captureLocation: true, shouldParseSkeletons: true, locale });
}

function parsedMessage(id: string, source: string, locale: string, intlLocale: Intl.Locale): Message {
  const context = { locale, messageId: id, source };
  let ast: MessageFormatElement[];
  try {
    ast = parseAst(source, intlLocale);
  } catch (error) {
    if (isStackOverflow(error)) tooDeep(context);
    const e = error as Error & { location?: { start: { line: number; column: number; offset: number } } };
    const description = describeIcuError(e.message);
    fail('INVALID_ICU', description.message, { ...context, ...description, ...e.location?.start });
  }
  const args = new Map<string, Argument>();
  function visit(nodes: MessageFormatElement[]): void {
    for (const node of nodes) {
      if (node.type === TYPE.literal || node.type === TYPE.pound) continue;
      if (node.type === TYPE.tag) {
        mergeArgument(args, node.value, { kind: 'slot', choices: noChoices }, () => ({ ...context, ...node.location?.start }));
        visit(node.children);
        continue;
      }
      const kind: Kind = node.type === TYPE.number || node.type === TYPE.plural ? 'number'
        : node.type === TYPE.date || node.type === TYPE.time ? 'date'
        : node.type === TYPE.select ? 'select' : 'value';
      const choices = node.type === TYPE.select ? new Set(Object.keys(node.options).filter(key => key !== 'other')) : noChoices;
      mergeArgument(args, node.value, { kind, choices }, () => ({ ...context, ...node.location?.start }));
      if (node.type === TYPE.select || node.type === TYPE.plural) for (const branch of Object.values(node.options)) visit(branch.value);
    }
  }
  try { visit(ast); } catch (error) { if (isStackOverflow(error)) tooDeep(context); throw error; }
  if (args.size) return { id, locale, source, ast, args, emitted: undefined };
  // Escaped quotes and similar can still leave literal text only.
  let text: string | undefined = '';
  for (const node of ast) if (node.type === TYPE.literal) text += node.value; else { text = undefined; break; }
  return { id, locale, source, ast, args: noArguments, emitted: undefined, text };
}

function typeOf(arg: Argument): string {
  if (arg.kind === 'slot') return '(children: Array<string | $Node>) => $Node';
  if (arg.kind === 'number') return 'number';
  if (arg.kind === 'date') return 'Date | number';
  if (arg.kind === 'select') return [
    ...[...arg.choices].sort().map(quote),
    '(string & {})',
    ...(arg.choices.has('true') || arg.choices.has('false') ? ['boolean'] : []),
  ].join(' | ');
  return 'string | number';
}

function selectCase(key: string): string {
  // Boolean selectors are common in application catalogs. Match them without
  // stringifying the hot string path, which keeps ordinary selects as fast as
  // a direct JavaScript switch while retaining FormatJS-compatible behavior.
  const primitive = key === 'true' ? 'case true:' : key === 'false' ? 'case false:' : '';
  return `${primitive}case ${quote(key)}:`;
}

const dateFormats: Record<string, Intl.DateTimeFormatOptions> = {
  short: { month: 'numeric', day: 'numeric', year: '2-digit' },
  medium: { month: 'short', day: 'numeric', year: 'numeric' },
  long: { month: 'long', day: 'numeric', year: 'numeric' },
  full: { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' },
};
const timeFormats: Record<string, Intl.DateTimeFormatOptions> = {
  short: { hour: 'numeric', minute: 'numeric' },
  medium: { hour: 'numeric', minute: 'numeric', second: 'numeric' },
  long: { hour: 'numeric', minute: 'numeric', second: 'numeric', timeZoneName: 'short' },
  full: { hour: 'numeric', minute: 'numeric', second: 'numeric', timeZoneName: 'short' },
};

const numberFormats: Record<string, Intl.NumberFormatOptions> = {
  integer: { maximumFractionDigits: 0 },
  percent: { style: 'percent' },
  currency: { style: 'currency' },
};
// A user format that reuses a built-in name merges with that preset, so the
// combined options may conflict (for example dateStyle with field options).
function presetConflict(reason: string, node: MessageFormatElement, options: CompilerOptions): string {
  if (node.type !== TYPE.number && node.type !== TYPE.date && node.type !== TYPE.time) return reason;
  if (typeof node.style !== 'string' || !node.style) return reason;
  const kind = node.type === TYPE.number ? 'number' : node.type === TYPE.date ? 'date' : 'time';
  const defaults = kind === 'date' ? dateFormats : kind === 'time' ? timeFormats : numberFormats;
  if (!options.formats?.[kind] || !own(options.formats[kind]!, node.style) || !own(defaults, node.style)) return reason;
  return `Custom ${kind} format ${quote(node.style)} merges with the built-in ${node.style} preset, and the combined options are invalid (${reason}). Give the custom format a distinct name, such as ${quote(node.style + 'Custom')}.`;
}

function formatOptions(node: NumberElement | DateElement | TimeElement, message: Message, options: CompilerOptions): { options: object; scale?: number } {
  const kind = node.type === TYPE.number ? 'number' : node.type === TYPE.date ? 'date' : 'time';
  let resolved: Record<string, unknown>;
  if (typeof node.style === 'object' && node.style !== null) resolved = { ...node.style.parsedOptions };
  else if (node.style) {
    const custom = options.formats?.[kind];
    const defaults = kind === 'date' ? dateFormats : kind === 'time' ? timeFormats : numberFormats;
    if (custom && own(custom, node.style)) resolved = { ...(own(defaults, node.style) ? defaults[node.style as keyof typeof defaults] : {}), ...custom[node.style] };
    else if (own(defaults, node.style)) resolved = { ...defaults[node.style as keyof typeof defaults] };
    else fail('UNKNOWN_FORMAT', `Unknown ${kind} format ${quote(node.style)}. Declare it in formats.${kind}.`, { locale: message.locale, messageId: message.id, source: message.source, ...node.location?.start });
  } else resolved = kind === 'time' ? { ...timeFormats.medium } : {};
  if (kind !== 'number' && options.timeZone && !own(resolved, 'timeZone')) resolved.timeZone = options.timeZone;
  const scale = resolved.scale as number | undefined;
  delete resolved.scale;
  return { options: resolved, scale };
}

function formatterKey(kind: Formatter['kind'], locale: string, options: object): string {
  return `Intl:${kind}:${JSON.stringify(locale)}:${formatterOptionsKey(kind, options)}`;
}
function formatterOptionsKey(kind: Formatter['kind'], options: object): string {
  const entries = Object.entries(options);
  // Empty number/date options and the single plural type account for nearly
  // every formatter reference in ordinary catalogs. Their identity needs to
  // be collision-free, but not a recursively serialized array on every use.
  if (!entries.length) return '{}';
  if (kind === 'PluralRules' && entries.length === 1 && entries[0]![0] === 'type'
    && (entries[0]![1] === 'cardinal' || entries[0]![1] === 'ordinal')) {
    return entries[0]![1];
  }
  return optionKey(entries.sort(([a], [b]) => compare(a, b)));
}
// Shared, never-mutated option objects for the formatters every plural uses.
const noFormatOptions = Object.freeze({});
const pluralOptions = { cardinal: Object.freeze({ type: 'cardinal' }), ordinal: Object.freeze({ type: 'ordinal' }) };
/** Canonical text of a format style: named format, number skeleton tokens or
 * (locale-resolved) date pattern. Equal signatures resolve to equal options. */
function styleSignature(node: NumberElement | DateElement | TimeElement): string {
  const style = node.style;
  if (!style) return `${node.type}`;
  if (typeof style === 'string') return `${node.type}:${style}`;
  // Skeleton stems and options contain neither "/" nor whitespace, so this join is unambiguous.
  return 'tokens' in style ? `${node.type}#${style.tokens.map(token => [token.stem, ...token.options].join('/')).join(' ')}` : `${node.type}@${style.pattern}`;
}

function validateFormatter(kind: Formatter['kind'], locale: string, opts: object, message: Message): void {
  // Default number options cannot fail for a validated locale. Skipping these
  // spares loading ICU number data when nothing else needs it.
  if (kind === 'NumberFormat' && latinDigitLocale(locale) && !Object.keys(opts).length) return;
  try {
    if (kind === 'NumberFormat') new Intl.NumberFormat(locale, opts);
    else if (kind === 'DateTimeFormat') new Intl.DateTimeFormat(locale, opts);
    else new Intl.PluralRules(locale, opts);
  } catch (error) { fail('INVALID_FORMAT', (error as Error).message, { locale, messageId: message.id }); }
}

// Integers below 200 select the same category for a locale and plural type
// every time. Their categories are precomputed here so generated code avoids
// Intl on hot paths. Other inputs keep using the Intl selector.
const pluralTables = new Map<string, { categories: string[]; index: string }>();
function pluralTable(locale: string, type: string): { categories: string[]; index: string } {
  const key = JSON.stringify([locale, type]);
  let table = pluralTables.get(key);
  if (!table) {
    const rules = new Intl.PluralRules(locale, { type: type as Intl.PluralRulesOptions['type'] });
    const categories: string[] = [];
    let index = '';
    for (let n = 0; n < 200; n++) {
      const category = rules.select(n);
      let position = categories.indexOf(category);
      if (position < 0) position = categories.push(category) - 1;
      index += position;
    }
    table = { categories, index };
    pluralTables.set(key, table);
  }
  return table;
}
// Plain integers below 1000 are the same text as String(n) only where the
// default number format uses Latin digits and no grouping or decimals there.
// Languages whose CLDR default digits are native, or changed between ICU
// releases, stay on Intl so a browser's ICU decides rather than the build's.
const nativeDigitLanguages = new Set(['ar', 'as', 'bgn', 'bn', 'ckb', 'dz', 'fa', 'ks', 'lrc', 'mni', 'mr', 'my', 'mzn', 'ne', 'ps', 'sa', 'sat', 'sd', 'ur']);
const nativeDigitScripts = new Set(['Arab', 'Aran', 'Beng', 'Deva', 'Mtei', 'Mymr', 'Olck', 'Tibt']);
// Languages whose CLDR default numbering has always been Latin, written left
// to right, so their integers below 1000 are plain digits in every ICU. Their
// bare and region-only tags skip loading ICU number data during a build;
// scripts, variants and extensions such as -u-nu- keep the Intl check.
const latinDigitLanguages = new Set(['cs', 'da', 'de', 'el', 'en', 'es', 'fi', 'fr', 'hu', 'id', 'it', 'ja', 'ko', 'nb', 'nl', 'nn', 'pl', 'pt', 'ro', 'ru', 'sk', 'sv', 'tr', 'uk', 'vi', 'zh']);
const latinDigitTag = /^([a-z]{2,3})(?:-(?:[A-Z]{2}|\d{3}))?$/;
function latinDigitLocale(locale: string): boolean {
  const match = latinDigitTag.exec(locale);
  return !!match && latinDigitLanguages.has(match[1]!);
}
const plainDigitLocales = new Map<string, boolean>();
function plainDigits(locale: string): boolean {
  let plain = plainDigitLocales.get(locale);
  if (plain === undefined && latinDigitLocale(locale)) plainDigitLocales.set(locale, plain = true);
  if (plain === undefined) {
    const format = new Intl.NumberFormat(locale);
    const tag = new Intl.Locale(locale);
    plain = format.resolvedOptions().numberingSystem === 'latn' && !nativeDigitLanguages.has(tag.language) && !nativeDigitScripts.has(tag.script ?? '');
    for (let n = 0; plain && n < 1000; n++) plain = format.format(n) === String(n);
    plainDigitLocales.set(locale, plain);
  }
  return plain;
}

function scopeIds(scope: string, patterns: readonly string[], ids: readonly string[], knownIds: { has(id: string): boolean }, report?: Report, blocked?: (id: string) => boolean): string[] {
  function problem(code: string, message: string): void {
    if (report) report({ code, message }); else fail(code, message);
  }
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(scope)) { problem('INVALID_SCOPE', `Invalid scope name ${quote(scope)}.`); return []; }
  if (!Array.isArray(patterns) || !patterns.length || patterns.some(p => typeof p !== 'string')) {
    problem('INVALID_SCOPE', `Scope ${quote(scope)} must contain message IDs or prefix patterns.`); return [];
  }
  const selected = new Set<string>();
  for (const pattern of patterns) {
    let matched = false;
    if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -1);
      for (const id of ids) if (id.startsWith(prefix)) { selected.add(id); matched = true; }
    } else if (knownIds.has(pattern)) {
      selected.add(pattern);
      matched = true;
    }
    if (!matched && !blocked?.(pattern)) problem('EMPTY_SCOPE_PATTERN', `Scope ${quote(scope)} pattern ${quote(pattern)} does not match any messages.`);
  }
  return ids.filter(id => selected.has(id));
}

function argumentKey(args: Map<string, Argument>): string {
  // Most contracts have no arguments or one unqualified argument. These keys
  // cannot collide with the JSON-array encoding used for compound contracts.
  if (!args.size) return '';
  if (args.size === 1) {
    const [name, arg] = args.entries().next().value!;
    if (!arg.choices.size) return `${arg.kind}:${name}`;
  }
  // Same text as the JSON encoding below, built directly when no argument has choices.
  let key = '[';
  for (const [name, arg] of args) {
    if (arg.choices.size) return JSON.stringify([...args].map(([name, arg]) => [name, arg.kind, [...arg.choices].sort()]));
    key += `${key.length > 1 ? ',' : ''}[${JSON.stringify(name)},"${arg.kind}",[]]`;
  }
  return key + ']';
}

/** Distinct argument sets cannot share emitted code. Cached schemas preserve
 * argument identities, so compatible edit assemblies can reuse this filter. */
function factoryEligibility(messages: readonly Message[], schema: Schema): WeakSet<Map<string, Argument>> | null {
  const counts = new Map<Map<string, Argument>, number>();
  for (const message of messages) if (schema.get(message.id)!.size) counts.set(message.args, (counts.get(message.args) ?? 0) + 1);
  let eligible: WeakSet<Map<string, Argument>> | null = null;
  for (const [args, count] of counts) if (count > 1) { eligible ??= new WeakSet(); eligible.add(args); }
  return eligible;
}

type CatalogLayout = 'public' | 'full' | 'shared';
type ColdEmissionCache = WeakMap<Map<string, Argument>, Map<string, EmittedMessage>>;

function renderCatalog(messages: Message[], schema: Schema, options: CompilerOptions, memoKey?: string, emissions?: EmissionCache, previous?: CatalogOutput, eligible: WeakSet<Map<string, Argument>> | null = null, validations?: Map<Map<string, Argument>, string>, layout: CatalogLayout = 'public', sharedEmissions?: Map<Message, EmittedMessage>, coldEmissions?: ColdEmissionCache, coldTemplate?: ColdCatalogTemplate, catalogLocale?: string, fullSharedIds?: ReadonlySet<string>, fullSharedImport = '../shared.js'): RenderedCatalog {
  const includedSourceIds = Array.isArray(options.includeSources) ? new Set(options.includeSources) : undefined;
  const helpers = new Map<string, Helper & { id: string }>();
  const intlLocales = new Map<string, Intl.Locale>();
  // Direct, one-pass output never renumbers helpers. Only cached emissions and
  // template assembly need relocatable references and dependency sequences.
  // Full modules reuse emissions produced by the public module even when no
  // shared factory is eligible. Their formatter references still use the
  // relocatable sentinel form and must be resolved into this module's helper
  // table without allocating a second incremental assembly.
  const relocatable = layout === 'full' || emissions !== undefined || eligible !== null || coldEmissions !== undefined;
  let captured: Helper[] = [];
  let texts: TextBuffer | undefined;
  let textBuffer: TextBuffer | undefined;
  let lastFactory: Factory | undefined;
  let literalGrowth = 128;
  let literalInitializers: string[] | undefined;
  let literalParameters: Map<object, string> | undefined;
  const validatedLocalizedHelpers = new Set<string>();
  const localizedHelpers = new Map<string, Map<Helper, Helper>>();
  function register(spec: Helper): string {
    if (!helpers.has(spec.key)) helpers.set(spec.key, { ...spec, id: `$f${helpers.size}` });
    return helpers.get(spec.key)!.id;
  }
  // Interned keys: reusing one string instance per (kind, options, locale)
  // keeps its hash cached for every helper lookup.
  const formatterKeys: Record<Formatter['kind'], Map<string, Map<string, string>>> = { NumberFormat: new Map(), DateTimeFormat: new Map(), PluralRules: new Map() };
  // Options never depend on the locale (date patterns are already resolved),
  // so each distinct style is resolved and serialized once per render.
  const resolvedStyles = new Map<string, { options: object; scale?: number; key: string }>();
  function styleFormatter(node: NumberElement | DateElement | TimeElement, message: Message): { name: string; scale?: number } {
    const signature = styleSignature(node);
    let resolved = resolvedStyles.get(signature);
    if (!resolved) {
      const { options: opts, scale } = formatOptions(node, message, options);
      resolved = { options: opts, scale, key: formatterOptionsKey(node.type === TYPE.number ? 'NumberFormat' : 'DateTimeFormat', opts) };
      resolvedStyles.set(signature, resolved);
    }
    return { name: formatter(node.type === TYPE.number ? 'NumberFormat' : 'DateTimeFormat', message.locale, resolved.options, message, node, resolved.key), scale: resolved.scale };
  }
  function pluralRule(type: Intl.PluralRulesOptions['type'], message: Message): string {
    return type ? formatter('PluralRules', message.locale, pluralOptions[type], message, undefined, type) : formatter('PluralRules', message.locale, { type }, message);
  }
  function formatter(kind: 'NumberFormat' | 'DateTimeFormat' | 'PluralRules', locale: string, opts: object, message: Message, node?: MessageFormatElement, optionsKey?: string): string {
    optionsKey ??= formatterOptionsKey(kind, opts);
    let byLocale = formatterKeys[kind].get(optionsKey);
    if (!byLocale) formatterKeys[kind].set(optionsKey, byLocale = new Map());
    let key = byLocale.get(locale);
    if (key === undefined) byLocale.set(locale, key = `Intl:${kind}:${JSON.stringify(locale)}:${optionsKey}`);
    // Validate statically known options during compilation, not on a user's first call.
    if (!helpers.has(key)) {
      try { validateFormatter(kind, locale, opts, message); }
      catch (error) {
        if (node && error instanceof CompileError) fail('INVALID_FORMAT', presetConflict(error.diagnostics[0]!.message, node, options), { locale, messageId: message.id, source: message.source, ...node.location?.start });
        throw error;
      }
      register({ key, kind, locale, options: opts });
    }
    const spec = helpers.get(key)!;
    if (!relocatable) return spec.id;
    let index = captured.indexOf(spec);
    if (index < 0) { index = captured.length; captured.push(spec); }
    // JSON quoting escapes every control character in user text. Actual NULs
    // therefore only occur in these internal formatter references, never literals.
    return `\0${index}\0`;
  }
  function emitLiteralSelect(select: LiteralSelect): string {
    let branches = '', fallback = '';
    for (const [key, branch] of select.branches) {
      let code: string;
      if ('branches' in branch) code = emitLiteralSelect(branch);
      else if (texts) {
        literalInitializers ??= [];
        literalParameters ??= new Map();
        const parameters: string[] = [];
        for (const text of branch.texts) if (text.value) {
          let parameter = literalParameters.get(text);
          if (!parameter) { texts.push(text.value); parameter = `$s${texts.length - 1}`; literalParameters.set(text, parameter); }
          parameters.push(parameter);
        }
        code = `$c${literalInitializers.length}`;
        literalInitializers.push(parameters.join('+') || '""');
      } else code = quote(branch.texts.map(text => text.value).join(''));
      if (key === 'other') fallback = code;
      else branches += `${selectCase(key)}return ${code};`;
    }
    return `(()=>{switch(p[${quote(select.value)}]){${branches}default:return ${fallback};}})()`;
  }
  function emit(nodes: MessageFormatElement[], message: Message, pound?: string): string {
    function emitNode(node: MessageFormatElement): string {
      if (node.type === TYPE.literal) {
        if (texts && node.value) { texts.push(node.value); return `$s${texts.length - 1}`; }
        return quote(node.value);
      }
      if (node.type === TYPE.pound) {
        if (pound === undefined) return quote('#');
        return `${formatter('NumberFormat', message.locale, noFormatOptions, message, undefined, '{}')}(${pound})`;
      }
      if (node.type === TYPE.tag) throw new Error('Rich text reached the string emitter');
      const value = `p[${quote(node.value)}]`;
      switch (node.type) {
        case TYPE.argument: return value;
        case TYPE.number:
        case TYPE.date:
        case TYPE.time: {
          const { name, scale } = styleFormatter(node, message);
          return `${name}(${scale !== undefined ? `(${value}*${quote(scale)})` : value})`;
        }
        case TYPE.select: {
          let branches = '';
          for (const key of Object.keys(node.options)) if (key !== 'other') branches += `${selectCase(key)}return ${emit(node.options[key]!.value, message, pound)};`;
          return `(()=>{switch(${value}){${branches}default:return ${emit(node.options.other!.value, message, pound)};}})()`;
        }
        case TYPE.plural: {
          const count = node.offset ? `(${value}-${node.offset})` : value;
          // Exact matches first, then categories: emission order decides helper numbering.
          const keys = Object.keys(node.options);
          let exact = '', branches = '';
          for (const key of keys) if (key.startsWith('=')) exact += `if(${value}===${Number(key.slice(1))})return ${emit(node.options[key]!.value, message, count)};`;
          for (const key of keys) if (key !== 'other' && !key.startsWith('=')) branches += `case ${quote(key)}:return ${emit(node.options[key]!.value, message, count)};`;
          const rule = pluralRule(node.pluralType, message);
          return `(()=>{${exact}switch(${rule}(${count})){${branches}default:return ${emit(node.options.other!.value, message, count)};}})()`;
        }
      }
    }
    const parts: string[] = [];
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index]!;
      const position = node.type === TYPE.literal ? index + 1 : index;
      const select = nodes[position];
      if ((node.type === TYPE.literal || node.type === TYPE.select) && select?.type === TYPE.select) {
        const prefix = node.type === TYPE.literal ? node : undefined;
        const after = nodes[position + 1];
        const suffix = after?.type === TYPE.literal ? after : undefined;
        // Removing all concatenation from this text segment is consistently
        // useful; partial folding regresses some engines and remains unchanged.
        const complete = index === 0 && position + 1 + Number(!!suffix) === nodes.length;
        const folded = complete && (prefix?.value || suffix?.value) && foldLiteralSelect(select, prefix, suffix, literalGrowth);
        if (folded) {
          literalGrowth -= folded.growth;
          parts.push(emitLiteralSelect(folded.select));
          index = position + Number(after?.type === TYPE.literal);
          continue;
        }
      }
      parts.push(emitNode(node));
    }
    let code = '""';
    for (const part of parts) code += '+' + part;
    return code;
  }
  function hasTags(node: MessageFormatElement): boolean {
    return node.type === TYPE.tag || ((node.type === TYPE.select || node.type === TYPE.plural)
      && Object.values(node.options).some(branch => branch.value.some(hasTags)));
  }
  function emitRich(nodes: MessageFormatElement[], message: Message, pound?: string): string {
    const parts: { code: string; spread: boolean }[] = [];
    let text: MessageFormatElement[] = [];
    const flush = () => {
      if (text.length) { parts.push({ code: emit(text, message, pound), spread: false }); text = []; }
    };
    for (const node of nodes) {
      if (!hasTags(node)) { text.push(node); continue; }
      flush();
      if (node.type === TYPE.tag) {
        parts.push({ code: `p[${quote(node.value)}](${emitRich(node.children, message, pound)})`, spread: false });
      } else if (node.type === TYPE.select) {
        const value = `p[${quote(node.value)}]`;
        let branches = '';
        for (const key of Object.keys(node.options)) if (key !== 'other') branches += `${selectCase(key)}return ${emitRich(node.options[key]!.value, message, pound)};`;
        parts.push({ code: `(()=>{switch(${value}){${branches}default:return ${emitRich(node.options.other!.value, message, pound)};}})()`, spread: true });
      } else if (node.type === TYPE.plural) {
        const value = `p[${quote(node.value)}]`, count = node.offset ? `(${value}-${node.offset})` : value;
        const keys = Object.keys(node.options);
        let exact = '', branches = '';
        for (const key of keys) if (key.startsWith('=')) exact += `if(${value}===${Number(key.slice(1))})return ${emitRich(node.options[key]!.value, message, count)};`;
        for (const key of keys) if (key !== 'other' && !key.startsWith('=')) branches += `case ${quote(key)}:return ${emitRich(node.options[key]!.value, message, count)};`;
        const rule = pluralRule(node.pluralType, message);
        parts.push({ code: `(()=>{${exact}switch(${rule}(${count})){${branches}default:return ${emitRich(node.options.other!.value, message, count)};}})()`, spread: true });
      }
    }
    flush();
    if (parts.length === 1 && parts[0]!.spread) return parts[0]!.code;
    const array = `[${parts.map(part => `${part.spread ? '...' : ''}${part.code}`).join(',')}]`;
    return parts.length > 1 ? `$parts(${array})` : array;
  }
  function localizeHelper(helper: Helper, message: Message): Helper {
    let localized = localizedHelpers.get(message.locale);
    if (!localized) { localized = new Map(); localizedHelpers.set(message.locale, localized); }
    const existing = localized.get(helper);
    if (existing) return existing;
    if (helper.kind === 'Factory') {
      const dependencies = helper.dependencies.map(dependency => localizeHelper(dependency, message) as Formatter);
      const factory: Factory = { ...helper, dependencies,
        key: 'Factory:' + JSON.stringify([helper.body, dependencies.map(dependency => dependency.key)]) };
      localized.set(helper, factory);
      return factory;
    }
    if (helper.locale === message.locale) { localized.set(helper, helper); return helper; }
    const formatter: Formatter = { ...helper, locale: message.locale,
      key: formatterKey(helper.kind, message.locale, helper.options) };
    if (!validatedLocalizedHelpers.has(formatter.key)) {
      validateFormatter(formatter.kind, formatter.locale, formatter.options, message);
      validatedLocalizedHelpers.add(formatter.key);
    }
    localized.set(helper, formatter);
    return formatter;
  }
  function messageEmission(message: Message): EmittedMessage {
    const args = schema.get(message.id)!;
    let emitted = sharedEmissions?.get(message) ?? message.emitted;
    // Literal text needs neither its AST nor a shared cold emission: the body
    // is its quoted text, which is cheaper to build than to look up.
    if (!args.size && message.text !== undefined) {
      if (memoKey === undefined || !emitted || emitted.options !== memoKey || emitted.args !== args || emitted.templateEligible) {
        const literalText = quote(message.text);
        emitted = { options: memoKey ?? '', args, body: `/*#__PURE__*/$literal(${literalText})`, helpers: [], rich: false, templateEligible: false, literalText };
        if (memoKey !== undefined) {
          message.emitted = emitted;
          message.ast = undefined;
        }
      }
      return retain(message, emitted);
    }
    const templateEligible = !!args.size && !!eligible?.has(message.args);
    const coldBySource = memoKey === undefined && !options.development && coldEmissions
      ? coldEmissions.get(args) ?? new Map<string, EmittedMessage>() : undefined;
    if (coldBySource && !coldEmissions!.has(args)) coldEmissions!.set(args, coldBySource);
    // Skeletons such as ::jm resolve the hour cycle per locale, so their
    // sources share a cold emission only within one message locale.
    const coldKey = !coldBySource ? undefined : message.source.includes('::') ? `${message.locale}\0${message.source}` : message.source;
    const sharedCold = coldKey === undefined ? undefined : coldBySource!.get(coldKey);
    let reusedCold = false;
    if (!emitted && sharedCold && sharedCold.templateEligible === templateEligible) {
      emitted = { ...sharedCold, helpers: sharedCold.helpers.map(helper => localizeHelper(helper, message)) };
      reusedCold = true;
    }
    if (!reusedCold && (memoKey === undefined || !emitted || emitted.options !== memoKey || emitted.args !== args || emitted.templateEligible !== templateEligible)) {
      captured = [];
      literalGrowth = 128;
      literalInitializers = undefined;
      literalParameters = undefined;
      texts = templateEligible ? (textBuffer ??= new TextBuffer()).reset() : undefined;
      let checks = '';
      if (options.development && args.size) {
        const context = `${message.locale}:${message.id}`;
        if (texts) texts.push(context);
        const shared = texts ? validations!.get(args) : undefined;
        if (shared !== undefined) checks = shared;
        else {
          const errorPrefix = texts ? '$s0+' : '', errorContext = texts ? '' : context;
          checks = `if(!p||typeof p!=="object")throw new TypeError(${errorPrefix}${quote(errorContext + ': expected message arguments')});`;
          for (const [key, arg] of args) {
            const quoted = quote(key), value = `p[${quoted}]`;
            const booleanSelect = arg.kind === 'select' && (arg.choices.has('true') || arg.choices.has('false'));
            const test = arg.kind === 'slot' ? `typeof ${value}!=="function"` : arg.kind === 'number' ? `typeof ${value}!=="number"`
              : arg.kind === 'date' ? `(typeof ${value}!=="number"&&!(${value} instanceof Date))`
              : arg.kind === 'select' ? booleanSelect
                ? `(typeof ${value}!=="string"&&typeof ${value}!=="boolean")`
                : `typeof ${value}!=="string"`
              : `(typeof ${value}!=="string"&&typeof ${value}!=="number")`;
            checks += `if(!Object.hasOwn(p,${quoted})||${test})throw new TypeError(${errorPrefix}${quote(`${errorContext}: argument ${quoted} must be ${arg.kind === 'slot' ? 'a slot function' : arg.kind === 'value' ? 'string or number' : arg.kind === 'date' ? 'Date or number' : arg.kind === 'select' ? booleanSelect ? 'string or boolean' : 'string' : 'number'}`)});`;
            // Invalid Dates otherwise surface as a bare RangeError from Intl.
            if (arg.kind === 'date') checks += `if(!Number.isFinite(+${value}))throw new TypeError(${errorPrefix}${quote(`${errorContext}: argument ${quoted} must be a valid Date`)});`;
          }
          // Shared bodies retain the label as a parameter; build their common
          // checks once per contract. Unique contracts allocate no extra plan.
          if (texts) validations!.set(args, checks);
        }
      }
      let ast = message.ast;
      if (!ast) {
        let locale = intlLocales.get(message.locale);
        if (!locale) { locale = new Intl.Locale(message.locale); intlLocales.set(message.locale, locale); }
        ast = parseAst(message.source, locale);
      }
      // Share code for plain text while retaining a distinct closure/value per
      // message. Pure calls still let bundlers discard unused named exports.
      const literal = !args.size && ast.every(node => node.type === TYPE.literal);
      let rich = false;
      for (const arg of args.values()) if (arg.kind === 'slot') { rich = true; break; }
      let expression: string;
      try {
        expression = literal ? quote(ast.map(node => node.type === TYPE.literal ? node.value : '').join('')) : rich ? emitRich(ast, message) : emit(ast, message);
      } catch (error) {
        if (isStackOverflow(error)) tooDeep({ locale: message.locale, messageId: message.id, source: message.source });
        throw error;
      }
      emitted = { options: memoKey ?? '', args, body: literal ? `/*#__PURE__*/$literal(${expression})`
        : `(${args.size ? 'p' : ''})=>${checks ? `{${checks}return ${expression};}` : expression}`, helpers: captured, rich, templateEligible,
        literalText: literal ? expression : undefined };
      // emit()/emitRich() may populate this closure state.
      const initializers = literalInitializers as string[] | undefined;
      if (initializers?.length) {
        // Preserve original text arguments in shared factories; build complete
        // branch strings once when each message closure is initialized.
        emitted.body = `(()=>{${initializers.map((code, i) => `const $c${i}=${code};`).join('')}return ${emitted.body};})()`;
      }
      if (texts?.length) {
        // Adjacent messages often have the same template. Avoid rebuilding its
        // serialized key; helper identity and map membership protect changes
        // in formatter options and a patch that restarts full assembly.
        let factory = lastFactory;
        if (!factory || factory.body !== emitted.body || factory.parameters !== texts.length
          || !sameItems(captured, factory.dependencies) || helpers.get(factory.key) !== factory) {
          const key = 'Factory:' + JSON.stringify([emitted.body, captured.map(helper => helper.key)]);
          if (!helpers.has(key)) register({ key, kind: 'Factory', body: emitted.body, parameters: texts.length, dependencies: captured as Formatter[] });
          factory = helpers.get(key)! as Factory;
        }
        lastFactory = factory;
        emitted.body = factory.body;
        emitted.helpers = captured.concat(factory);
        emitted.texts = texts.slice();
      }
      texts = undefined;
      if (memoKey !== undefined) {
        message.emitted = emitted;
        message.ast = undefined;
      }
      sharedEmissions?.set(message, emitted);
      if (coldKey !== undefined) coldBySource!.set(coldKey, emitted);
    }
    return retain(message, emitted!);
  }
  /** Account a session's retained emission against its byte budget. */
  function retain(message: Message, result: EmittedMessage): EmittedMessage {
    if (emissions) {
      const bytes = (result.body.length + (result.texts?.reduce((sum, text) => sum + text.length, 0) ?? 0)) * 2 + result.helpers.length * 32 + 160;
      emissions.bytes += bytes - (emissions.entries.get(message) ?? 0);
      emissions.entries.delete(message);
      emissions.entries.set(message, bytes);
    }
    return result;
  }
  const literalPrefix = '/*#__PURE__*/$literal(';
  const noHelperNames: readonly string[] = [];
  function bodyFor(emitted: EmittedMessage, names: readonly string[], factories: ReadonlyMap<string, number>): string {
    // Without helpers there are no formatter references to resolve (and no factory).
    if (!relocatable || !emitted.helpers.length) return emitted.body;
    if (emitted.texts && factories.get(emitted.helpers.at(-1)!.key)! > 1) {
      return `/*#__PURE__*/${names.at(-1)}(${emitted.texts.map(quote).join(',')})`;
    }
    const body = emitted.texts ? substituteTextParameters(emitted.body, emitted.texts) : emitted.body;
    return body.replace(/\0(\d+)\0/g, (_, i: string) => names[Number(i)]!);
  }
  function definition(message: Message, name: string, quotedId: string, body: string): string {
    // Keep loader collisions and invalid export names on the default catalog.
    const exported = namedMessage(message.id)
      ? `export {${name} as ${quotedId}};\n` : '';
    return `const ${name}=${body};\n${exported}`;
  }
  // Projection and selection rename only $fN and $fNCache identifiers, so the
  // fast path closes over its tables inside each one-line helper declaration.
  function pluralDeclaration(id: string, locale: string, opts: object): string {
    const { categories, index } = pluralTable(locale, (opts as { type: string }).type);
    return `let ${id}Cache;const ${id}=/*#__PURE__*/((k,i,s)=>v=>Number.isInteger(v)&&v>=0&&v<200&&!Object.is(v,-0)?k[i.charCodeAt(v)-48]:s(v))(${quote(categories)},${quote(index)},/*#__PURE__*/$memo(v=>(${id}Cache??=new Intl.PluralRules(${quote(locale)},${quote(opts)})).select(v)));`;
  }
  function renderPrefix(literals: number, rich: number, factories: ReadonlyMap<string, number>, hydrateLiterals = false): string {
    // Number/date accessors return bound functions; generated code caches them.
    // Run literal initialization in the factory's existing scope. The cached
    // expression form remains available for inlining one-off selections.
    const prelude = [...helpers.values()].filter(h => h.kind !== 'Factory' || factories.get(h.key)! > 1).map(h => h.kind === 'Factory'
      ? `const ${h.id}=(${Array.from({ length: h.parameters }, (_, i) => `$s${i}`).join(',')})=>${(h.body.startsWith('(()=>{const $c') ? h.body.slice(5, -3) : h.body).replace(/\0(\d+)\0/g, (_, i: string) => helpers.get(h.dependencies[Number(i)]!.key)!.id)};`
      : h.kind === 'PluralRules'
      ? pluralDeclaration(h.id, h.locale, h.options)
      : h.kind === 'NumberFormat' && !Object.keys(h.options).length && plainDigits(h.locale)
      ? `let ${h.id}Cache;const ${h.id}=/*#__PURE__*/(s=>v=>Number.isInteger(v)&&v>=0&&v<1000&&!Object.is(v,-0)?""+v:s(v))(/*#__PURE__*/$memo(v=>(${h.id}Cache??=new Intl.NumberFormat(${quote(h.locale)},${quote(h.options)}).format)(v)));`
      : h.kind === 'NumberFormat'
      ? `let ${h.id}Cache;const ${h.id}=/*#__PURE__*/$memo(v=>(${h.id}Cache??=new Intl.NumberFormat(${quote(h.locale)},${quote(h.options)}).format)(v));`
      : `let ${h.id}Cache;const ${h.id}=v=>(${h.id}Cache??=new Intl.${h.kind}(${quote(h.locale)},${quote(h.options)}).format)(v);`);
    const hasNumericFormatter = [...helpers.values()].some(h => h.kind === 'NumberFormat' || h.kind === 'PluralRules');
    if (literals) prelude.unshift('const $literal=value=>()=>value;');
    if (hydrateLiterals) prelude.unshift('const $literals=messages=>{for(const key in messages){const value=messages[key];if(typeof value==="string")messages[key]=()=>value;}return messages;};');
    if (rich) prelude.unshift('const $parts=values=>{let length=0;for(const value of values){if(typeof value==="string"&&length&&typeof values[length-1]==="string")values[length-1]+=value;else values[length++]=value;}values.length=length;return values;};');
    // Keep the generated header first, then the shared cache prelude before
    // parts/literal helpers and formatter declarations. Dates stay direct.
    const memo = 'const $memo=f=>{const keys=[],values=[];return v=>{if(typeof v!=="number")return f(v);const slot=v&63;if(Object.is(keys[slot],v))return values[slot];const next=f(v);keys[slot]=v;values[slot]=next;return next;}};';
    const generatedHeader = options.artifacts === 'loader' || options.artifacts === 'loader-typed' ? jsHeader : header;
    return generatedHeader + (hasNumericFormatter ? memo + '\n' : '') + (prelude.length ? prelude.join('\n') + '\n' : '');
  }
  if (coldTemplate) {
    const original = messages[0];
    const message = original && catalogLocale !== undefined && original.locale !== catalogLocale
      ? { ...original, locale: catalogLocale } : original;
    const localized = message ? coldTemplate.helpers.map(helper => localizeHelper(helper, message)) : coldTemplate.helpers;
    for (const helper of localized) register(helper);
    const factories = new Map<string, number>();
    for (let index = 0; index < coldTemplate.helpers.length; index++) {
      const count = coldTemplate.factories.get(coldTemplate.helpers[index]!.key);
      if (count !== undefined) factories.set(localized[index]!.key, count);
    }
    const prefix = renderPrefix(coldTemplate.literals, coldTemplate.rich, factories);
    const fullPrefix = renderPrefix(0, coldTemplate.rich, factories, coldTemplate.fullLiterals > 0);
    return { code: prefix + coldTemplate.codeTail, fullCode: fullPrefix + coldTemplate.fullTail, coldTemplate };
  }
  function patch(): RenderedCatalog | undefined {
    const layout = previous?.assembly;
    if (!previous || !layout) return;
    const changed: number[] = [];
    for (let i = 0; i < messages.length; i++) if (messages[i] !== previous.messages[i]) {
      changed.push(i);
      // Keep bulk changes on the full emitter; normal typing changes few IDs.
      if (changed.length > 64) return;
    }
    if (!changed.length) return previous;
    for (const spec of layout.formatters) register(spec);
    const emittedChanges: EmittedMessage[] = [];
    let dependenciesChanged = false, literals = layout.literals;
    let factories = layout.factories;
    for (const index of changed) {
      const emitted = messageEmission(messages[index]!);
      const sequence = layout.sequences[layout.signatures[index]!]!;
      const oldFactory = sequence.at(-1)?.kind === 'Factory' ? sequence.at(-1)!.key : undefined;
      const nextFactory = emitted.texts ? emitted.helpers.at(-1)!.key : undefined;
      if (oldFactory !== nextFactory) {
        if (factories === layout.factories) factories = new Map(factories);
        const counts = factories as Map<string, number>;
        if (oldFactory) { const count = counts.get(oldFactory)! - 1; if (count) counts.set(oldFactory, count); else counts.delete(oldFactory); }
        if (nextFactory) counts.set(nextFactory, (counts.get(nextFactory) ?? 0) + 1);
      }
      if (sequence.length !== emitted.helpers.length || sequence.some((spec, i) => spec.key !== emitted.helpers[i]!.key)) dependenciesChanged = true;
      const wasLiteral = previous.code.startsWith(literalPrefix, layout.prefix + layout.offsets[index]! + `const $m${index}=`.length);
      literals += Number(emitted.body.startsWith(literalPrefix)) - Number(wasLiteral);
      emittedChanges.push(emitted);
    }
    // A one/two-use transition also changes an otherwise unchanged definition.
    // Reassemble that uncommon case; ordinary edits only replace literal data.
    if (factories !== layout.factories) for (const [key, count] of factories) {
      const old = layout.factories.get(key) ?? 0;
      if ((old === 1 && count > 1) || (old > 1 && count === 1)) { helpers.clear(); return; }
    }
    let signatures = layout.signatures, sequences = layout.sequences;
    const renamedSequences = new Set<number>();
    const renames = new Map<string, string>();
    if (dependenciesChanged) {
      // Rebuild canonical first-use order from the current sequences. Process
      // each unchanged signature once, without visiting every helper per ID.
      helpers.clear();
      signatures = new Uint32Array(messages.length);
      const compact: (readonly Helper[])[] = [];
      const sequenceIds = new Map<string, number>();
      const mapped = new Uint32Array(layout.sequences.length);
      const intern = (sequence: readonly Helper[]): number => {
        const key = sequence.map(register).join(',');
        let id = sequenceIds.get(key);
        if (id === undefined) { id = compact.length; sequenceIds.set(key, id); compact.push(sequence); }
        return id;
      };
      let change = 0;
      for (let index = 0; index < messages.length; index++) {
        if (changed[change] === index) signatures[index] = intern(emittedChanges[change++]!.helpers);
        else {
          const old = layout.signatures[index]!;
          if (!mapped[old]) mapped[old] = intern(layout.sequences[old]!) + 1;
          signatures[index] = mapped[old]! - 1;
        }
      }
      // Compact on dependency changes so removed styles/sequences cannot
      // accumulate through a long watch session. These hold no prior source.
      sequences = compact;
      for (let i = 0; i < layout.formatters.length; i++) {
        const name = helpers.get(layout.formatters[i]!.key)?.id;
        if (name !== undefined && name !== `$f${i}`) renames.set(`$f${i}`, name);
      }
      if (renames.size) {
        const oldNames = new Map(layout.formatters.map((spec, i) => [spec.key, `$f${i}`]));
        for (let i = 0; i < mapped.length; i++) if (mapped[i]
          && layout.sequences[i]!.some(spec => renames.has(oldNames.get(spec.key)!))) renamedSequences.add(i);
      }
    }

    const prefix = dependenciesChanged || literals !== layout.literals ? renderPrefix(literals, layout.rich, factories) : previous.code.slice(0, layout.prefix);
    const pieces = [prefix];
    const offsets = new Uint32Array(layout.offsets.length);
    let cursor = layout.prefix, delta = 0, change = 0;
    for (let index = 0; index < messages.length; index++) {
      offsets[index] = layout.offsets[index]! + delta;
      let replacement: string | undefined;
      if (changed[change] === index) {
        const emitted = emittedChanges[change++]!;
        const message = messages[index]!;
        replacement = definition(message, `$m${index}`, quote(message.id), bodyFor(emitted, emitted.helpers.map(register), factories));
      } else if (renamedSequences.has(layout.signatures[index]!)) {
        replacement = rewriteGeneratedIdentifiers(previous.code.slice(layout.prefix + layout.offsets[index]!, layout.prefix + layout.offsets[index+1]!),
          name => renames.get(name) ?? name);
      }
      if (replacement !== undefined) {
        const start = layout.prefix + layout.offsets[index]!, end = layout.prefix + layout.offsets[index+1]!;
        pieces.push(previous.code.slice(cursor, start), replacement);
        cursor = end;
        delta += replacement.length - (end - start);
      }
    }
    offsets[messages.length] = layout.offsets[messages.length]! + delta;
    pieces.push(previous.code.slice(cursor));
    // Join into one current module; do not retain a chain of prior fragments
    // in the assembly metadata. Formatter sequences are immutable and shared.
    return { code: pieces.join(''), assembly: { prefix: prefix.length, literals, rich: layout.rich, offsets, signatures, sequences,
      formatters: dependenciesChanged ? [...helpers.values()] : layout.formatters, factories } };
  }
  const patched = patch();
  if (patched) { if (emissions) trimEmissions(emissions); return patched; }
  const code: string[] = [];
  const entries: string[] = [];
  const fullEntries: string[] = [];
  const sourceEntries: string[] = [];
  const offsets = emissions ? new Uint32Array(messages.length+1) : undefined;
  const signatures = emissions ? new Uint32Array(messages.length) : undefined;
  const sequenceIds = new Map<string, number>();
  const sequences: Helper[][] = [];
  const emittedMessages = eligible ? messages.map(messageEmission) : undefined;
  const factories = new Map<string, number>();
  for (const emitted of emittedMessages ?? []) if (emitted.texts) {
    const key = emitted.helpers.at(-1)!.key;
    factories.set(key, (factories.get(key) ?? 0) + 1);
  }
  // Parsing/validation above may register helpers ahead of their final first-use
  // order. Rebuild that order consistently with the incremental sequence path.
  if (emittedMessages) helpers.clear();
  let literals = 0, fullLiterals = 0, rich = 0;
  messages.forEach((message, index) => {
    const name = `$m${index}`;
    const emitted = emittedMessages?.[index] ?? messageEmission(message);
    // Register in original emission order, which can differ from source order
    // for nested plural branches. Incremental and cold output stay identical.
    const names = emitted.helpers.length ? emitted.helpers.map(register) : noHelperNames;
    const body = bodyFor(emitted,names,factories);
    // Literal bodies have no helpers, so bodyFor returned the emitted body itself.
    const literalText = emitted.literalText;
    const literal = literalText !== undefined || (body.startsWith(literalPrefix) && body.endsWith(')'));
    if (literal) { literals++; fullLiterals++; }
    if (emitted.rich) rich++;
    if (options.includeSources === 'all' || (options.includeSources === 'rich' && emitted.rich) || includedSourceIds?.has(message.id)) {
      sourceEntries.push(`${propertyKey(message.id)}:${quote(message.source)}`);
    }
    // The public module keeps one binding per message for tree-shakeable named
    // exports and Projection. The loader's private full-catalog module has no
    // named consumers, so put the expression directly in its object. This
    // removes one binding and one object indirection per message without
    // duplicating the ICU emitter or changing the public module shape.
    const quotedId = quote(message.id);
    const section = layout !== 'public' ? '' : definition(message,name,quotedId,body);
    code.push(section);
    if (offsets && signatures) {
      offsets[index+1]=offsets[index]!+section.length;
      const key=names.join(',');
      let signature=sequenceIds.get(key);
      if (signature === undefined) {signature=sequences.length;sequenceIds.set(key,signature);sequences.push(emitted.helpers);}
      signatures[index]=signature;
    }
    const fullBody = literalText ?? (literal ? body.slice(literalPrefix.length, -1) : body);
    const sharedLiteral = layout === 'full' && fullSharedIds?.has(message.id) && literal;
    const key = message.id !== '__proto__' && identifierProperty.test(message.id) ? message.id : `[${quotedId}]`;
    if (!sharedLiteral) entries.push(`${layout !== 'public' ? key : `[${quotedId}]`}:${layout !== 'public' ? fullBody : name}`);
    if (layout === 'public') fullEntries.push(`${key}:${fullBody}`);
  });
  const prefix=renderPrefix(layout === 'public' ? literals : 0, rich, factories, layout !== 'public' && fullLiterals > 0);
  const fullPrefix=layout === 'public' ? renderPrefix(0, rich, factories, fullLiterals > 0) : '';
  const aliases=messages.some(message=>message.id.includes('.'));
  const nestedRuntime=aliases?nestedMessageRuntime():'';
  const rawCatalog = `{__proto__:null,${entries.join(',')}}`;
  const catalog = layout !== 'public' && fullLiterals ? `/*#__PURE__*/$literals(${rawCatalog})` : rawCatalog;
  // A full locale imports `sharedSources` whenever source retention is
  // enabled. Keep the shared module linkable even when rich filtering leaves
  // no source entries in that shared literal set.
  const sources = sourceEntries.length
    ? `export const sources={__proto__:null,${sourceEntries.join(',')}};\n`
    : layout !== 'public' && options.includeSources !== undefined ? 'export const sources={__proto__:null};\n' : '';
  const shareLiterals = layout === 'full' && fullSharedIds?.size;
  const sharedImport = shareLiterals
    ? `import sharedMessages${options.includeSources !== undefined ? ',{sources as sharedSources}' : ''} from ${quote(fullSharedImport)};\n`
    : '';
  const sourceExport = layout !== 'public' && shareLiterals && options.includeSources !== undefined
    ? `export const sources=Object.assign(Object.create(null),sharedSources,{__proto__:null,${sourceEntries.join(',')}});\n`
    : layout !== 'public' ? sources : '';
  const mergedCatalog = shareLiterals
    ? (aliases ? `/*#__PURE__*/$nested(Object.assign(Object.create(null),sharedMessages,${catalog}))` : `Object.assign(Object.create(null),sharedMessages,${catalog})`)
    : aliases ? `/*#__PURE__*/$nested(${catalog})` : catalog;
  const suffix=layout === 'shared'
    ? `const messages=${catalog};export default messages;\n${sources}`
    : `${aliases ? nestedRuntime : ''}const messages=${mergedCatalog};export default messages;\n${sourceExport}`;
  const joined = [prefix,...code,suffix].join('');
  const fullCode = layout === 'public'
    ? fullPrefix + (() => {
      const raw = `{__proto__:null,${fullEntries.join(',')}}`;
      const hydrated = fullLiterals ? `/*#__PURE__*/$literals(${raw})` : raw;
      return aliases
        ? `${nestedRuntime}const messages=/*#__PURE__*/$nested(${hydrated});export default messages;\n${sources}`
        : `const messages=${hydrated};export default messages;\n${sources}`;
    })() : undefined;
  const coldTemplateResult = memoKey === undefined && !options.development && layout === 'public' && fullCode !== undefined
    ? { codeTail: joined.slice(prefix.length), fullTail: fullCode.slice(fullPrefix.length), helpers: [...helpers.values()],
      factories, literals, fullLiterals, rich } : undefined;
  if (emissions) trimEmissions(emissions);
  const outputCode = sharedImport && joined.startsWith(jsHeader)
    ? jsHeader + sharedImport + joined.slice(jsHeader.length)
    : sharedImport + joined;
  return {code:outputCode,fullCode, coldTemplate:coldTemplateResult, assembly:offsets && signatures
    ? {prefix:prefix.length,literals,rich,offsets,signatures,sequences,formatters:[...helpers.values()],factories} : undefined};
}

// All locales have the same merged argument contract. Declare it once per
// group so TypeScript does not have to parse an identical copy for every locale.
interface TypeSignature { text: string; rich: boolean }

const docLimit = 200;
/** One line of hover text, at most docLimit code points. */
function docText(source: string): string {
  // This runs once per message on every typed compile, so skip work most text does not need.
  let text = /\s\s|[^\S ]/.test(source) ? source.replace(/\s+/g, ' ').trim() : source.trim();
  if (text.length > docLimit) {
    const points = [...text];
    if (points.length > docLimit) text = points.slice(0, docLimit - 1).join('') + '…';
  }
  // A word-initial `@` would start a JSDoc tag; a fullwidth one displays the same.
  if (text.includes('@')) text = text.replace(/(^|[\s{])@/g, '$1＠');
  if (text.includes('*/')) text = text.replaceAll('*/', '*\\/');
  return text;
}
/** Hover text: the base-locale source and its note, kept on the declaration's own line so declaration-map lines do not move. */
function declarationDoc(source: string, locale: string, note?: string): string {
  return note === undefined ? `/** ${docText(source)} — ${locale} */ ` : `/** ${docText(source)} — ${locale} @remarks ${docText(note)} */ `;
}

function renderTypes(ids: readonly string[], schema: Schema, namedOnly = false, signatures = new WeakMap<Map<string, Argument>, TypeSignature>(), split = false, docs: readonly string[] = []): string {
  const declarations: string[] = [];
  const properties: string[] = [];
  ids.forEach((id, index) => {
    const name = `$m${index}`;
    const doc = docs[index] ?? '';
    const args = schema.get(id)!;
    let signature = signatures.get(args);
    if (!signature) {
      let rich = false;
      const parameters: string[] = [];
      for (const [key, arg] of args) {
        if (arg.kind === 'slot') rich = true;
        parameters.push(`readonly ${quote(key)}: ${typeOf(arg)}`);
      }
      signature = { rich, text: args.size
        ? `${rich ? '<$Node>' : ''}(args: { ${parameters.join('; ')} }) => ${rich ? 'Array<string | $Node>' : 'string'}`
        : '() => string' };
      signatures.set(args, signature);
    }
    declarations.push(`${doc}declare const ${name}: ${signature.text};`);
    const exported = namedDeclaration(id) ? id : undefined;
    if (exported) declarations.push(`export {${name} as ${exported}};`);
    if (!namedOnly) properties.push(`${doc}readonly ${quote(id)}: typeof ${name}`);
  });
  // Short property lines keep declaration-map navigation efficient in large
  // catalogs and make the declarations readable when source files are absent.
  if (!namedOnly) declarations.push(!split && ids.some(id => id.includes('.'))
    ? `type $FlatMessages = {\n${properties.map(property => `  ${property};`).join('\n')}\n};\n${nestedMessageTypes('$FlatMessages', ids)}`
    : `export type Messages = {\n${properties.map(property => `  ${property};`).join('\n')}\n};\ndeclare const messages: Messages;\nexport default messages;`);
  return header + declarations.join('\n') + '\n';
}

function nestedMessageTypes(flat: string, ids: readonly string[]): string {
  const nested = nestedMessageTypeLiteral(ids, flat);
  return `type $Nest<Key,Value>=Key extends string?Key extends \`${'${infer Head}'}.${'${infer Tail}'}\`?{readonly [Part in Head]:$Nest<Tail,Value>}:{readonly [Part in Key]:Value}:unknown;\n`
    + `type $UnionToIntersection<Union>=(Union extends unknown?(value:Union)=>void:never) extends (value:infer Intersection)=>void?Intersection:never;\n`
    + `type $Nested<Flat>=$UnionToIntersection<{[Key in keyof Flat]:$Nest<Key,Flat[Key]>}[keyof Flat]>;\n`
    + `export type MessageId=keyof ${flat};\nexport type SelectedMessages<Key extends MessageId>=Pick<${flat},Key>&$Nested<Pick<${flat},Key>>;\n`
    + `export type Messages=${flat}&${nested};\ndeclare const messages: Messages;\nexport default messages;`;
}

interface RenderedTypes {
  files: Record<string, string>;
  groups: readonly TypeGroupOutput[];
  layout: readonly DeclarationGroup[];
  docs: readonly string[];
}

function sameTypeGroup(a: TypeGroupOutput, b: TypeGroupOutput, schema: Schema): boolean {
  return a.file === b.file && a.namedOnly === b.namedOnly && a.split === b.split && sameItems(a.ids, b.ids) && sameItems(a.docs, b.docs)
    && a.contracts.length === a.ids.length
    && a.contracts.every((contract, index) => contract === schema.get(a.ids[index]!));
}

function renderTypeFiles(ids: readonly string[], schema: Schema, docs: readonly string[], previous?: TypeOutput): RenderedTypes {
  const layout = declarationGroups('index.js', ids);
  const signatures = new WeakMap<Map<string, Argument>, TypeSignature>();
  let offset = 0;
  const groups = layout.map((group) => {
    const groupDocs = docs.slice(offset, offset += group.ids.length);
    return { ...group,
      namedOnly: false,
      split: ids.length > group.ids.length,
      contracts: group.ids.map(id => schema.get(id)),
      docs: groupDocs,
      code: '',
    };
  });
  const files: Record<string, string> = Object.create(null);
  const oldGroups = previous?.groups;
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index]!;
    const old = oldGroups?.[index];
    group.code = old && sameTypeGroup(old, group, schema) ? old.code : renderTypes(group.ids, schema, group.namedOnly, signatures, group.split, group.docs);
    files[group.file] = group.code;
  }
  if (groups[0]!.file !== 'messages.d.ts') {
    const imports = groups.map(group => quote('./' + group.file.replace(/\.d\.ts$/, '.js')));
    // Most private type modules describe IDs as exports, avoiding duplicate
    // properties. A group containing an invalid export name uses a default
    // object instead, preserving every key and its declaration-map location.
    // Only public-safe names are re-exported from either representation.
    // Flatten once instead of resolving each property through an intersection.
    // The mapped object keeps Record compatibility and explicit readonly keys.
    const oldLayout = previous?.layout;
    files['messages.d.ts'] = oldLayout && sameDeclarationLayout(layout, oldLayout)
      ? previous!.files['messages.d.ts']!
      : header + groups.map((group, i) => {
      const names = group.ids.filter(namedDeclaration);
      return names.length ? `export {${names.join(',')}} from ${imports[i]};` : '';
    }).join('\n')
      + '\n' + imports.map((path, i) => `type $T${i} = typeof import(${path}).default;`).join('\n')
      // One interface lets TypeScript merge the group members once. The mapped
      // alias keeps Record compatibility and resolves to each group's declaration.
      + `\ninterface $Flat extends ${imports.map((_, i) => `$T${i}`).join(', ')} {}\ntype $Messages = {[Key in keyof $Flat]: $Flat[Key]};\n`
      + (ids.some(id => id.includes('.')) ? nestedMessageTypes('$Messages', ids)
        : 'export type Messages=$Messages;\ndeclare const messages: Messages;\nexport default messages;') + '\n';
  }
  return { files, groups, layout, docs };
}

/** Development-only wrapper for a scope's messages. Reading a message that the
 * catalog has but the scope left out logs an error naming the message, where
 * production code would get `undefined` and fail further away. */
function scopeGuard(scope: string, outside: readonly string[]): string {
  const message = `is not in the ${quote(scope)} scope, so a page that loads this scope cannot show it. Add the module that reads it to the scope's modules, or the message to its messages.`;
  return `const $outside=new Set(${JSON.stringify(outside)});const $parents=new Set();for(const id of $outside){const parts=id.split(".");for(let i=1;i<parts.length;i++)$parents.add(parts.slice(0,i).join("."));}const $reported=new Set();const $guards=new WeakMap();\n`
    // Namespaces are read-only, non-configurable properties, and a proxy must return those
    // unchanged from its target. A shadow target lets the guard wrap nested namespaces too.
    + `const $guard=(value,path)=>{if((typeof value!=="object"&&typeof value!=="function")||value===null)return value;let guarded=$guards.get(value);if(!guarded){guarded=new Proxy(typeof value==="function"?()=>{}:{},{get(_,key){const result=Reflect.get(value,key);if(typeof key!=="string")return result;const id=path===undefined?key:path+"."+key;if(result===undefined&&($outside.has(id)||$parents.has(id))){if(!$reported.has(id)){$reported.add(id);console.error("Nordbeam Locale: message "+JSON.stringify(id)+" "+${quote(message)});}return result;}return $parents.has(id)?$guard(result,id):result;},has:(_,key)=>key in value,ownKeys:()=>Reflect.ownKeys(value),getOwnPropertyDescriptor(_,key){const descriptor=Reflect.getOwnPropertyDescriptor(value,key);if(descriptor)descriptor.configurable=true;return descriptor;},getPrototypeOf:()=>Reflect.getPrototypeOf(value),apply:(_,self,args)=>Reflect.apply(value,self,args)});$guards.set(value,guarded);}return guarded;};\n`;
}

function renderLoader(locales: string[], baseLocale: string, ids: readonly string[], includeSources = false, publicLocales = true, guard?: { readonly scope: string; readonly outside: readonly string[] }): { js: string; dts: string } {
  const messages = guard ? '$guard(module.default)' : 'module.default';
  const loaded = includeSources ? `{locale,messages:${messages},sources:module.sources}` : `{locale,messages:${messages}}`;
  const guardCode = guard ? scopeGuard(guard.scope, guard.outside) : '';
  const sourceType = includeSources ? '\nexport type MessageSources=Readonly<Partial<Record<keyof Messages,string>>>;' : '';
  const sourceField = includeSources ? '; readonly sources: MessageSources' : '';
  const messagesImport = publicLocales ? `./locales/${baseLocale}.js` : './messages.js';
  const generatedHeader = publicLocales ? header : jsHeader;
  if (!ids.some(id => id.includes('.'))) return {
    js: generatedHeader + `export const locales=Object.freeze(${quote(locales)});\nexport const baseLocale=${quote(baseLocale)};\nconst loaders={__proto__:null,${locales.map(locale => `[${quote(locale)}]:()=>import(${quote(`./internal/locales/${locale}.js`)})`).join(',')}};\n${guardCode}export async function loadLocale(locale){const load=loaders[locale];if(!load)throw new RangeError("Unsupported locale: "+String(locale));const module=await load();return ${loaded};}\nexport function selectMessages(...keys){if(!keys.length||keys.some(key=>typeof key!=="string"))throw new TypeError("selectMessages requires message IDs");const cache=new Map();return async locale=>{const loaded=await loadLocale(locale);let messages=cache.get(locale);if(!messages){messages=Object.create(null);for(const key of keys){if(!Object.hasOwn(loaded.messages,key))throw new RangeError("Unknown message: "+key);messages[key]=loaded.messages[key];}cache.set(locale,messages);}return {locale,messages};};}\n`,
    dts: header + `export declare const locales: readonly [${locales.map(quote).join(', ')}];\nexport type Locale = typeof locales[number];\nexport declare const baseLocale: ${quote(baseLocale)};\nexport type Messages = typeof import(${quote(messagesImport)}).default;${sourceType}\nexport interface LoadedLocale { readonly locale: Locale; readonly messages: Messages${sourceField} }\nexport declare function loadLocale(locale: Locale): Promise<LoadedLocale>;\nexport interface LoadedSelection<Key extends keyof Messages> { readonly locale: Locale; readonly messages: Pick<Messages, Key> }\nexport declare function selectMessages<const Keys extends readonly [keyof Messages, ...(keyof Messages)[]]>(...keys: Keys): (locale: Locale) => Promise<LoadedSelection<Keys[number]>>;\n`,
  };
  return {
    js: generatedHeader + `export const locales=Object.freeze(${quote(locales)});\nexport const baseLocale=${quote(baseLocale)};\nconst loaders={__proto__:null,${locales.map(locale => `[${quote(locale)}]:()=>import(${quote(`./internal/locales/${locale}.js`)})`).join(',')}};\n${guardCode}export async function loadLocale(locale){const load=loaders[locale];if(!load)throw new RangeError("Unsupported locale: "+String(locale));const module=await load();return ${loaded};}\nconst $namespace=()=>()=>{throw new TypeError("Translation namespace is not a message")};\nconst $nested=(messages,keys)=>{for(const key of keys){const parts=key.split(".");if(parts.length<2)continue;let target=messages;for(let i=0;i<parts.length-1;i++){const part=parts[i];let next=Object.hasOwn(target,part)?target[part]:undefined;if((typeof next!=="object"&&typeof next!=="function")||next===null){next=$namespace();Object.defineProperty(target,part,{value:next,enumerable:target!==messages});}target=next;}Object.defineProperty(target,parts.at(-1),{value:messages[key],enumerable:true,configurable:true});}return messages;};\nexport function selectMessages(...keys){if(!keys.length||keys.some(key=>typeof key!=="string"))throw new TypeError("selectMessages requires message IDs");const cache=new Map();return async locale=>{const loaded=await loadLocale(locale);let messages=cache.get(locale);if(!messages){messages=Object.create(null);for(const key of keys){if(!Object.hasOwn(loaded.messages,key))throw new RangeError("Unknown message: "+key);messages[key]=loaded.messages[key];}$nested(messages,keys);cache.set(locale,messages);}return {locale,messages};};}\n`,
    dts: header + `import type {MessageId,SelectedMessages} from ${quote('./messages.js')};\nexport declare const locales: readonly [${locales.map(quote).join(', ')}];\nexport type Locale = typeof locales[number];\nexport declare const baseLocale: ${quote(baseLocale)};\nexport type Messages = typeof import(${quote(messagesImport)}).default;${sourceType}\nexport interface LoadedLocale { readonly locale: Locale; readonly messages: Messages${sourceField} }\nexport declare function loadLocale(locale: Locale): Promise<LoadedLocale>;\nexport interface LoadedSelection<Key extends MessageId> { readonly locale: Locale; readonly messages: SelectedMessages<Key> }\nexport declare function selectMessages<const Keys extends readonly [MessageId, ...MessageId[]]>(...keys: Keys): (locale: Locale) => Promise<LoadedSelection<Keys[number]>>;\n`,
  };
}

/** Project compiler-owned definitions with only their required helpers.
 * Local names keep output stable when unrelated messages or formatters move.
 */
export function compileSelection(project: CompiledProject, entry: string, locale: string, keys: readonly string[]): string {
  const ids = project.groups[entry];
  if (!ids || !project.locales.includes(locale)) fail('INVALID_SELECTION', 'Unknown loader or locale.');
  const names = new Map(ids.map((id, i) => [id, i]));
  for (const key of keys) if (!names.has(key)) fail('UNKNOWN_MESSAGE', `Unknown selected message ${quote(key)}.`, { locale });
  const file = entry.slice(0, -'index.js'.length) + `locales/${locale}.js`;
  return new Projection(project.files[file]!, names).compile(keys);
}

export interface CheckResult {
  ok: boolean;
  errors: Diagnostic[];
  warnings: Diagnostic[];
  locales: string[];
  /** Number of flattened string entries, including invalid ICU; duplicate IDs count once per locale. */
  messageCount: number;
}

/** Validate independent messages without emitting code or retaining their ASTs.
 * Invalid messages/subtrees suppress dependent contract errors, while other
 * catalogs continue to be checked. ICU parsing stops at its first error per message.
 */
export function checkProject(options: CompilerOptions): CheckResult {
  if (options.lockedKeys !== undefined || options.ignoredKeys !== undefined) validateKeyPolicy(options, 'compiler options');
  const errors: Diagnostic[] = [], warnings: Diagnostic[] = [];
  const report: Report = diagnostic => { errors.push(diagnostic); };
  function attempt<T>(work: () => T): T | undefined {
    try { return work(); }
    catch (error) { if (!(error instanceof CompileError)) throw error; errors.push(...error.diagnostics); }
  }
  function blockedBy(paths: Set<string>, id: string): boolean {
    if (paths.has('') || paths.has(id)) return true;
    for (let end = id.indexOf('.'); end >= 0; end = id.indexOf('.', end + 1)) if (paths.has(id.slice(0, end))) return true;
    return false;
  }
  const locales = Object.keys(options.catalogs).sort();
  const schema: Schema = new Map();
  let base = new Map<string, string>();
  const baseBlocked = new Set<string>();
  let messageCount = 0;
  if (!own(options.catalogs, options.baseLocale)) {
    report({ code: 'BASE_LOCALE_MISSING', message: `No catalog for base locale ${quote(options.baseLocale)}.` });
    baseBlocked.add('');
  }
  // Validation caches are local to this call. Each known Intl configuration is
  // constructed once, including failures; no formatter objects are retained.
  const formats = new Map<string, string | undefined>();
  function checkFormats(message: Message): void {
    // Enclosing select/plural branches as (kind, argument, choice) triples. Labels are built only when a warning needs them.
    const path: string[] = [];
    function formatter(kind: Formatter['kind'], opts: object, node: MessageFormatElement): void {
      const key = formatterKey(kind, message.locale, opts);
      if (!formats.has(key)) {
        try { validateFormatter(kind, message.locale, opts, message); formats.set(key, undefined); }
        catch (error) {
          if (!(error instanceof CompileError)) throw error;
          formats.set(key, error.diagnostics[0]!.message);
        }
      }
      const invalid = formats.get(key);
      if (invalid) report({ code: 'INVALID_FORMAT', message: presetConflict(invalid, node, options), locale: message.locale, messageId: message.id, source: message.source, ...node.location?.start });
    }
    function visit(nodes: MessageFormatElement[], pound = false): void {
      for (const node of nodes) {
        if (node.type === TYPE.number || node.type === TYPE.date || node.type === TYPE.time) {
          const resolved = attempt(() => formatOptions(node, message, options));
          if (resolved) formatter(node.type === TYPE.number ? 'NumberFormat' : 'DateTimeFormat', resolved.options, node);
        } else if (node.type === TYPE.plural) {
          formatter('PluralRules', { type: node.pluralType }, node);
          const required = pluralCategories(message.locale, node.pluralType ?? 'cardinal');
          if (required?.some(category => category !== 'other' && !Object.hasOwn(node.options, category))) {
            const labels: string[] = [];
            for (let i = 0; i < path.length; i += 3) labels.push(`${path[i]}:${path[i + 1]}=${path[i + 2]}`);
            const missing = pluralCategoryDiagnostic(message.locale, { argument: node.value, path: labels, choices: Object.keys(node.options), pluralType: node.pluralType }, message.id)!;
            warnings.push({ code: missing.code, message: missing.message, hint: missing.hint, locale: message.locale, messageId: message.id, source: message.source, ...node.location?.start });
          }
          for (const choice of Object.keys(node.options)) {
            path.push('plural', node.value, choice);
            visit(node.options[choice]!.value, true);
            path.length -= 3;
          }
        } else if (node.type === TYPE.select) {
          for (const choice of Object.keys(node.options)) {
            path.push('select', node.value, choice);
            visit(node.options[choice]!.value, pound);
            path.length -= 3;
          }
        } else if (node.type === TYPE.tag) visit(node.children, pound);
        else if (node.type === TYPE.pound && pound) formatter('NumberFormat', {}, node);
      }
    }
    visit(message.ast!);
  }
  const ordered = own(options.catalogs, options.baseLocale) ? [options.baseLocale, ...locales.filter(locale => locale !== options.baseLocale)] : locales;
  for (const locale of ordered) {
    const isBase = locale === options.baseLocale;
    if (!attempt(() => { validateLocale(locale); return true; })) { if (isBase) baseBlocked.add(''); continue; }
    const blocked = isBase ? baseBlocked : new Set<string>();
    const ambiguous = new Set<string>();
    const flat = flatten(options.catalogs[locale]!, locale, diagnostic => {
      report(diagnostic);
      blocked.add(diagnostic.messageId ?? '');
      if (diagnostic.code === 'DUPLICATE_KEY') ambiguous.add(diagnostic.messageId!);
    });
    if (isBase) base = flat;
    const intlLocale = new Intl.Locale(locale);
    for (const id of [...flat.keys()].sort()) {
      const source = flat.get(id)!;
      messageCount++;
      if (ambiguous.has(id)) continue;
      const message = attempt(() => readMessage(id, source, locale, intlLocale));
      if (!message) continue;
      checkFormats(message);
      if (isBase) { schema.set(id, message.args); continue; }
      if (!base.has(id)) {
        if (!blockedBy(baseBlocked, id)) report({ code: 'UNKNOWN_MESSAGE', message: 'This key does not exist in the base catalog.', locale, messageId: id });
        continue;
      }
      const contract = schema.get(id);
      if (!contract) continue;
      for (const [name, arg] of message.args) {
        if (!contract.has(name)) report({ code: 'UNKNOWN_ARGUMENT', message: `Translation introduces ${quote(name)}, which is absent from the base message.`, ...argumentContext(message, name) });
        else attempt(() => mergeArgument(contract, name, arg, { locale, messageId: id }, message));
      }
      let dropped: string[] | undefined;
      for (const [name, arg] of contract) if (arg.kind === 'slot' && !message.args.has(name)) (dropped ??= []).push(name);
      if (dropped) {
        const notice = droppedTagDiagnostic(dropped.sort(compare));
        warnings.push({ code: 'DROPPED_RICH_TAG', message: notice.message, hint: notice.hint, locale, messageId: id });
      }
    }
    if (!isBase) for (const id of base.keys()) if (!flat.has(id) && !blockedBy(blocked, id)) {
      if (options.missing === 'error') report({ code: 'MISSING_MESSAGE', message: 'Translation is missing.', locale, messageId: id });
      else warnings.push({ code: 'FALLBACK_MESSAGE', message: `Using the ${options.baseLocale} message and formatting locale.`, locale, messageId: id });
    }
  }
  for (const [scope, patterns] of Object.entries(options.scopes ?? {})) {
    scopeIds(scope, patterns, [...base.keys()], base, report, pattern => {
      if (!pattern.endsWith('.*')) return blockedBy(baseBlocked, pattern);
      const prefix = pattern.slice(0, -2);
      return blockedBy(baseBlocked, prefix) || [...baseBlocked].some(path => path.startsWith(prefix + '.'));
    });
  }
  if (Array.isArray(options.includeSources)) for (const id of new Set(options.includeSources)) if (!base.has(id)) {
    report({ code: 'UNKNOWN_MESSAGE', message: 'includeSources contains a key that does not exist in the base catalog.', locale: options.baseLocale, messageId: id });
  }
  // Locale/key order is stable regardless of input object insertion order.
  const order = (a: Diagnostic, b: Diagnostic) => compare(a.locale ?? '', b.locale ?? '') || compare(a.messageId ?? '', b.messageId ?? '') || (a.offset ?? -1) - (b.offset ?? -1) || compare(a.code, b.code) || compare(a.message, b.message);
  errors.sort(order); warnings.sort(order);
  return { ok: errors.length === 0, errors, warnings, locales, messageCount };
}

/** Compile all catalogs in memory. Generated modules have no runtime dependencies. */
export function compileProject(options: CompilerOptions): CompiledProject {
  return compile(options).project;
}

/** Keep one project's message bodies between builds, without retaining parser ASTs.
 * Inputs may be mutated between calls. Failed compilations never replace the
 * last successful schema or catalog snapshot. Drop the function to release it.
 */
export function createCompiler(cacheOptions: CompilerCacheOptions = {}): (options: CompilerOptions) => CompiledProject {
  const limit = cacheOptions.maxMessageCacheBytes ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('maxMessageCacheBytes must be a nonnegative safe integer.');
  const emissions: EmissionCache = { entries: new Map(), bytes: 0, limit };
  let previous: CompilationState | undefined;
  return options => {
    const retired: Message[] = [];
    let committed = false;
    try {
      const result = compile(options, previous, emissions, retired);
      previous = result.state;
      committed = true;
      // Callers may change returned metadata without corrupting the private cache.
      return { ...result.project, locales: [...result.project.locales],
        groups: Object.assign(Object.create(null), Object.fromEntries(Object.entries(result.project.groups).map(([entry, ids]) => [entry, [...ids]]))),
        warnings: result.project.warnings.map(warning => ({ ...warning })) };
    } finally {
      // Failed format validation can stop midway through a large catalog. Keep
      // the budget and release failed/removed inputs on that path as well.
      trimEmissions(emissions);
      if (committed) for (const message of retired) forgetEmission(emissions, message);
      else for (const message of emissions.entries.keys()) {
        if (previous?.parsed.get(message.locale)?.get(message.id) !== message) forgetEmission(emissions, message);
      }
    }
  };
}

function compile(options: CompilerOptions, previous?: CompilationState, emissionCache?: EmissionCache, retired?: Message[]): { project: CompiledProject; state: CompilationState } {
  if (options.lockedKeys !== undefined || options.ignoredKeys !== undefined) validateKeyPolicy(options, 'compiler options');
  if (options.artifacts !== undefined && options.artifacts !== 'typed' && options.artifacts !== 'runtime' && options.artifacts !== 'loader' && options.artifacts !== 'loader-typed') throw new TypeError('artifacts must be "typed", "runtime", "loader" or "loader-typed".');
  if (options.includeSources !== undefined && options.includeSources !== 'rich' && options.includeSources !== 'all'
    && (!Array.isArray(options.includeSources) || options.includeSources.some(id => typeof id !== 'string' || !id))) {
    throw new TypeError('includeSources must be "rich", "all" or an array of message IDs.');
  }
  const loaderOnly = options.artifacts === 'loader' || options.artifacts === 'loader-typed';
  const typed = options.artifacts !== 'runtime' && options.artifacts !== 'loader';
  const publicLocales = !loaderOnly;
  const incremental = emissionCache !== undefined;
  // Compact full-catalog sharing is restricted to cold loader artifacts. The
  // incremental compiler retains byte-canonical private outputs for cache
  // reuse and does not need to pay the extra dependency edge.
  const shareFullCatalog = !incremental && loaderOnly && options.shareLiterals === true;
  let argumentPool: CompilationState['argumentPool'] = previous?.argumentPool ?? new Map();
  const argumentKeys = previous?.argumentKeys ?? new WeakMap<Map<string, Argument>, string>();
  const emissions = emissionCache ?? { entries: new Map<Message, number>(), bytes: 0, limit: 0 };
  function intern(args: Map<string, Argument>): Map<string, Argument> {
    const key = (incremental ? argumentKeys.get(args) : undefined) ?? argumentKey(args);
    const existing = argumentPool.get(key);
    if (existing) return existing;
    // Ordinary text/style edits keep the existing contracts. Copy only when
    // adding one, so a failed attempt never mutates the successful pool.
    if (argumentPool === previous?.argumentPool) argumentPool = new Map(argumentPool);
    argumentPool.set(key, args);
    if (incremental) argumentKeys.set(args, key);
    return args;
  }
  const locales = Object.keys(options.catalogs).sort();
  if (!locales.length || !own(options.catalogs, options.baseLocale)) fail('BASE_LOCALE_MISSING', `No catalog for base locale ${quote(options.baseLocale)}.`);
  for (const locale of locales) validateLocale(locale);
  const parsed = new Map<string, Map<string, Message>>();
  const inputs: CompilationState['inputs'] = new Map();
  // ICU parsing is locale-independent except for date/time skeleton hour
  // resolution. Translation catalogs commonly retain identical literals and
  // placeholders, so share the immutable AST/argument scan within one compile.
  // Skeleton-bearing messages remain isolated by locale.
  type ParsedSource = { ast: MessageFormatElement[]; args: Map<string, Argument>; text: string | undefined };
  const parsedSources = new Map<string, ParsedSource>();
  // Skeleton sources (::jm) resolve per locale, so they are cached per locale.
  const localizedSources = new Map<string, Map<string, ParsedSource>>();
  let equivalentCatalog: { flat: Map<string, string | Message>; messages: Map<string, Message> } | undefined;
  // Stateless equivalent catalogs reuse the same immutable argument contracts;
  // retain their parsed-map identity so emission metadata need not rescan all
  // 10k message pairs for every locale.
  const equivalentMessageMaps = new WeakSet<Map<string, Message>>();
  interface FlattenedCatalog {
    flat: Map<string, string | Message>;
    /** Flattened IDs in canonical (code unit) order. */
    ids: readonly string[];
    messages?: Map<string, Message>;
    localeIndependent?: boolean;
  }
  const flattenedCatalogs = new WeakMap<object, FlattenedCatalog>();
  const sourceOf = (entry: string | Message): string => typeof entry === 'string' ? entry : entry.source;
  const localeIndependent = (catalog: ReadonlyMap<string, string | Message>): boolean => {
    for (const entry of catalog.values()) if (sourceOf(entry).includes('::')) return false;
    return true;
  };
  const sameCatalog = (left: ReadonlyMap<string, string | Message>, right: ReadonlyMap<string, string | Message>): boolean => {
    if (left.size !== right.size) return false;
    for (const [id, entry] of left) {
      const candidate = right.get(id);
      if (candidate === undefined || sourceOf(entry) !== sourceOf(candidate)) return false;
    }
    return true;
  };
  const messagesForLocale = (messages: ReadonlyMap<string, Message>, locale: string): Map<string, Message> => {
    // Preserve the canonical ID order in one native Map copy, then replace
    // only records whose emitted formatter closures own a locale.
    const localized = new Map(messages);
    for (const [id, message] of messages) {
      // Plain, interpolated, select, and rich-text messages never consult the
      // locale during emission. Reuse those records; only formatter-bearing
      // messages need a locale-owned record for Intl formatter selection.
      let localeOwned = false;
      for (const arg of message.args.values()) if (arg.kind === 'number' || arg.kind === 'date') {
        localeOwned = true;
        break;
      }
      if (localeOwned) localized.set(id, {
        id, locale, source: message.source, ast: message.ast, args: message.args, emitted: undefined, text: message.text,
      });
    }
    return localized;
  };
  // A common benchmark and generated-catalog shape uses independently
  // allocated flat JSON objects with identical locale content. Prove that
  // shape from own data descriptors before allocating another flattened map.
  // Accessors, nesting and invalid values retain the complete traversal path.
  const equivalentFlatCatalog = (catalog: unknown, reference: ReadonlyMap<string, string | Message>): catalog is Catalog => {
    if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return false;
    const prototype = Object.getPrototypeOf(catalog);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Object.keys(catalog);
    if (keys.length !== reference.size) return false;
    // File-backed snapshots are owned JSON.parse results. Their values cannot
    // be getters or mutate while read, so avoid allocating a descriptor for
    // every key on the hot equivalent-catalog path. Public objects retain the
    // descriptor checks below to preserve accessor safety.
    if (isCatalogSnapshot(catalog as Catalog)) {
      for (const id of keys) {
        if (!id) return false;
        const value = (catalog as Catalog)[id];
        const expected = reference.get(id);
        if (typeof value !== 'string' || expected === undefined || value !== sourceOf(expected)) return false;
      }
      return true;
    }
    // Flattened maps retain the source object's enumeration order. The common
    // generated-catalog case clones an object without reordering its keys, so
    // walk both sequences together and avoid a Map lookup for every entry.
    // Besides being cheaper, the order check makes this a strict fast path:
    // reordered objects fall through to ordinary flattening and sameCatalog,
    // which preserves the accessor/duplicate-key semantics of public objects.
    let index = 0;
    for (const [id, expected] of reference) {
      if (keys[index++] !== id) return false;
      if (!id) return false;
      const descriptor = Object.getOwnPropertyDescriptor(catalog, id);
      if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string') return false;
      if (descriptor.value !== sourceOf(expected)) return false;
    }
    return true;
  };
  const parseMessage = (id: string, source: string, locale: string, intlLocale: Intl.Locale): Message => {
    // Simple text is cheaper to scan again than to look up by its source.
    const simple = simpleMessage(id, source, locale);
    if (simple) return simple;
    let cache = parsedSources;
    if (source.includes('::')) {
      cache = localizedSources.get(locale)!;
      if (!cache) localizedSources.set(locale, cache = new Map());
    }
    const cached = cache.get(source);
    if (cached) return { id, locale, source, ast: cached.ast, args: cached.args, emitted: undefined, text: cached.text };
    const message = parsedMessage(id, source, locale, intlLocale);
    cache.set(source, { ast: message.ast!, args: message.args, text: message.text });
    return message;
  };
  let sameContract = previous !== undefined && previous.baseLocale === options.baseLocale && previous.missing === options.missing && previous.parsed.size === locales.length;
  for (const locale of locales) {
    const catalog = options.catalogs[locale]!;
    const old = previous?.parsed.get(locale);
    const snapshot = previous?.inputs.get(locale);
    if (snapshot?.catalog === catalog) {
      parsed.set(locale, old!);
      inputs.set(locale, snapshot);
      continue;
    }
    // A stateless build may receive the same immutable catalog object for
    // multiple locales. Once its first traversal proved that every message is
    // locale-independent, reuse the parsed table directly instead of walking
    // all own descriptors again just to prove equivalent flat content. The
    // shared-flat path already rejects locale-sensitive `::` sources and
    // retains the normal per-locale clone for the base formatter locale.
    const sharedFlat = !incremental && typeof catalog === 'object' && catalog !== null
      ? flattenedCatalogs.get(catalog) : undefined;
    if (!options.development && sharedFlat?.messages && sharedFlat.localeIndependent) {
      const reusableMessages = sharedFlat.messages;
      const messages = locale === options.baseLocale && reusableMessages.values().next().value?.locale !== locale
        ? messagesForLocale(reusableMessages, locale) : reusableMessages;
      parsed.set(locale, messages);
      equivalentMessageMaps.add(messages);
      continue;
    }
    if (!incremental && !options.development && equivalentCatalog
      && equivalentFlatCatalog(catalog, equivalentCatalog.flat)) {
      const reusableMessages = equivalentCatalog.messages;
      const messages = locale === options.baseLocale && reusableMessages.values().next().value?.locale !== locale
        ? messagesForLocale(reusableMessages, locale) : reusableMessages;
      parsed.set(locale, messages);
      equivalentMessageMaps.add(messages);
      if (locale === options.baseLocale) equivalentCatalog = { flat: equivalentCatalog.flat, messages };
      continue;
    }
    const reusable = incremental && isCatalogSnapshot(catalog);
    const comparison: CatalogComparison = { messages: old, unchanged: old !== undefined, changes: old ? [] : undefined };
    const flat = sharedFlat?.flat ?? flatten(catalog, locale, undefined, comparison, reusable);
    const equivalent = !incremental && !options.development && equivalentCatalog
      && sameCatalog(equivalentCatalog.flat, flat);
    if (!incremental && !options.development && ((sharedFlat?.messages && sharedFlat.localeIndependent) || equivalent)) {
      const reusableMessages = sharedFlat?.messages ?? equivalentCatalog!.messages;
      const messages = locale === options.baseLocale && reusableMessages.values().next().value?.locale !== locale
        ? messagesForLocale(reusableMessages, locale) : reusableMessages;
      parsed.set(locale, messages);
      equivalentMessageMaps.add(messages);
      if (locale === options.baseLocale && equivalentCatalog) equivalentCatalog = { flat, messages };
      continue;
    }
    // The default sort compares UTF-16 code units, exactly like compare(), without a JS callback.
    const ids = sharedFlat?.ids ?? [...flat.keys()].sort();
    if (!sharedFlat && !incremental && typeof catalog === 'object' && catalog !== null) {
      flattenedCatalogs.set(catalog, { flat, ids });
    }
    if (old && comparison.unchanged && old.size === flat.size) {
      // Validation still traverses mutable input, including duplicate IDs and
      // cycles. Equal source content can retain the sorted parsed table and
      // its message identities without another sort or replacement map.
      parsed.set(locale, old);
      if (reusable) {
        let unchangedContracts = snapshot?.arguments;
        if (!unchangedContracts) {
          unchangedContracts = new Set();
          for (const message of old.values()) unchangedContracts.add(message.args);
        }
        inputs.set(locale, { catalog, arguments: unchangedContracts });
      }
      continue;
    }
    if (old && comparison.changes && old.size === flat.size) {
      // Complete validation has proved the same ID set. Copying its sorted map
      // preserves canonical order while replacing only a bounded set of edits.
      const messages = new Map(old);
      const intlLocale = new Intl.Locale(locale);
      let sameArguments = true;
      for (const change of comparison.changes.sort((a, b) => compare(a.id, b.id))) {
        const cached = old.get(change.id)!;
        const message = parseMessage(change.id, change.source, locale, intlLocale);
        message.args = intern(message.args);
        if (message.args !== cached.args) sameArguments = false;
        messages.set(change.id, message);
        retired?.push(cached);
      }
      if (!sameArguments) sameContract = false;
      parsed.set(locale, messages);
      if (reusable) {
        let contracts = sameArguments ? snapshot?.arguments : undefined;
        if (!contracts) {
          contracts = new Set();
          for (const message of messages.values()) contracts.add(message.args);
        }
        inputs.set(locale, { catalog, arguments: contracts });
      }
      continue;
    }
    const contracts = reusable ? new Set<Map<string, Argument>>() : undefined;
    const intlLocale = new Intl.Locale(locale);
    let matched = 0;
    const messages = new Map<string, Message>();
    for (const id of ids) {
      const entry = flat.get(id)!;
      const cached = typeof entry === 'string' ? old?.get(id) : entry;
      const message = typeof entry === 'string' ? parseMessage(id, entry, locale, intlLocale) : entry;
      if (message !== cached) message.args = intern(message.args);
      contracts?.add(message.args);
      if (cached) { matched++; if (message !== cached) retired?.push(cached); }
      if (!cached || message.args !== cached.args) sameContract = false;
      messages.set(id, message);
    }
    if (old?.size !== messages.size) sameContract = false;
    // Only key removal needs a second pass over the previous locale. Ordinary
    // edits retire their replaced message while comparing source text above.
    if (retired && old && matched !== old.size) {
      for (const [id, message] of old) if (!messages.has(id)) retired.push(message);
    }
    parsed.set(locale, messages);
    let independent: boolean | undefined;
    if (!incremental && typeof catalog === 'object' && catalog !== null) {
      const cachedCatalog = flattenedCatalogs.get(catalog)!;
      if (!cachedCatalog.messages) {
        cachedCatalog.messages = messages;
        cachedCatalog.localeIndependent = independent = localeIndependent(flat);
      }
    }
    if (!incremental && !options.development && !equivalentCatalog
      && (independent ?? localeIndependent(flat))) {
      equivalentCatalog = { flat, messages };
      equivalentMessageMaps.add(messages);
    }
    if (contracts) inputs.set(locale, {catalog, arguments:contracts});
  }
  if (retired && previous) for (const [locale, messages] of previous.parsed) {
    if (!parsed.has(locale)) for (const message of messages.values()) retired.push(message);
  }
  const base = parsed.get(options.baseLocale)!;
  if (Array.isArray(options.includeSources)) for (const id of options.includeSources) if (!base.has(id)) {
    fail('UNKNOWN_MESSAGE', 'includeSources contains a key that does not exist in the base catalog.', { locale: options.baseLocale, messageId: id });
  }
  const schema: Schema = sameContract ? previous!.schema : new Map();
  const warnings: Diagnostic[] = sameContract ? previous!.warnings : [];
  if (!sameContract) {
    // Parsed contracts are immutable and already interned. Most translations
    // share them exactly; copy a contract only when cross-locale merging needs
    // a distinct map, so unrelated messages never mutate each other's types.
    // Map#forEach visits these whole catalogs without an entry pair per message.
    base.forEach((message, id) => { schema.set(id, message.args); });
    const merged = new Set<string>();
    for (const locale of locales) {
      if (locale === options.baseLocale) continue;
      const messages = parsed.get(locale)!;
      messages.forEach((message, id) => {
        let contract = schema.get(id);
        if (!contract) fail('UNKNOWN_MESSAGE', 'This key does not exist in the base catalog.', { locale, messageId: id });
        if (message.args === contract || !message.args.size) return;
        if (!merged.has(id)) {
          contract = new Map([...contract].map(([name, arg]) => [name, { kind: arg.kind, choices: new Set(arg.choices) }]));
          schema.set(id, contract);
          merged.add(id);
        }
        for (const [name, arg] of message.args) {
          if (!contract.has(name)) fail('UNKNOWN_ARGUMENT', `Translation introduces ${quote(name)}, which is absent from the base message.`, argumentContext(message, name));
          mergeArgument(contract, name, arg, { locale, messageId: id }, message);
        }
      });
      // Every translated ID is a base ID (checked above), so equal sizes mean none is missing.
      if (messages.size !== base.size) for (const [id] of base) if (!messages.has(id)) {
        if (options.missing === 'error') fail('MISSING_MESSAGE', 'Translation is missing.', { locale, messageId: id });
        warnings.push({ code: 'FALLBACK_MESSAGE', message: `Using the ${options.baseLocale} message and formatting locale.`, locale, messageId: id });
      }
    }
    for (const id of merged) schema.set(id, intern(schema.get(id)!));
    if (previous) {
      // Schema changes can remove parsed or merged contracts. Retain only the
      // current project's contracts; unchanged schemas reuse the pool directly.
      const active: CompilationState['argumentPool'] = new Map();
      const retain = (args: Map<string, Argument>) => active.set(argumentKeys.get(args)!, args);
      for (const [locale, messages] of parsed) {
        const snapshot = inputs.get(locale);
        if (snapshot) for (const args of snapshot.arguments) retain(args);
        else for (const message of messages.values()) retain(message.args);
      }
      for (const args of schema.values()) retain(args);
      argumentPool = active;
    }
  }
  const files: Record<string, string> = Object.create(null);
  const groups: Record<string, readonly string[]> = Object.create(null);
  const outputs: CompilationState['outputs'] = new Map();
  const types: CompilationState['types'] = new Map();
  // Start fresh so removed scopes do not accumulate; a failed attempt cannot
  // mutate the last committed group table because this map is local.
  const groupIds: CompilationState['groupIds'] = new Map();
  const rootIds = [...base.keys()];
  const rootMessageArrays = new WeakMap<Map<string, Message>, Message[]>();
  const messagesForGroup = (catalog: Map<string, Message>, ids: string[]): Message[] => {
    // Canonical parsed maps are sorted by the same IDs used for the root
    // group. Reuse their value arrays by map identity; scopes still need the
    // ordinary filtered lookup below. This avoids three 10k-element maps from
    // being projected again for an immutable full catalog.
    if (ids === rootIds && catalog.size === rootIds.length) {
      const cached = rootMessageArrays.get(catalog);
      if (cached) return cached;
      const messages = [...catalog.values()];
      rootMessageArrays.set(catalog, messages);
      return messages;
    }
    return ids.map(id => catalog.get(id) ?? base.get(id)!);
  };
  const eligibility = new Map<string, WeakSet<Map<string, Argument>> | null>();
  let eligibilityReference: { messages: readonly Message[]; value: WeakSet<Map<string, Argument>> | null } | undefined;
  // Artifact mode changes which locale modules are retained. Include it in
  // the incremental output key so a loader-only run cannot be reused as an
  // empty public locale when the same session switches back to typed/runtime.
  const memoKey = incremental ? optionKey([!!options.development, options.timeZone, options.formats, options.includeSources, options.artifacts]) : undefined;
  // Compilation-local only: unchanged emissions need no validation work, and
  // sessions do not retain another growing cache of old contracts.
  const validations = options.development ? new Map<Map<string, Argument>, string>() : undefined;
  function group(prefix: string, ids: string[]): void {
    const sharedIds = shareFullCatalog ? new Set(ids.filter(id => {
      const source = base.get(id)!.source;
      if (/[{}<>]/.test(source)) return false;
      return locales.some(locale => locale !== options.baseLocale
        && (parsed.get(locale)!.get(id) ?? base.get(id)!).source === source);
    })) : undefined;
    if (sharedIds?.size) {
      const sharedMessages = ids.filter(id => sharedIds.has(id)).map(id => base.get(id)!);
      const shared = renderCatalog(sharedMessages, schema, options, undefined, undefined, undefined,
        undefined, validations, 'shared', undefined, undefined, undefined, undefined, undefined);
      files[`${prefix}internal/shared.js`] = shared.code;
    }
    const oldIds = previous?.groupIds.get(prefix);
    if (oldIds && sameItems(ids, oldIds)) ids = oldIds;
    groupIds.set(prefix, ids);
    const oldType = previous?.types.get(prefix);
    groups[`${prefix}index.js`] = ids;
    // A schema map is intentionally replaced when one contract changes, but
    // declaration groups depend only on their own contract identities. Reuse
    // unaffected group strings (and the aggregate layout) across that change.
    if (typed) {
      const notes = options.notes;
      const docs = ids.map(id => declarationDoc(base.get(id)!.source, options.baseLocale, notes && Object.hasOwn(notes, id) ? notes[id] : undefined));
      const typeOutput = oldType?.schema === schema && ids === oldType.ids && sameItems(docs, oldType.docs)
        ? oldType
        : renderTypeFiles(ids, schema, docs, oldType);
      for (const [name, code] of Object.entries(typeOutput.files)) files[prefix+name] = code;
      if (incremental) types.set(prefix, { schema, ids, docs: typeOutput.docs, files: typeOutput.files, groups: typeOutput.groups, layout: typeOutput.layout });
    }
    const coldEmissions: ColdEmissionCache | undefined = incremental || options.development ? undefined : new WeakMap();
    let coldTemplateReference: { messages: readonly Message[]; locale: string; template: ColdCatalogTemplate } | undefined;
    for (const locale of locales) {
      const file = `${prefix}locales/${locale}.js`;
      const catalog = parsed.get(locale)!;
      const oldOutput = previous?.outputs.get(file);
      // A complete, unchanged translation does not depend on edits to base
      // message text. Sparse catalogs still depend on the base fallback map.
      const reusable = oldOutput?.schema === schema && oldOutput.options === memoKey
        && oldOutput.ids === ids && oldOutput.catalog === catalog
        && (catalog.size === base.size || oldOutput.base === base);
      const messages = reusable ? oldOutput.messages : messagesForGroup(catalog, ids);
      const compatible = oldOutput?.schema === schema && oldOutput.options === memoKey && oldOutput.ids === ids;
      // Emissions are shared with scopes and base fallbacks. Use the full locale's
      // filter in every scope, and include eligibility in the emission cache key.
      // Root locales have the same ordered IDs. When every interned contract
      // matches, reuse the first locale's result instead of recounting it.
      const reference = eligibilityReference;
      const eligible = prefix ? eligibility.get(locale)! : compatible ? oldOutput.eligible
        : reference && (equivalentMessageMaps.has(catalog) || messages === reference.messages
          || messages.length === reference.messages.length && messages.every((message, i) => message.args === reference.messages[i]!.args))
          ? reference.value : factoryEligibility(messages, schema);
      if (!prefix) {
        eligibility.set(locale, eligible);
        eligibilityReference ??= { messages, value: eligible };
      }
      const sharedEmissions = new Map<Message, EmittedMessage>();
      // Locale-sensitive skeletons (::jm, ::Hm, ...) bake the locale's hour cycle into the template.
      const matchingTemplate = coldTemplateReference
        && (equivalentMessageMaps.has(catalog) || messages === coldTemplateReference.messages || catalog.size === base.size
        && messages.length === coldTemplateReference.messages.length
        && messages.every((message, index) => message.id === coldTemplateReference!.messages[index]!.id
          && message.source === coldTemplateReference!.messages[index]!.source))
        && (coldTemplateReference.locale === locale || !messages.some(message => message.source.includes('::')))
        ? coldTemplateReference.template : undefined;
      // Loader-only output has no public locale modules. Avoid compiling and
      // materializing that discarded tree-shakeable shape; the full module is
      // emitted directly below. Reuse an unchanged full module across artifact
      // mode switches in an incremental session just as the public path does.
      // Equal message identities do not prove equal formatting ownership:
      // replacing a complete translated catalog with base-locale fallbacks can
      // reuse the same parsed messages while changing every Intl locale.
      const canReuse = reusable && compatible && sameItems(messages, oldOutput.messages);
      const rendered = publicLocales
        ? canReuse ? oldOutput
          : renderCatalog(messages, schema, options, memoKey, incremental ? emissions : undefined,compatible ? oldOutput : undefined,eligible,validations, 'public', sharedEmissions, coldEmissions, matchingTemplate, locale)
        : undefined;
      if (!coldTemplateReference && rendered?.coldTemplate && catalog.size === base.size) {
        coldTemplateReference = { messages, locale, template: rendered.coldTemplate };
      }
      if (rendered) files[file] = rendered.code;
      // Keep a separate, private full-catalog module for loadLocale. It is
      // intentionally not used by named imports or Projection, allowing the
      // public locale module to retain its existing tree-shakeable shape while
      // the common full-catalog path avoids per-message bindings.
      const fullFile = `${prefix}internal/locales/${locale}.js`;
      const localeSharedIds = sharedIds && new Set([...sharedIds].filter(id =>
        (catalog.get(id) ?? base.get(id)!).source === base.get(id)!.source));
      // Full modules are rebuilt from the shared message emissions. They do
      // not participate in the public incremental assembly (Projection and
      // named exports use that assembly), so avoid retaining a second offset
      // table/cache entry for every full-catalog message.
      // A cold/public render assembles both output shapes in one message pass.
      // Incremental patch results do not carry a compact assembly, so only
      // those edits take the bounded second pass.
      files[fullFile] = canReuse && oldOutput.fullCode
        ? oldOutput.fullCode
        : rendered?.fullCode ?? renderCatalog(messages, schema, options, memoKey, undefined,
          undefined, eligible, validations, 'full', sharedEmissions, coldEmissions,
          undefined, locale, localeSharedIds).code;
      if (incremental) outputs.set(file, { schema, options: memoKey!, ids, catalog, base, messages,
        code:rendered?.code ?? '', assembly:rendered?.assembly, fullCode:files[fullFile], eligible });
      if (typed && publicLocales) files[`${prefix}locales/${locale}.d.ts`] = header + 'export * from "../messages.js";\nexport { default } from "../messages.js";\n';
    }
    const scope = prefix.startsWith('scopes/') ? prefix.slice('scopes/'.length, -1) : undefined;
    const included = scope !== undefined && options.development && options.checkedScopes?.includes(scope) ? new Set(ids) : undefined;
    const guard = included && { scope: scope!, outside: [...base.keys()].filter(id => !included.has(id)) };
    const loader = renderLoader(locales, options.baseLocale, ids, options.includeSources !== undefined, publicLocales, guard);
    files[`${prefix}index.js`] = loader.js;
    if (typed) files[`${prefix}index.d.ts`] = loader.dts;
  }
  group('', rootIds);
  for (const [scope, patterns] of Object.entries(options.scopes ?? {})) {
    group(`scopes/${scope}/`, scopeIds(scope, patterns, [...base.keys()], base));
  }
  files['package.json'] = '{"type":"module","sideEffects":false}\n';
  return { project: { files, locales, groups, warnings }, state: { parsed, inputs, schema, baseLocale: options.baseLocale, missing: options.missing, warnings, outputs, types, groupIds, argumentPool, argumentKeys, emissions } };
}
