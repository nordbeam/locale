/**
 * Per-file analysis behind `nordbeam-locale hardcoded`. It walks one ESTree
 * program and records two things: UI text that is not a message (candidates),
 * and the places where the file already renders messages (evidence). The
 * project pass in text-scan.ts learns from the evidence which props, calls and
 * object keys carry UI text, then decides which candidates to report.
 *
 * Nothing here imports a parser, so the CLI, worker threads and the Vue and
 * Svelte adapters share it. Svelte hands its ESTree expressions in directly.
 */
import { noise } from './text-noise.js';
import type { Position } from './text-noise.js';

/** An ESTree node as oxc-parser and Svelte produce it. Offsets are UTF-16. */
export interface Node { type: string; start: number; end: number; [key: string]: any }

export interface ScanContext {
  /** Base-catalog message IDs. */
  ids: ReadonlySet<string>;
  /** Every dotted prefix of an ID, such as "checkout" for "checkout.pay". */
  namespaces: ReadonlySet<string>;
  /** Extra text props from the config, as `prop` or `Component.prop`. */
  attributes: ReadonlySet<string>;
  /** Extra callees whose arguments are UI text. */
  calls: ReadonlySet<string>;
  /** Catalog locales and the base locale, to read `locale === "en" ? "Hi" : "Hej"` as a translation. */
  locales: readonly string[];
  base: string;
  /** Words that name each locale: its code, and its name in English and in itself. */
  localeNames: ReadonlyMap<string, readonly string[]>;
}

export type TextKind = 'jsx-text' | 'jsx-expression' | 'attribute' | 'argument' | 'property' | 'return' | 'assignment' | 'template-text' | 'inline';

/** A placeholder in candidate text and the source expression that fills it. */
export interface TextArgument { name: string; code: string }

export interface TextCandidate {
  /** Span that a fix replaces, and where it starts (one-based). */
  start: number;
  end: number;
  line: number;
  column: number;
  /** Message text with `{name}` placeholders, as the catalog would hold it. */
  text: string;
  kind: TextKind;
  /** Why a position that rarely holds text counts: a sentence, or a value in a map of labels. */
  hint?: 'sentence' | 'labels';
  /** Learning key of the position, such as `key:label` or `call:toast.success#0`. */
  sink: string;
  /** A broader key that also teaches this position: `attr:label` for `elem:Field#label`. */
  family?: string;
  /** Where the text sits, for people: `<Button label>`, `toast.success()`, `label:`. */
  where: string;
  /** 2: UI text by rule, 1: likely UI text by name, 0: only if the project shows it is. */
  base: 0 | 1 | 2;
  /** The other branch of a condition, or another return of the function, is a message. */
  local: boolean;
  /** Another value in the same object or array is a message: evidence only for a text-like key. */
  siblings?: boolean;
  /** The source already holds this text in other locales: `locale === "en" ? "Hi" : "Hej"`. */
  translations?: Record<string, string>;
  /** Reached through a constant or helper, such as `const LABELS` or `statusLabel()`. */
  via?: string;
  args?: TextArgument[];
  /** Innermost function scope, for finding a message binding when fixing. */
  scope: number;
  /** How a fix must wrap the replacement. */
  wrap: TextWrap;
}

export interface FileFacts {
  /** Message references that need no project knowledge to recognize. */
  localized: number;
  /** Calls with a dynamic first argument, by callee: `t(key)` counts once the project knows `t`. */
  dynamic: Record<string, number>;
  /** Callees seen with a known message ID literal: that argument's index, and how often. */
  translators: Record<string, [index: number, calls: number]>;
  /** Calls of each callee whose first argument is a string that is not an ID: evidence against a translator. */
  plainCalls: Record<string, number>;
  /** Messages in learnable positions: [sink, callee for a dynamic call or ''] */
  evidence: Array<[string, string]>;
  candidates: TextCandidate[];
  /**
   * Function scopes: [parent, names declared from a call or import with what
   * they came from, and for a named function with a block body: its name, where
   * its first statement starts, and its range].
   */
  scopes: Array<[number, Array<[string, string]>, [string, number, number, number]?]>;
  /** Import declarations: [source, start, end, start of the first named specifier or -1, type-only]. */
  imports: Array<[string, number, number, number, boolean]>;
  /** Names that hold a messages object here. */
  messages: string[];
  /** How this file reads messages: `m.a.b()` or `m["a.b"]()`. */
  style: { dotted: number; bracket: number };
  /** Text the noise filters dropped, by reason. */
  ignored: Record<string, number>;
  parseErrors?: Array<{ message: string; offset: number }>;
  /** The file opted out with a nordbeam-locale-ignore-file comment. */
  skipped?: boolean;
}

const ignoreMarker = 'nordbeam-locale-ignore';

/** A sentence of UI copy: capitalized, four or more words, ending like a sentence or six words long, and short. */
function prose(text: string): boolean {
  if (text.length > 220 || !/^\p{Lu}/u.test(text)) return false;
  const words = text.match(/\p{L}[\p{L}'’-]*/gu)?.length ?? 0;
  return words >= 4 && (/[.!?…:]["'”’)]?$/.test(text.trim()) || words >= 6);
}
// Positions whose sentences are for developers: logs, assertions and built-in errors.
const proseSink = /^call:(?:new (?:Error|TypeError|RangeError|SyntaxError|ReferenceError|EvalError|URIError|AggregateError|DOMException)#|(?:console|logger|log|debug|assert|invariant|expect|describe|it|test)(?:[.#])|[\w$.]*\.(?:log|debug|info|warn|warning|error|trace|fatal|verbose)#)/;
const fileMarker = 'nordbeam-locale-ignore-file';

// Positions whose string is UI text whatever the element: they are announced or displayed.
const textAttributes = new Set(['placeholder', 'title', 'alt', 'label', 'aria-label', 'aria-description', 'aria-placeholder', 'aria-valuetext', 'aria-roledescription', 'aria-brailleroledescription', 'aria-braillelabel']);
// Names that usually carry text in props and object keys.
const textName = /^(?:label|title|description|placeholder|text|message|heading|subheading|subtitle|caption|tooltip|hint|helperText|helpText|summary|content|body|legend|prompt|question|answer|note|notice|tagline|eyebrow|headline|lead|intro|details|header|footer|cta|alt|empty|emptyState|confirm|cancel|tip)$|(?:Label|Text|Title|Message|Description|Placeholder|Tooltip|Hint|Caption|Heading|Subtitle|Headline|Copy|Prompt|Tip)$/;
// Names that never carry text, even when the project translates them elsewhere.
const codeName = /^(?:className|class|style|id|key|ref|href|src|srcSet|type|role|htmlFor|for|rel|target|method|action|encType|autoComplete|inputMode|pattern|accept|lang|dir|tabIndex|viewBox|d|fill|stroke|xmlns|width|height|variant|size|color|as|to|path|icon|mode|side|align|orientation|sizes|loading|decoding|crossOrigin|integrity|media|form|value|defaultValue|field|accessorKey|dataKey|slug|route|kind|format|locale|currency|unit|testId|layout|position|cursor|display|weight|tone|intent|theme|status|sort|order|direction|font|fontFamily|fontWeight|transform|transition|animation|easing|shape|severity|level|priority|category|tag|tagName|element|component|query|url|uri|domain|host|email|phone|mime|mimeType|encoding|charset|timezone|timeZone|dateFormat|placement|trigger|animationName)$|^(?:data-|aria-(?!label|description|placeholder|valuetext|roledescription|brailleroledescription|braillelabel))|^on[A-Z]|(?:Id|ID|Key|Class|ClassName|Url|URL|Href|Path|Icon|Type|Variant|Color|Size|Style|Name|Ref|Route|Slug|Format|Mode|Pattern|Selector|Event)$/;
// Callees whose first argument is shown to the user.
const textCall = /^(?:(?:window\.)?(?:alert|confirm|prompt)|toast(?:\.\w+)?|(?:notification|message|snackbar|notify)\.(?:success|error|info|warning|warn|open|loading|show)|enqueueSnackbar|showToast|addToast|notify|new Notification|\.setCustomValidity)$/;
// Assignments that put text on screen.
const textAssignment = /^(?:textContent|innerText|title|placeholder|alt|ariaLabel|label|ariaDescription)$/;
// Elements whose content is code, or text an i18n component already owns.
const opaqueElements = new Set(['code', 'pre', 'kbd', 'samp', 'var', 'script', 'style', 'math', 'Code', 'CodeBlock', 'Kbd', 'Pre', 'Trans', 'Translate', 'FormattedMessage', 'FormattedHTMLMessage']);
const translatorNames = /^(?:t|tt|tr|translate|formatMessage|\$t|i18n\.t|intl\.formatMessage|i18n\._|_)$/;

/**
 * i18n libraries whose calls and components hold their own text: Lingui
 * (`<Trans>`, `t\`…\``, `i18n._({ id, message })`), react-intl (`<FormattedMessage
 * defaultMessage>`, `intl.formatMessage`) and i18next (`t("key", "Default")`, `<Trans
 * i18nKey>`). That text is the message's source or default, so a project that has
 * not migrated yet reads as localized where it uses them.
 */
type LibraryRole = 'call' | 'forms' | 'object' | 'hook' | 'element';
const libraryExports: Readonly<Record<string, Readonly<Record<string, LibraryRole>>>> = {
  lingui: { t: 'call', msg: 'call', defineMessage: 'call', plural: 'forms', select: 'forms', selectOrdinal: 'forms', i18n: 'object', useLingui: 'hook', Trans: 'element', Plural: 'element', Select: 'element', SelectOrdinal: 'element' },
  intl: { defineMessage: 'call', defineMessages: 'call', useIntl: 'hook', createIntl: 'hook', FormattedMessage: 'element' },
  i18next: { t: 'call', default: 'object', i18n: 'object', useTranslation: 'hook', Trans: 'element', Translation: 'element' },
};
function libraryOf(source: string): string | undefined {
  if (/^@lingui\/(?:core|react|macro)(?:\/macro)?$/.test(source)) return 'lingui';
  if (/^(?:react-intl|@formatjs\/intl)$/.test(source)) return 'intl';
  if (/^(?:i18next|react-i18next|next-i18next)$/.test(source)) return 'i18next';
  return;
}
/** Methods of a library object that return a message: Lingui `i18n._`, i18next `i18n.t`, react-intl `intl.formatMessage`. */
const libraryMethod = /^(?:_|t|formatMessage)$/;
/** The same calls on conventional names, in a file that imports a library: `props.intl.formatMessage`, `this.props.t`. */
const conventionalLibraryCall = /^(?:(?:[\w$]+\.)*(?:i18n|i18next|intl|props)\.(?:_|t|formatMessage)|t)$/;
/** Keys of a message descriptor or options object whose strings are the ID, the default text, or notes for translators. */
const descriptorKey = /^(?:id|message|defaultMessage|description|comment|context|defaultValue(?:_\w+)?|defaults|i18nKey|ns)$/;
// Collection and string methods: an ID passed to them is data, not a translation.
const genericMethod = /(?:^|\.)(?:push|unshift|concat|join|includes|indexOf|lastIndexOf|startsWith|endsWith|set|get|has|add|delete|append|replace|replaceAll|split|find|filter|map|some|every|test|match|localeCompare|sort|splice|slice|at|keys|values|entries|assign|from|of|log|warn|error|info|debug)$/;

const entities: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', middot: '·', bull: '•', rarr: '→', larr: '←',
  times: '×', copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', euro: '€', pound: '£', deg: '°', shy: '­', zwj: '‍', zwnj: '‌',
};

/** Decode the HTML entities JSX text and attribute strings may contain. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi, (match, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (decimal || hex) { const code = parseInt(decimal ?? hex!, decimal ? 10 : 16); return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match; }
    return entities[name!] ?? match;
  });
}

/** JSX whitespace rules, as Babel applies them to a text child: lines are trimmed and joined with one space. */
export function cleanJsxText(raw: string): string {
  const lines = raw.split(/\r\n|\n|\r/);
  let last = 0;
  for (let i = 0; i < lines.length; i++) if (/[^ \t]/.test(lines[i]!)) last = i;
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!.replace(/\t/g, ' ');
    if (i > 0) line = line.replace(/^ +/, '');
    if (i < lines.length - 1) line = line.replace(/ +$/, '');
    if (line) out += i === last ? line : line + ' ';
  }
  return out;
}

export { noise } from './text-noise.js';
export type { Position } from './text-noise.js';

/** Collapse whitespace, the form used to compare source text with catalog text. */
export function normalizeText(text: string): string {
  return text.replace(/[\s ]+/g, ' ').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').trim();
}

/** Values that stand in for each other: branches and returns (strong), or neighbours in an object or array (weak). */
interface Group { localized: boolean; vias?: string[]; weak?: boolean }
/** Template content in document order: text, an expression, or a node that ends the run. */
export type RunItem = { text: string; start: number; end: number } | { expression: Node; start: number; end: number } | { other: () => void };
export interface Sink { key: string; where: string; kind: TextKind; base: 0 | 1 | 2; position: Position; wrap: TextWrap; extra?: string; hint?: 'labels' }
/** How a fix writes the message call: `{…}` (JSX, Svelte), as an expression, `{{ … }}` (Vue text), or as a bound attribute. */
export type TextWrap = 'jsx' | 'expression' | 'mustache' | `bind:${string}` | `attr:${string}`;
type Ref = { name: string; path: string[] };
interface Use { ref: Ref; sink: Sink; scope: number; group?: Group }

const unwrapTypes = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'TSInstantiationExpression', 'ParenthesizedExpression', 'ChainExpression']);
const typeImport = /^import\s+type\s+(?!from\b)[\w${*]/;
const valueTsTypes = new Set(['TSParameterProperty', 'TSExportAssignment', 'TSModuleDeclaration', 'TSModuleBlock', ...unwrapTypes]);

export function unwrap(node: Node | null | undefined): Node | undefined {
  while (node && unwrapTypes.has(node.type)) node = node.expression;
  return node ?? undefined;
}

/** `a.b.c` for a chain of identifiers, `new X` for constructors, `.c` when the object is not a name. */
export function calleeName(callee: Node | undefined): string | undefined {
  callee = unwrap(callee);
  if (!callee) return;
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'ThisExpression') return 'this';
  if (callee.type === 'Super') return 'super';
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
    const object = calleeName(callee.object);
    return object ? `${object}.${callee.property.name}` : `.${callee.property.name}`;
  }
  return;
}

function propertyName(node: Node, computed = false): string | undefined {
  if (!computed && node.type === 'Identifier') return node.name;
  if (node.type === 'Literal' && (typeof node.value === 'string' || typeof node.value === 'number')) return String(node.value);
  if (node.type === 'PrivateIdentifier') return node.name;
  return;
}

/** Root name and static path of `m.checkout.pay` or `m["checkout.pay"]`; computed parts end the path. */
function memberPath(node: Node): { root: string; path: string[]; bracket: boolean } | undefined {
  const path: string[] = [];
  let bracket = false;
  let current = unwrap(node);
  while (current?.type === 'MemberExpression') {
    const name = propertyName(current.property, current.computed);
    if (name === undefined) return;
    if (current.computed) bracket = true;
    path.unshift(name);
    current = unwrap(current.object);
  }
  if (current?.type !== 'Identifier') return;
  return { root: current.name, path, bracket };
}

const nameOf = (text: string): string | undefined => {
  const name = text.replace(/^[^A-Za-z_]+/, '').replace(/\W+(\w)/g, (_, letter: string) => letter.toUpperCase()).replace(/\W/g, '');
  return name && /^[A-Za-z_]\w*$/.test(name) ? name : undefined;
};

/** Analyze one ESTree program. `code` is the full file text the offsets point into. */
export function analyzeProgram(program: Node, code: string, context: ScanContext, comments: ReadonlyArray<{ value: string; start: number; end: number }> = []): FileFacts {
  const facts: FileFacts = { localized: 0, dynamic: {}, translators: {}, plainCalls: {}, evidence: [], candidates: [], scopes: [[-1, []]], imports: [], messages: [], style: { dotted: 0, bracket: 0 }, ignored: {} };
  const analyzer = createAnalyzer(facts, code, context, comments);
  analyzer.program(program);
  analyzer.finish();
  return facts;
}

export interface Analyzer {
  program(node: Node): void;
  /** Visit any node; the Vue and Svelte adapters call this for template expressions. */
  visit(node: Node | null | undefined): void;
  /** Visit an expression in a position that may show text. */
  value(node: Node, sink: Sink): void;
  /** Literal text a template language holds, such as a Vue attribute value. */
  text(text: string, start: number, end: number, sink: Sink): void;
  /** Template children: text, the simple expressions between it, and nodes that end a run. */
  run(items: readonly RunItem[], textSink: Sink, expressionSink: Sink): void;
  /** The sink of an attribute, or undefined when it holds code (`class`, `href`, `on*`). */
  attributeSink(element: string, name: string, intrinsic: boolean, type?: string): Sink | undefined;
  /** Skip text inside `translate="no"` and code elements while `depth` is positive. */
  opaque(delta: 1 | -1): void;
  /** Cover a node if an ignore comment precedes it. */
  cover(start: number, end: number): void;
  enterScope(): number;
  exitScope(previous: number): void;
  finish(): void;
}

/** Elements whose content is code, or text an i18n component already owns. */
export function opaqueElement(name: string): boolean { return opaqueElements.has(name); }

export function createAnalyzer(facts: FileFacts, code: string, context: ScanContext, comments: ReadonlyArray<{ value: string; start: number; end: number }>): Analyzer {
  const { ids, namespaces } = context;
  type Pending = Omit<TextCandidate, 'line' | 'column'> & { group?: Group };
  const candidates = new Map<string, Pending>();
  const messageNames = new Set<string>();
  // Names seen reading a known message, or made by a messages hook: the only ones a fix may call.
  const confirmed = new Set<string>();
  const localizedVars = new Map<string, string>();
  const constDefs = new Map<string, Node | null>();
  const functionReturns = new Map<string, Node[]>();
  const uses: Use[] = [];
  const callUses: Use[] = [];
  const aliases: Array<[string, Ref]> = [];
  let scope = 0;
  let functionGroup: Group | undefined;
  let returns: Node[] | undefined;
  let opaque = 0;
  // Names bound to an i18n library's exports, or to what its hooks return.
  const libraryNames = new Map<string, LibraryRole>();
  let libraryFile = false;

  // An ignore comment after code covers its own line; one on a line of its own covers the next node.
  // `eslint-disable i18next/no-literal-string` covers everything up to its `eslint-enable`.
  const ignoreStarts = new Set<number>(), ignoreLines: Array<[number, number]> = [], ignoreRanges: Array<[number, number]> = [];
  let disabledFrom = -1;
  for (const comment of comments) {
    const lint = /\bno-literal-string\b/.test(comment.value) ? /^\s*eslint-(disable|enable)(?:-line|-next-line)?\b/.exec(comment.value) : null;
    if (lint && !/-(?:next-)?line\b/.test(lint[0])) {
      if (lint[1] === 'disable' && disabledFrom < 0) disabledFrom = comment.start;
      else if (lint[1] === 'enable' && disabledFrom >= 0) { ignoreRanges.push([disabledFrom, comment.end]); disabledFrom = -1; }
      continue;
    }
    if (!comment.value.includes(ignoreMarker) && !lint) continue;
    const lineStart = code.lastIndexOf('\n', comment.start - 1) + 1, lineEnd = code.indexOf('\n', comment.end);
    if (!/^\s*\{?\s*$/.test(code.slice(lineStart, comment.start))) { ignoreLines.push([lineStart, lineEnd === -1 ? code.length : lineEnd]); continue; }
    if (lint?.[0].endsWith('-next-line')) {
      const nextStart = lineEnd === -1 ? code.length : lineEnd + 1, nextEnd = code.indexOf('\n', nextStart);
      ignoreLines.push([nextStart, nextEnd === -1 ? code.length : nextEnd]);
      continue;
    }
    let next = comment.end;
    while (next < code.length && /[\s}]/.test(code[next]!)) next++;
    ignoreStarts.add(next);
  }
  if (disabledFrom >= 0) ignoreRanges.push([disabledFrom, code.length]);
  const ignoredAt = (offset: number): boolean => ignoreRanges.some(([start, end]) => offset >= start && offset < end) || ignoreLines.some(([start, end]) => offset >= start && offset < end);
  const count = (reason: string): void => { facts.ignored[reason] = (facts.ignored[reason] ?? 0) + 1; };

  const declare = (name: string, from: string): void => { facts.scopes[scope]![1].push([name, from]); };
  const enterScope = (): number => { const previous = scope; facts.scopes.push([previous, []]); scope = facts.scopes.length - 1; return previous; };
  const exitScope = (previous: number): void => { scope = previous; };

  const resolveRef = (node: Node | undefined): Ref | undefined => {
    node = unwrap(node);
    if (!node) return;
    if (node.type === 'Identifier') {
      for (let i = aliases.length - 1; i >= 0; i--) if (aliases[i]![0] === node.name) return aliases[i]![1];
      return { name: node.name, path: [] };
    }
    if (node.type === 'MemberExpression') {
      const object = resolveRef(node.object);
      if (!object) return;
      const name = node.computed ? undefined : propertyName(node.property);
      return { name: object.name, path: [...object.path, name ?? '*'] };
    }
    return;
  };

  /** Keep one candidate per span: the strongest position, with any sibling evidence from either. */
  const record = (candidate: Pending): void => {
    if (opaque || ignoredAt(candidate.start)) { count('comment'); return; }
    const key = `${candidate.start}:${candidate.end}`, existing = candidates.get(key);
    if (!existing) { candidates.set(key, candidate); return; }
    const [strong, weak] = candidate.base > existing.base ? [candidate, existing] : [existing, candidate];
    candidates.set(key, { ...strong, scope: Math.max(strong.scope, weak.scope), local: strong.local || weak.local, group: strong.group ?? weak.group, via: strong.via ?? weak.via });
  };

  const evidence = (sink: Sink, via: string, group?: Group): void => {
    // Return values teach only their own function (the sibling group), never the project.
    if (sink.key !== 'child' && sink.key !== 'return' && sink.key !== 'code') {
      facts.evidence.push([sink.key, via]);
      if (sink.extra) facts.evidence.push([sink.extra, via]);
    }
    if (group) { if (via) (group.vias ??= []).push(via); else group.localized = true; }
  };

  /** The role of a callee or tag that an i18n library provides: a message call, or plural/select forms. */
  const libraryCall = (callee: Node | undefined): 'call' | 'forms' | undefined => {
    callee = unwrap(callee);
    if (!callee) return;
    if (callee.type === 'Identifier') {
      const role = libraryNames.get(callee.name);
      if (role === 'call' || role === 'forms') return role;
      return role === undefined && libraryFile && conventionalLibraryCall.test(callee.name) ? 'call' : undefined;
    }
    if (callee.type !== 'MemberExpression' || callee.computed || !libraryMethod.test(propertyName(callee.property) ?? '')) return;
    const object = unwrap(callee.object);
    if (object?.type === 'Identifier' && libraryNames.get(object.name) === 'object') return 'call';
    const name = calleeName(callee);
    return libraryFile && name && conventionalLibraryCall.test(name) ? 'call' : undefined;
  };

  /** `{ id: "checkout.pay", message: "Pay" }`: a Lingui or FormatJS message descriptor. A computed ID
   * (`{ id: Date.now(), message }`) is a notification or a record, not a message. */
  const descriptor = (node: Node): boolean => {
    let id = false, text = false;
    for (const property of node.properties) {
      if (property.type !== 'Property') continue;
      const key = propertyName(property.key, property.computed), value = unwrap(property.value);
      if (key === 'id') id = value?.type === 'Literal' && typeof value.value === 'string' || value?.type === 'TemplateLiteral' || value?.type === 'Identifier';
      else if (key === 'message' || key === 'defaultMessage') text = true;
    }
    return id && text;
  };
  /** A descriptor outside a call: in a file that imports a library, or with a literal ID that is a catalog
   * message, key-shaped (`{ id: "team.sweden", message: "Team Sweden" }`) or the text itself (`{ id: "Save", message: "Save" }`). */
  const standaloneDescriptor = (node: Node): boolean => {
    if (!descriptor(node)) return false;
    if (libraryFile) return true;
    const literal = (key: string): string | undefined => {
      const property = node.properties.find((item: Node) => item.type === 'Property' && propertyName(item.key, item.computed) === key);
      const value = unwrap(property?.value);
      return value?.type === 'Literal' && typeof value.value === 'string' ? value.value : undefined;
    };
    const id = literal('id');
    return id !== undefined && (ids.has(id) || /^[\w-]+(?:\.[\w-]+)+$/.test(id) || id === (literal('message') ?? literal('defaultMessage')));
  };

  /** Bind what an i18n library hook returns: `const { i18n, _ } = useLingui()`, `const [t] = useTranslation()`, `const intl = useIntl()`. */
  const bindLibrary = (id: Node, init: Node | undefined): void => {
    const source = unwrap(init?.type === 'AwaitExpression' ? init.argument : init);
    if (source?.type !== 'CallExpression') return;
    const callee = unwrap(source.callee);
    if (callee?.type !== 'Identifier' || libraryNames.get(callee.name) !== 'hook') return;
    const role = (key: string | undefined): LibraryRole | undefined => key === undefined ? undefined : libraryMethod.test(key) ? 'call' : /^(?:i18n|intl)$/.test(key) ? 'object' : undefined;
    if (id.type === 'Identifier') libraryNames.set(id.name, 'object');
    else if (id.type === 'ObjectPattern') {
      for (const property of id.properties) {
        if (property.type !== 'Property') continue;
        const local = unwrap(property.value)!, name = local.type === 'Identifier' ? local.name : local.type === 'AssignmentPattern' && local.left.type === 'Identifier' ? local.left.name : undefined;
        const bound = role(propertyName(property.key, property.computed));
        if (name && bound) libraryNames.set(name, bound);
      }
    } else if (id.type === 'ArrayPattern') {
      // react-i18next: `const [t, i18n] = useTranslation()`.
      const [first, second] = id.elements;
      if (first?.type === 'Identifier') libraryNames.set(first.name, 'call');
      if (second?.type === 'Identifier') libraryNames.set(second.name, 'object');
    }
  };

  /** A component that renders a library message: an imported `<Trans>`, `<Plural>` or `<FormattedMessage>`, or any `<Trans i18nKey>`. */
  const libraryElement = (node: Node): boolean => {
    const name = jsxName(node.openingElement.name);
    if (libraryNames.get(name) === 'element') return true;
    return opaqueElements.has(name) && /^(?:Trans|Translate|FormattedMessage)$/.test(name)
      && node.openingElement.attributes.some((attribute: Node) => attribute.type === 'JSXAttribute' && /^(?:id|i18nKey|message|defaultMessage)$/.test(attribute.name.name));
  };

  /** Arguments of a message call are IDs, default text and values: values may still hold text, the rest never does. */
  const messageArgument = (arg: Node, forms: boolean): void => {
    const node = unwrap(arg)!;
    if (node.type === 'Literal') return;
    if (node.type === 'TemplateLiteral') { for (const expression of node.expressions) visit(expression); return; }
    if (node.type === 'ObjectExpression') {
      // `plural(count, { one: "# item", other: "# items" })`: every key is a form of the message.
      if (forms) { for (const property of node.properties) property.type === 'Property' ? messageArgument(property.value, false) : visit(property); return; }
      object(node, true);
      return;
    }
    visit(node);
  };

  /** A message reference: '' when certain, the callee name when it depends on the project, undefined otherwise. */
  const localized = (node: Node): string | undefined => {
    node = unwrap(node)!;
    switch (node.type) {
      case 'CallExpression': return call(node);
      case 'TaggedTemplateExpression': if (libraryCall(node.tag)) { facts.localized++; return ''; } return;
      case 'ObjectExpression': if (standaloneDescriptor(node)) return ''; return;
      case 'MemberExpression': {
        const chain = memberPath(node);
        if (chain && chain.path.length && (messageNames.has(chain.root) || knownPath(chain.path, chain.root))) {
          if (knownPath(chain.path, chain.root)) confirmed.add(chain.root);
          facts.localized++; return '';
        }
        return;
      }
      case 'Identifier': return localizedVars.get(node.name);
      case 'AwaitExpression': return node.argument ? localized(node.argument) : undefined;
      case 'JSXElement': {
        if (libraryElement(node)) { facts.localized++; return ''; }
        // <Trans id="…"/> and <FormattedMessage id="…"/> render catalog text.
        for (const attribute of node.openingElement.attributes) {
          if (attribute.type === 'JSXAttribute' && attribute.value?.type === 'Literal' && typeof attribute.value.value === 'string' && ids.has(attribute.value.value)) { facts.localized++; return ''; }
        }
        return;
      }
      default: return;
    }
  };

  /** `m.checkout.pay` names a message. A one-segment path counts only on a messages-like root,
   * so `form.title()` stays code when the catalog happens to hold an ID "title". */
  const knownPath = (path: readonly string[], root: string): boolean => {
    if (!path.length) return false;
    const conventional = messageNames.has(root) || /^(?:m|msg|msgs|messages|i18n)$/.test(root);
    if (ids.has(path.join('.')) && (path.length > 1 || conventional)) return true;
    for (let i = 1; i < path.length - 1; i++) if (ids.has(path.slice(i).join('.'))) return true;
    return false;
  };

  /** A message ID argument. A one-segment ID such as "title" counts only for a translator-like
   * callee, so `querySelector("title")` does not turn querySelector into a translator. */
  const knownKey = (node: Node | undefined, callee: string | undefined): boolean => {
    node = unwrap(node);
    if (!node) return false;
    if (node.type === 'Literal' && typeof node.value === 'string') return ids.has(node.value) && (node.value.includes('.') || !!callee && (translatorNames.test(callee) || /(?:^|\.)(?:t|translate|formatMessage|getMessage|message|msg)$/i.test(callee)));
    if (node.type === 'TemplateLiteral' && node.expressions.length) {
      const prefix = node.quasis[0].value.cooked as string ?? '';
      return prefix.endsWith('.') && namespaces.has(prefix.slice(0, -1));
    }
    if (node.type === 'ObjectExpression') {
      if (node.properties.some((property: Node) => property.type === 'Property' && /^(?:id|key|i18nKey)$/.test(propertyName(property.key, property.computed) ?? '') && knownKey(property.value, 'formatMessage'))) return true;
      // `i18n._({ id: "Saved", message: "Saved" })` through a project's own i18n module: a descriptor with a literal ID.
      return !!callee && translatorNames.test(callee) && descriptor(node) && node.properties.some((property: Node) => property.type === 'Property' && propertyName(property.key, property.computed) === 'id' && unwrap(property.value)?.type === 'Literal');
    }
    return false;
  };

  const handled = new WeakSet<Node>();
  /** Classify a call once: message call, translator call or neither. Visits its parts. */
  const call = (node: Node): string | undefined => {
    if (handled.has(node)) return (node as any).__localized;
    handled.add(node);
    let result: string | undefined;
    const callee = unwrap(node.callee)!;
    const name = calleeName(callee);
    const chain = callee.type === 'MemberExpression' ? memberPath(callee) : undefined;
    const library = libraryCall(callee);
    if (library) result = '';
    else if (chain && chain.path.length && (messageNames.has(chain.root) || knownPath(chain.path, chain.root))) {
      result = '';
      if (chain.bracket) facts.style.bracket++; else facts.style.dotted++;
      if (knownPath(chain.path, chain.root)) { messageNames.add(chain.root); confirmed.add(chain.root); }
    } else {
      const args: Node[] = node.arguments;
      for (let i = 0; i < Math.min(args.length, 3); i++) {
        if (knownKey(args[i], name)) {
          result = '';
          if (name && !genericMethod.test(name)) { const seen = facts.translators[name]; facts.translators[name] = [seen?.[0] ?? i, (seen?.[1] ?? 0) + 1]; }
          break;
        }
      }
      if (result === undefined && name && args.length) {
        const first = unwrap(args[0]);
        if (first?.type === 'Literal' && typeof first.value === 'string') facts.plainCalls[name] = (facts.plainCalls[name] ?? 0) + 1;
        if (first && first.type !== 'Literal' && first.type !== 'ObjectExpression' && first.type !== 'ArrowFunctionExpression' && first.type !== 'FunctionExpression') {
          facts.dynamic[name] = (facts.dynamic[name] ?? 0) + 1;
          result = name;
        }
      }
    }
    if (result === '') facts.localized++;
    (node as any).__localized = result;
    visit(node.callee);
    const args: Node[] = node.arguments;
    // A message's or translator's arguments are keys, default text and values, never text of their own.
    if (result === '') args.forEach((arg, index) => messageArgument(arg, library === 'forms' && index > 0));
    else {
      const sinkName = name ?? (callee.type === 'MemberExpression' && !callee.computed ? `.${callee.property.name}` : undefined);
      aliasCallback(callee, args, () => {
        for (let i = 0; i < args.length; i++) {
          const arg = args[i]!;
          if (arg.type === 'SpreadElement' || !sinkName || arg.type === 'ArrowFunctionExpression' || arg.type === 'FunctionExpression') { visit(arg); continue; }
          value(arg, callSink(sinkName, i));
        }
      });
    }
    return result;
  };

  const callSink = (name: string, index: number): Sink => {
    const known = index === 0 && (textCall.test(name) || context.calls.has(name));
    return { key: `call:${name}#${index}`, where: `${name}()`, kind: 'argument', base: known ? 1 : 0, position: known ? 'text' : 'code', wrap: 'expression' };
  };

  /** `ITEMS.map(item => …)`: inside the callback, `item` stands for an element of ITEMS. */
  const aliasCallback = (callee: Node, args: Node[], body: () => void): void => {
    const fn = args[0];
    if (callee.type !== 'MemberExpression' || callee.computed || !/^(?:map|flatMap|forEach|filter|find|some|every|reduce)$/.test(callee.property.name) || !fn || (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression')) { body(); return; }
    const source = resolveRef(callee.object);
    const param = fn.params[callee.property.name === 'reduce' ? 1 : 0];
    const before = aliases.length;
    if (source && param) bindPattern(param, { name: source.name, path: [...source.path, '*'] });
    body();
    aliases.length = before;
  };

  const bindPattern = (pattern: Node, ref: Ref): void => {
    pattern = unwrap(pattern)!;
    if (pattern.type === 'Identifier') aliases.push([pattern.name, ref]);
    else if (pattern.type === 'AssignmentPattern') bindPattern(pattern.left, ref);
    else if (pattern.type === 'ObjectPattern') {
      for (const property of pattern.properties) {
        if (property.type !== 'Property') continue;
        const key = propertyName(property.key, property.computed);
        if (key !== undefined) bindPattern(property.value, { name: ref.name, path: [...ref.path, key] });
      }
    } else if (pattern.type === 'ArrayPattern') {
      for (const element of pattern.elements) if (element) bindPattern(element, { name: ref.name, path: [...ref.path, '*'] });
    }
  };

  /** Text with `{name}` placeholders from string parts and expressions. */
  const compose = (parts: Array<string | Node>): { text: string; args: TextArgument[]; letters: string } => {
    let text = '', letters = '';
    const args: TextArgument[] = [], used = new Set<string>();
    for (const part of parts) {
      if (typeof part === 'string') { text += escapeIcu(part); letters += part; continue; }
      const node = unwrap(part)!;
      let base = node.type === 'Identifier' ? node.name
        : node.type === 'MemberExpression' && !node.computed ? propertyName(node.property)
        : node.type === 'CallExpression' ? (unwrap(node.arguments[0])?.type === 'Identifier' ? unwrap(node.arguments[0])!.name : calleeName(node.callee)?.split('.').pop())
        : undefined;
      base = (base && nameOf(base.replace(/^get(?=[A-Z])/, ''))) || 'value';
      base = base[0]!.toLowerCase() + base.slice(1);
      let name = base;
      for (let n = 2; used.has(name); n++) name = `${base}${n}`;
      used.add(name);
      args.push({ name, code: code.slice(part.start, part.end) });
      text += `{${name}}`;
      letters += ' ';
    }
    return { text, args, letters };
  };

  const candidate = (node: Node, text: string, letters: string, args: TextArgument[], sink: Sink, group?: Group, wrap = sink.wrap): void => {
    const reason = noise(letters, sink.position);
    if (reason) { count(reason); return; }
    // A sentence reads as UI text wherever it is, unless it goes to a log or a built-in error.
    const sentence = !sink.base && prose(letters) && !proseSink.test(sink.key);
    record({ start: node.start, end: node.end, text, kind: sink.kind, sink: sink.key, ...(sink.extra ? { family: sink.extra } : {}), where: sink.where, base: sentence ? 1 : sink.base, local: false, scope, wrap,
      ...(sentence ? { hint: 'sentence' as const } : sink.hint ? { hint: sink.hint } : {}), ...(args.length ? { args } : {}), ...(group ? { group } : {}) });
  };

  /** Flatten `"Hello " + name + "!"` into parts. */
  const concatenation = (node: Node, parts: Array<string | Node>): boolean => {
    node = unwrap(node)!;
    if (node.type === 'BinaryExpression' && node.operator === '+') return concatenation(node.left, parts) && concatenation(node.right, parts);
    if (node.type === 'Literal' && typeof node.value === 'string') { parts.push(node.value); return true; }
    if (node.type === 'TemplateLiteral') { template(node, parts); return true; }
    if (node.type === 'Literal' || node.type === 'ObjectExpression' || node.type === 'ArrayExpression' || node.type.startsWith('JSX') || node.type.endsWith('FunctionExpression')) return false;
    parts.push(node);
    return true;
  };
  const template = (node: Node, parts: Array<string | Node>): void => {
    node.quasis.forEach((quasi: Node, i: number) => {
      parts.push(quasi.value.cooked ?? quasi.value.raw);
      if (i < node.expressions.length) parts.push(node.expressions[i]);
    });
  };

  /** The text of a string or template branch, or undefined for anything else. */
  const branchText = (input: Node): { text: string; letters: string; args: TextArgument[]; parts: Node[] } | undefined => {
    const node = unwrap(input)!;
    if (node.type === 'Literal' && typeof node.value === 'string') return { text: escapeIcu(node.value), letters: node.value, args: [], parts: [] };
    if (node.type !== 'TemplateLiteral' || node.expressions.some((expression: Node) => localized(expression) !== undefined)) return;
    const parts: Array<string | Node> = [];
    template(node, parts);
    return { ...compose(parts), parts: node.expressions };
  };

  /** The locale a test selects: `locale === "en"`, `lang !== "sv"`, `english`, `isSwedish`, `!isEn`. */
  const branchLocales = (input: Node): [string, string] | undefined => {
    const test = unwrap(input)!;
    if (context.locales.length !== 2) return;
    const other = (locale: string): string => context.locales.find(item => item !== locale)!;
    const named = (text: string): string | undefined => {
      const word = text.replace(/^(?:is|use|in)(?=[A-Z_])/, '').replace(/[^A-Za-z]/g, '').toLowerCase();
      return context.locales.find(locale => context.localeNames.get(locale)?.includes(word));
    };
    if (test.type === 'UnaryExpression' && test.operator === '!') { const inner = branchLocales(test.argument); return inner && [inner[1], inner[0]]; }
    if (test.type === 'BinaryExpression' && /^[!=]==?$/.test(test.operator)) {
      const [subject, literal] = unwrap(test.right)!.type === 'Literal' ? [unwrap(test.left)!, unwrap(test.right)!] : [unwrap(test.right)!, unwrap(test.left)!];
      if (literal.type !== 'Literal' || typeof literal.value !== 'string') return;
      const locale = context.locales.find(item => item === literal.value || item.split('-')[0] === literal.value.split('-')[0]);
      const subjectName = subject.type === 'CallExpression' ? calleeName(subject.callee) : calleeName(subject);
      if (!locale || !subjectName || !/locale|lang|language/i.test(subjectName.split('.').pop()!)) return;
      return test.operator.startsWith('=') ? [locale, other(locale)] : [other(locale), locale];
    }
    const name = test.type === 'CallExpression' ? calleeName(test.callee) : calleeName(test);
    const locale = name ? named(name.split('.').pop()!) : undefined;
    return locale ? [locale, other(locale)] : undefined;
  };

  /** `english ? "Hi" : "Hej"`: one message whose translations the source already holds. */
  const inline = (node: Node, sink: Sink, group?: Group): boolean => {
    const locales = branchLocales(node.test);
    if (!locales) return false;
    const first = branchText(node.consequent), second = branchText(node.alternate);
    if (!first || !second) return false;
    const [primary, primaryLocale] = locales[1] === context.base ? [second, locales[1]] : [first, locales[0]];
    const [secondary, secondaryLocale] = primary === first ? [second, locales[1]] : [first, locales[0]];
    visit(node.test);
    for (const part of [...first.parts, ...second.parts]) visit(part);
    // Locale tags, paths and URLs per language are code: `english ? "en-GB" : "sv-SE"`.
    const reason = noise(primary.letters, sink.position) ?? noise(secondary.letters, sink.position);
    if (reason) { count(reason); return true; }
    // The two branches must show the same values for one message to hold both.
    const names = (args: TextArgument[]): string => args.map(arg => `${arg.name}=${arg.code}`).sort().join('\u0000');
    const same = names(primary.args) === names(secondary.args);
    record({ start: node.start, end: node.end, text: primary.text, kind: sink.kind, sink: sink.key, ...(sink.extra ? { family: sink.extra } : {}), where: sink.where, base: 2, local: false, scope, wrap: sink.wrap,
      ...(same ? { translations: { [primaryLocale]: primary.text, [secondaryLocale]: secondary.text } } : {}), ...(primary.args.length ? { args: primary.args } : {}), ...(group ? { group } : {}) });
    return true;
  };

  /** An expression in a position that may show text. */
  const value = (input: Node, sink: Sink, group?: Group): void => {
    const node = unwrap(input);
    if (!node) return;
    switch (node.type) {
      case 'Literal':
        if (typeof node.value === 'string') candidate(node, escapeIcu(node.value), node.value, [], sink, group);
        return;
      case 'TemplateLiteral': {
        let message = false;
        for (const expression of node.expressions) { const via = localized(expression); if (via !== undefined) { message = true; evidence(sink, via, group); } else visit(expression); }
        const parts: Array<string | Node> = [];
        template(node, parts);
        const composed = compose(parts);
        if (!message || /\p{L}{2,}/u.test(composed.letters)) candidate(node, composed.text, composed.letters, composed.args, sink, group);
        return;
      }
      case 'BinaryExpression': {
        const parts: Array<string | Node> = [];
        if (node.operator === '+' && concatenation(node, parts) && parts.some(part => typeof part === 'string')) {
          let message = false;
          for (const part of parts) if (typeof part !== 'string') { const via = localized(part); if (via !== undefined) { message = true; evidence(sink, via, group); } else visit(part); }
          const composed = compose(parts);
          if (!message || /\p{L}{2,}/u.test(composed.letters)) candidate(node, composed.text, composed.letters, composed.args, sink, group);
          return;
        }
        visit(node);
        return;
      }
      case 'ConditionalExpression': {
        if (inline(node, sink, group)) return;
        visit(node.test);
        const branches: Group = group ?? { localized: false };
        value(node.consequent, sink, branches);
        value(node.alternate, sink, branches);
        return;
      }
      case 'LogicalExpression': {
        const branches: Group = group ?? { localized: false };
        if (node.operator === '&&') { visit(node.left); value(node.right, sink, branches); }
        else { value(node.left, sink, branches); value(node.right, sink, branches); }
        return;
      }
      case 'ArrayExpression': {
        const elements: Group = { localized: false, weak: true };
        for (const element of node.elements) if (element) element.type === 'SpreadElement' ? visit(element) : value(element, { ...sink, extra: undefined }, elements);
        return;
      }
      case 'CallExpression': {
        const via = call(node);
        if (via !== undefined) { evidence(sink, via, group); return; }
        const name = calleeName(node.callee);
        if (name && !name.includes('.')) callUses.push({ ref: { name, path: [] }, sink, scope, group });
        return;
      }
      case 'AwaitExpression': value(node.argument, sink, group); return;
      case 'Identifier':
      case 'MemberExpression': {
        const via = localized(node);
        if (via !== undefined) { evidence(sink, via, group); if (node.type === 'MemberExpression') visit(node.object); return; }
        const ref = resolveRef(node);
        if (ref) uses.push({ ref, sink, scope, group });
        if (node.type === 'MemberExpression') visit(node);
        return;
      }
      case 'JSXElement': {
        const via = localized(node);
        if (via !== undefined) { evidence(sink, via, group); return; }
        visit(node);
        return;
      }
      case 'TaggedTemplateExpression':
        // Lingui's t`Hello ${name}` and msg`…` are messages; other tags hold code (css`…`, gql`…`).
        if (libraryCall(node.tag)) { facts.localized++; evidence(sink, '', group); }
        visit(node.tag);
        for (const expression of node.quasi.expressions) visit(expression);
        return;
      case 'ObjectExpression':
        if (standaloneDescriptor(node)) evidence(sink, '', group);
        visit(node);
        return;
      default:
        visit(node);
    }
  };

  const childSink: Sink = { key: 'child', where: 'JSX text', kind: 'jsx-expression', base: 2, position: 'child', wrap: 'expression' };
  const inlineSink: Sink = { key: 'code', where: 'inline translation', kind: 'inline', base: 2, position: 'text', wrap: 'expression' };

  const attributeSink = (element: string, name: string, intrinsic: boolean, extra?: { type?: string }): Sink | undefined => {
    if (codeName.test(name) && !(name === 'value' && intrinsic && /^(?:submit|button|reset)$/.test(extra?.type ?? ''))) return;
    const configured = context.attributes.has(name) || context.attributes.has(`${element}.${name}`);
    const text = textAttributes.has(name) || configured || name === 'value';
    const base: 0 | 1 | 2 = text ? 2 : textName.test(name) ? 1 : 0;
    return { key: intrinsic ? `attr:${name}` : `elem:${element}#${name}`, extra: intrinsic ? undefined : `attr:${name}`, where: `<${element} ${name}>`, kind: 'attribute', base, position: base ? 'text' : 'code', wrap: 'jsx' };
  };

  const jsxName = (node: Node): string => {
    switch (node.type) {
      case 'JSXIdentifier': return node.name;
      case 'JSXMemberExpression': return `${jsxName(node.object)}.${node.property.name}`;
      case 'JSXNamespacedName': return `${node.namespace.name}:${node.name.name}`;
      default: return '';
    }
  };

  const element = (node: Node): void => {
    const opening = node.openingElement;
    const name = jsxName(opening.name);
    const intrinsic = /^[a-z]/.test(name) && !name.includes('.');
    // A library message component owns its children and props: `<Plural one="# item" other="# items">`.
    const library = libraryElement(node);
    if (library) facts.localized++;
    let skip = library || opaqueElements.has(name);
    let type: string | undefined;
    for (const attribute of opening.attributes) {
      if (attribute.type !== 'JSXAttribute') continue;
      const attributeName = attribute.name.type === 'JSXIdentifier' ? attribute.name.name : '';
      const literal = attribute.value?.type === 'Literal' ? attribute.value.value : undefined;
      if (attributeName === 'translate' && literal === 'no' || attributeName === 'data-nordbeam-locale-ignore' || attributeName === 'className' && typeof literal === 'string' && /\bnotranslate\b/.test(literal)) skip = true;
      if (attributeName === 'type' && typeof literal === 'string') type = literal;
    }
    if (ignoreStarts.has(node.start)) ignoreRanges.push([node.start, node.end]);
    if (skip) opaque++;
    visit(opening.name);
    for (const attribute of opening.attributes) {
      if (attribute.type === 'JSXSpreadAttribute') { visit(attribute.argument); continue; }
      const attributeName = attribute.name.type === 'JSXIdentifier' ? attribute.name.name : jsxName(attribute.name);
      const attributeValue = attribute.value;
      if (!attributeValue) continue;
      const sink = attributeSink(name, attributeName, intrinsic, { type });
      if (attributeValue.type === 'Literal') {
        if (sink && typeof attributeValue.value === 'string') {
          const text = decodeEntities(attributeValue.raw ? attributeValue.raw.slice(1, -1) : attributeValue.value);
          candidate(attributeValue, escapeIcu(text), text, [], sink);
        }
      } else if (attributeValue.type === 'JSXExpressionContainer') {
        if (attributeValue.expression.type === 'JSXEmptyExpression') continue;
        if (sink) value(attributeValue.expression, { ...sink, wrap: 'expression' }); else visit(attributeValue.expression);
      } else visit(attributeValue);
    }
    children(node.children);
    if (skip) opaque--;
  };

  /** JSX children as run items: text, expressions between it, and elements that end a run. */
  const children = (nodes: Node[]): void => {
    const items: RunItem[] = [];
    for (const child of nodes) {
      if (child.type === 'JSXText') {
        const raw = code.slice(child.start, child.end), cleaned = decodeEntities(cleanJsxText(raw));
        if (!cleaned) continue;
        const lead = raw.length - raw.trimStart().length, trail = raw.length - raw.trimEnd().length;
        items.push(raw.trim() ? { text: cleaned, start: child.start + lead, end: child.end - trail } : { text: cleaned, start: child.start, end: child.end });
      } else if (child.type === 'JSXExpressionContainer') {
        if (child.expression.type !== 'JSXEmptyExpression') items.push({ expression: child.expression, start: child.start, end: child.end });
      } else items.push({ other: () => visit(child) });
    }
    run(items, jsxTextSink, childSink);
  };
  const jsxTextSink: Sink = { key: 'child', where: 'JSX text', kind: 'jsx-text', base: 2, position: 'child', wrap: 'jsx' };

  /** Merge text and the simple expressions between it into one message: `You have {count} invoices`. */
  const run = (items: readonly RunItem[], textSink: Sink, expressionSink: Sink): void => {
    let parts: Array<string | Node> = [], start = -1, end = -1, letters = false;
    const flush = (): void => {
      if (letters) {
        const composed = compose(parts);
        const reason = noise(composed.letters, 'child');
        if (reason) count(reason);
        else record({ start, end, text: composed.text.trim(), kind: textSink.kind, sink: textSink.key, where: textSink.where, base: textSink.base, local: false, scope, wrap: textSink.wrap, ...(composed.args.length ? { args: composed.args } : {}) });
      }
      parts = []; start = -1; end = -1; letters = false;
    };
    const extend = (item: { start: number; end: number }): void => { if (start === -1) start = item.start; end = item.end; };
    for (const item of items) {
      if ('text' in item) {
        if (start === -1 && !item.text.trim()) continue;
        parts.push(item.text); extend(item);
        if (/\p{L}/u.test(item.text)) letters = true;
        continue;
      }
      if ('expression' in item) {
        const expression = unwrap(item.expression)!;
        if (expression.type === 'Literal' && typeof expression.value === 'string') {
          if (start === -1 && !expression.value.trim()) continue;
          parts.push(expression.value); extend(item);
          if (/\p{L}/u.test(expression.value)) letters = true;
          continue;
        }
        if (placeholder(expression)) { visit(expression); parts.push(expression); extend(item); continue; }
        flush();
        if (ignoreStarts.has(item.start)) ignoreRanges.push([item.start, item.end]);
        value(expression, expressionSink);
        continue;
      }
      flush();
      item.other();
    }
    flush();
  };

  /** A child expression that reads like a value inside a sentence. */
  const placeholder = (node: Node): boolean => {
    node = unwrap(node)!;
    if (node.type === 'Identifier') return node.name !== 'children' && localizedVars.get(node.name) === undefined;
    if (node.type === 'MemberExpression') return localized(node) === undefined && !(memberPath(node)?.path.at(-1) === 'children');
    if (node.type === 'CallExpression') {
      const callee = unwrap(node.callee)!;
      if (callee.type === 'MemberExpression' && !callee.computed && /^(?:map|flatMap|filter|reduce)$/.test(callee.property.name)) return false;
      const name = calleeName(callee);
      if (libraryCall(callee) || name && (translatorNames.test(name) || facts.translators[name] !== undefined || /^[A-Z]/.test(name.split('.').pop()!))) return false;
      if (node.arguments.some((arg: Node) => knownKey(arg, name))) return false;
      const chain = callee.type === 'MemberExpression' ? memberPath(callee) : undefined;
      return !(chain && (messageNames.has(chain.root) || knownPath(chain.path, chain.root)));
    }
    return false;
  };

  const functionNode = (node: Node, name?: string, label = name): void => {
    const previous = enterScope();
    // Hooks cannot run in async (server) components or generators.
    const first = node.body?.type === 'BlockStatement' && !node.async && !node.generator ? node.body.body[0] : undefined;
    if (label && first) facts.scopes[facts.scopes.length - 1]![2] = [label, first.start, node.start, node.end];
    const outerGroup = functionGroup, outerReturns = returns;
    functionGroup = { localized: false };
    returns = [];
    for (const param of node.params) visitParam(param);
    if (node.body?.type === 'BlockStatement') visit(node.body);
    else if (node.body) { returns.push(unwrap(node.body)!); value(node.body, returnSink, functionGroup); }
    if (name) functionReturns.set(name, returns);
    functionGroup = outerGroup; returns = outerReturns;
    exitScope(previous);
  };
  const returnSink: Sink = { key: 'return', where: 'return', kind: 'return', base: 0, position: 'code', wrap: 'expression' };

  /** Default values of props: `function Empty({ title = "Nothing here" })`. */
  const visitParam = (param: Node): void => {
    param = unwrap(param)!;
    if (param.type === 'TSParameterProperty') { visitParam(param.parameter); return; }
    if (param.type === 'AssignmentPattern') {
      const name = param.left.type === 'Identifier' ? param.left.name : undefined;
      if (name) value(param.right, propertySink(name)); else visit(param.right);
      visitParam(param.left);
      return;
    }
    if (param.type === 'ObjectPattern') {
      for (const property of param.properties) {
        if (property.type === 'RestElement') continue;
        const key = propertyName(property.key, property.computed);
        const inner = unwrap(property.value)!;
        if (inner.type === 'AssignmentPattern') {
          if (key !== undefined) value(inner.right, propertySink(key)); else visit(inner.right);
          visitParam(inner.left);
        } else visitParam(inner);
      }
      return;
    }
    if (param.type === 'ArrayPattern') { for (const element of param.elements) if (element) visitParam(element); }
  };

  const propertySink = (key: string): Sink => {
    if (codeName.test(key)) return { key: 'code', where: `${key}:`, kind: 'property', base: 0, position: 'code', wrap: 'expression' };
    const base: 0 | 1 = textName.test(key) || context.attributes.has(key) ? 1 : 0;
    return { key: `key:${key}`, where: `${key}:`, kind: 'property', base, position: base ? 'text' : 'code', wrap: 'expression' };
  };

  /** An object literal. In a message descriptor or the options of a message call (`messages`), the ID, default text and notes are not findings. */
  const object = (node: Node, messages = false): void => {
    // `{ id: "home.title", message: "Welcome" }`: a Lingui or react-intl descriptor.
    if (!messages && standaloneDescriptor(node)) { facts.localized++; messages = true; }
    if (!messages && localeObject(node)) return;
    const siblings: Group = { localized: false, weak: true };
    const labels = !messages && labelMap(node);
    for (const property of node.properties) {
      if (property.type !== 'Property') { visit(property); continue; }
      if (property.computed) visit(property.key);
      const key = propertyName(property.key, property.computed);
      if (ignoreStarts.has(property.start)) ignoreRanges.push([property.start, property.end]);
      const propertyValue = unwrap(property.value)!;
      if (messages && key !== undefined && descriptorKey.test(key) && property.kind === 'init') { messageArgument(propertyValue, false); continue; }
      // react-intl's defineMessages({ greeting: { id, defaultMessage } }): a map of descriptors.
      if (messages && propertyValue.type === 'ObjectExpression' && descriptor(propertyValue)) { facts.localized++; object(propertyValue, true); continue; }
      if (property.kind !== 'init' || propertyValue.type === 'FunctionExpression' || propertyValue.type === 'ArrowFunctionExpression') {
        if ((propertyValue.type === 'FunctionExpression' || propertyValue.type === 'ArrowFunctionExpression') && key) functionNode(propertyValue, key);
        else visit(property.value);
        continue;
      }
      // A dotted or catalog key is a catalog copy (`"checkout.pay": "Pay"`), not a prop.
      if (key === undefined || key.includes('.') || ids.has(key)) { visit(property.value); continue; }
      const sink = propertySink(key);
      if (sink.key === 'code') { visit(property.value); continue; }
      value(property.value, labels && !sink.base ? { ...sink, base: 1, position: 'text', hint: 'labels' } : sink, siblings);
    }
  };

  /** `{ sv: "Spara", en: "Save" }`: the translations of one message, keyed by the project's locales. */
  const localeObject = (node: Node): boolean => {
    if (context.locales.length < 2 || node.properties.length !== context.locales.length) return false;
    const texts = new Map<string, NonNullable<ReturnType<typeof branchText>>>();
    for (const property of node.properties) {
      if (property.type !== 'Property' || property.kind !== 'init' || property.computed) return false;
      const key = propertyName(property.key);
      const locale = context.locales.find(item => item === key || item.split('-')[0] === key);
      const text = locale && !texts.has(locale) ? branchText(property.value) : undefined;
      if (!text) return false;
      texts.set(locale!, text);
    }
    const base = texts.get(context.base) ?? texts.values().next().value!;
    for (const text of texts.values()) for (const part of text.parts) visit(part);
    const reason = noise(base.letters, 'text');
    if (reason) { count(reason); return true; }
    record({ start: node.start, end: node.end, text: base.text, kind: 'inline', sink: 'code', where: 'translations object', base: 2, local: false, scope, wrap: 'expression',
      // The object is read by locale at runtime, so a fix cannot swap it for one call.
      via: 'an object of translations', translations: Object.fromEntries([...texts].map(([locale, text]) => [locale, text.text])), ...(base.args.length ? { args: base.args } : {}) });
    return true;
  };

  /** `{ draft: "Draft", sent: "Sent", paid: "Paid" }`: display labels for codes. */
  const labelMap = (node: Node): boolean => {
    if (node.properties.length < 3) return false;
    let capitalized = 0, differs = false;
    for (const property of node.properties) {
      if (property.type !== 'Property' || property.kind !== 'init' || property.computed) return false;
      const key = propertyName(property.key), item = unwrap(property.value)!;
      if (key === undefined || key.includes('.') || ids.has(key) || propertySink(key).key === 'code') return false;
      if (item.type !== 'Literal' || typeof item.value !== 'string' || noise(item.value, 'text')) return false;
      if (/^\p{Lu}/u.test(item.value)) capitalized++;
      if (item.value.toLowerCase() !== key.toLowerCase()) differs = true;
    }
    return differs && capitalized >= node.properties.length * 0.8;
  };

  const declarator = (node: Node, kind: string): void => {
    const id = node.id, init = unwrap(node.init);
    if (ignoreStarts.has(node.start)) ignoreRanges.push([node.start, node.end]);
    bindLibrary(id, init);
    if (id.type === 'Identifier' && init) {
      if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') {
        // `const _t = (message) => ({ id: message, message })` makes descriptors: its calls are messages.
        const body = init.body?.type === 'BlockStatement' ? (init.body.body.length === 1 && init.body.body[0].type === 'ReturnStatement' ? unwrap(init.body.body[0].argument) : undefined) : unwrap(init.body);
        if (libraryFile && body?.type === 'ObjectExpression' && descriptor(body)) libraryNames.set(id.name, 'call');
        functionNode(init, id.name);
        return;
      }
      const source = init.type === 'AwaitExpression' ? unwrap(init.argument) : init;
      const name = source?.type === 'CallExpression' ? calleeName(source.callee) : undefined;
      if (name) {
        // `useT()` and `useTranslations("Settings")` make different translators.
        declare(id.name, source!.arguments.length ? `${name}(…)` : name);
        if (/(?:^|\.)(?:use|get)Messages$/.test(name)) { messageNames.add(id.name); confirmed.add(id.name); visit(init); return; }
      }
      const via = localized(init);
      if (via !== undefined) { localizedVars.set(id.name, via); if (init.type !== 'CallExpression') visit(init); return; }
      if (kind === 'const' && /^(?:Literal|TemplateLiteral|ObjectExpression|ArrayExpression|ConditionalExpression)$/.test(init.type)) constDefs.set(id.name, constDefs.has(id.name) ? null : init);
      visit(init);
      return;
    }
    if (id.type === 'ObjectPattern' && init) {
      const source = init.type === 'AwaitExpression' ? unwrap(init.argument) : init;
      const name = source?.type === 'CallExpression' ? calleeName(source.callee) : undefined;
      for (const property of id.properties) {
        if (property.type !== 'Property') continue;
        const key = propertyName(property.key, property.computed);
        const local = unwrap(property.value)!;
        const localName = local.type === 'Identifier' ? local.name : local.type === 'AssignmentPattern' && local.left.type === 'Identifier' ? local.left.name : undefined;
        if (!localName || key === undefined) continue;
        if (name) declare(localName, `${name}${source!.arguments.length ? '(…)' : ''}#${key}`);
        if (key === 'messages' || key === 'm') { messageNames.add(localName); if (name) confirmed.add(localName); }
      }
      visitParam(id);
      visit(init);
      return;
    }
    visitParam(id);
    if (init) visit(init);
  };

  const visit = (node: Node | null | undefined): void => {
    if (!node || typeof node.type !== 'string') return;
    const type = node.type;
    if (type.charCodeAt(0) === 84 && type.charCodeAt(1) === 83 && !valueTsTypes.has(type)) return;
    switch (type) {
      case 'ImportDeclaration': {
        const source = String(node.source.value);
        // The JavaScript-shaped tree has no importKind: `import type` is read from the source.
        const typeOnly = node.importKind === 'type' || typeImport.test(code.slice(node.start, node.start + 40));
        facts.imports.push([source, node.start, node.end, node.specifiers.find((specifier: Node) => specifier.type === 'ImportSpecifier')?.start ?? -1, typeOnly]);
        for (const specifier of node.specifiers) {
          const imported = specifier.type === 'ImportSpecifier' ? propertyName(specifier.imported) : specifier.type === 'ImportDefaultSpecifier' ? 'default' : '*';
          declare(specifier.local.name, `import:${source}#${imported}`);
          // Only conventional names: a local messages.ts may export anything (email templates, helpers).
          if (/(?:^|\/)messages(?:\.d)?(?:\.[cm]?[jt]s)?$/.test(source) && !typeOnly && (specifier.type === 'ImportNamespaceSpecifier' || /^(?:m|msg|msgs|messages)$/.test(specifier.local.name))) messageNames.add(specifier.local.name);
        }
        return;
      }
      case 'ExportAllDeclaration': return;
      case 'ExportNamedDeclaration': if (node.source) return; break;
      case 'JSXElement': element(node); return;
      case 'JSXFragment': children(node.children); return;
      case 'CallExpression': call(node); return;
      case 'NewExpression': {
        const name = calleeName(node.callee);
        visit(node.callee);
        node.arguments.forEach((arg: Node, i: number) => name ? value(arg, callSink(`new ${name}`, i)) : visit(arg));
        return;
      }
      case 'ObjectExpression': object(node); return;
      case 'TaggedTemplateExpression': if (libraryCall(node.tag)) facts.localized++; break;
      // `locale === "sv" ? "Spara" : "Save"` is UI text wherever it stands.
      case 'ConditionalExpression': if (inline(node, inlineSink)) return; break;
      case 'VariableDeclaration': for (const declaration of node.declarations) declarator(declaration, node.kind); return;
      case 'FunctionDeclaration': functionNode(node, node.id?.name); return;
      case 'FunctionExpression': functionNode(node, undefined, node.id?.name); return;
      case 'ArrowFunctionExpression': functionNode(node); return;
      case 'ReturnStatement':
        if (node.argument) {
          if (ignoreStarts.has(node.start)) ignoreRanges.push([node.start, node.end]);
          returns?.push(unwrap(node.argument)!);
          value(node.argument, returnSink, functionGroup);
        }
        return;
      case 'AssignmentExpression': {
        const target = unwrap(node.left)!;
        const name = target.type === 'MemberExpression' && !target.computed ? propertyName(target.property) : undefined;
        if (name && node.operator === '=') {
          const full = calleeName(target);
          const base: 0 | 1 | 2 = full === 'document.title' ? 2 : textAssignment.test(name) ? 1 : 0;
          visit(target);
          value(node.right, { key: `set:${name}`, where: `${full ?? name} =`, kind: 'assignment', base, position: base ? 'text' : 'code', wrap: 'expression' });
          return;
        }
        break;
      }
      case 'ExpressionStatement':
      case 'IfStatement':
      case 'VariableDeclarator':
        if (ignoreStarts.has(node.start)) ignoreRanges.push([node.start, node.end]);
        break;
    }
    const keys = visitorKeys[type];
    if (!keys) return;
    for (const key of keys) {
      const child = node[key];
      if (Array.isArray(child)) { for (const item of child) if (item) visit(item); }
      else if (child && typeof child === 'object') visit(child);
    }
  };

  /** Names an i18n library import binds. Imports are hoisted, so they are read before any statement. */
  const libraryImport = (node: Node): void => {
    const source = String(node.source.value);
    const library = libraryOf(source);
    if (!library || node.importKind === 'type' || typeImport.test(code.slice(node.start, node.start + 40))) return;
    libraryFile = true;
    const exports = libraryExports[library]!;
    for (const specifier of node.specifiers) {
      const imported = specifier.type === 'ImportSpecifier' ? propertyName(specifier.imported) : specifier.type === 'ImportDefaultSpecifier' ? 'default' : undefined;
      if (imported !== undefined && specifier.importKind !== 'type' && Object.hasOwn(exports, imported)) libraryNames.set(specifier.local.name, exports[imported]!);
    }
  };

  const program = (node: Node): void => {
    for (const statement of node.body) if (statement.type === 'ImportDeclaration') libraryImport(statement);
    for (const statement of node.body) {
      if (ignoreStarts.has(statement.start)) ignoreRanges.push([statement.start, statement.end]);
      visit(statement);
    }
  };

  /** Strings a constant holds at `path`, where `*` means any element or value. */
  const stringsAt = (node: Node | undefined, path: readonly string[], out: Node[]): void => {
    node = unwrap(node);
    if (!node) return;
    if (!path.length) {
      if (node.type === 'Literal' && typeof node.value === 'string' || node.type === 'TemplateLiteral') out.push(node);
      else if (node.type === 'ConditionalExpression') {
        if (branchLocales(node.test) && branchText(node.consequent) && branchText(node.alternate)) out.push(node);
        else { stringsAt(node.consequent, path, out); stringsAt(node.alternate, path, out); }
      }
      return;
    }
    const [head, ...rest] = path;
    if (node.type === 'ArrayExpression') { if (head === '*' || /^\d+$/.test(head!)) for (const element of node.elements) if (element && element.type !== 'SpreadElement') stringsAt(element, rest, out); return; }
    if (node.type === 'ObjectExpression') {
      for (const property of node.properties) {
        if (property.type !== 'Property' || property.kind !== 'init') continue;
        const key = propertyName(property.key, property.computed);
        if (head === '*' || key === head) stringsAt(property.value, rest, out);
      }
    }
  };

  const finish = (): void => {
    // Flow: constants and helpers that a text position reads.
    for (const use of uses) {
      const definition = constDefs.get(use.ref.name);
      if (!definition || use.sink.key === 'return' && !use.sink.base) continue;
      const found: Node[] = [];
      stringsAt(definition, use.ref.path, found);
      for (const node of found) via(node, use.sink, `const ${use.ref.name}`, use.group);
    }
    for (const use of callUses) {
      const found = functionReturns.get(use.ref.name);
      if (!found || use.sink.key === 'return') continue;
      for (const node of found) valueWithVia(node, { ...use.sink, via: `${use.ref.name}()` }, use.group);
    }
    const local = (group?: Group): boolean => !!group && (group.localized || !!group.vias?.some(name => translatorNames.test(name) || facts.translators[name] !== undefined));
    const sorted = [...candidates.values()].sort((a, b) => a.start - b.start);
    // Line starts once per file; candidates arrive sorted, so one forward pass places them.
    let line = 1, lineStart = 0, next = code.indexOf('\n');
    for (const item of sorted) {
      while (next !== -1 && next < item.start) { line++; lineStart = next + 1; next = code.indexOf('\n', lineStart); }
      const { group, ...rest } = item;
      const evidence = local(group);
      facts.candidates.push({ ...rest, line, column: item.start - lineStart + 1, local: rest.local || evidence && !group!.weak, ...(evidence && group!.weak ? { siblings: true } : {}) });
    }
    facts.messages = [...confirmed];
  };

  /** Record a constant's string as text, through the position that reads it. */
  const via = (node: Node, sink: Sink, through: string, group?: Group): void => {
    const before = candidates.get(`${node.start}:${node.end}`);
    if (node.type === 'ConditionalExpression') {
      inline(node, sink, group);
      const key = `${node.start}:${node.end}`, recorded = candidates.get(key);
      if (recorded) candidates.set(key, { ...recorded, via: through });
      return;
    }
    const parts: Array<string | Node> = [];
    if (node.type === 'Literal') parts.push(node.value);
    else template(node, parts);
    const composed = compose(parts);
    if (noise(composed.letters, sink.position)) return;
    record({ start: node.start, end: node.end, text: composed.text, kind: sink.kind, sink: sink.key, ...(sink.extra ? { family: sink.extra } : {}), where: sink.where, base: sink.base, local: false, scope: before?.scope ?? 0, wrap: 'expression', via: through, ...(composed.args.length ? { args: composed.args } : {}), ...(group ? { group } : {}) });
  };

  // Calls through a helper keep the helper's name for the report.
  const plainValue = value;
  const valueWithVia = (input: Node, sink: Sink & { via?: string }, group?: Group): void => {
    if (!sink.via) { plainValue(input, sink, group); return; }
    const node = unwrap(input);
    if (!node) return;
    if (node.type === 'Literal' && typeof node.value === 'string' || node.type === 'TemplateLiteral') { via(node, sink, sink.via, group); return; }
    if (node.type === 'ConditionalExpression') { valueWithVia(node.consequent, sink, group); valueWithVia(node.alternate, sink, group); return; }
    if (node.type === 'LogicalExpression') { if (node.operator !== '&&') valueWithVia(node.left, sink, group); valueWithVia(node.right, sink, group); return; }
    if (node.type === 'Identifier' || node.type === 'MemberExpression') {
      // A helper that returns a constant: `return LABELS[status]`.
      const ref = resolveRef(node), definition = ref && constDefs.get(ref.name);
      if (!definition) return;
      const found: Node[] = [];
      stringsAt(definition, ref.path, found);
      for (const item of found) via(item, sink, `${sink.via} via const ${ref.name}`, group);
    }
  };

  return {
    program,
    visit,
    value: (node, sink) => valueWithVia(node, sink),
    text(text, start, end, sink) {
      const reason = noise(text, sink.position);
      if (reason) { count(reason); return; }
      record({ start, end, text: escapeIcu(text), kind: sink.kind, sink: sink.key, ...(sink.extra ? { family: sink.extra } : {}), where: sink.where, base: sink.base, local: false, scope, wrap: sink.wrap });
    },
    run,
    attributeSink: (element, name, intrinsic, type) => attributeSink(element, name, intrinsic, { type }),
    opaque(delta) { opaque += delta; },
    cover(start, end) { if (ignoreStarts.has(start)) ignoreRanges.push([start, end]); },
    enterScope,
    exitScope,
    finish,
  };
}

/** Escape literal text for an ICU message: braces, tag openers and apostrophes next to them. */
export function escapeIcu(text: string): string {
  if (!/[{}<#|']/.test(text)) return text;
  return text.replace(/'(?=[{}<#|'])/g, "''").replace(/[{}<]+/g, match => `'${match}'`);
}

// Child keys per node type. oxc-parser exports the same table; a copy keeps
// this module free of the optional dependency so it loads without it.
let visitorKeys: Record<string, readonly string[]> = {};
export function setVisitorKeys(keys: Record<string, readonly string[]>): void { visitorKeys = keys; }
