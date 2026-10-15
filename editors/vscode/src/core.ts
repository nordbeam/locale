export interface MessageOccurrence { id: string; start: number; end: number }
export type LocaleMessages = ReadonlyMap<string, ReadonlyMap<string, string>>;
export interface Token { kind: 'identifier' | 'string' | 'punctuator' | 'other'; value: string; start: number; end: number }
export interface CompletionContext { bracket: boolean; namespace: string[]; partial: string }
export interface CompletionCandidate { label: string; leaf: boolean; text?: string }
export interface MissingReport { locale: string; ids: string[] }

export const defaultMessageIdentifiers = ['m', 'messages'] as const;

const safePart = /^[A-Za-z_$][\w$]*$/;
const identifierName = /^[A-Za-z_$][\w$]*$/;
const identifierPattern = /[A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*/y;
const numberPattern = /(?:\d|\.\d)[\w.]*/y;
const expressionKeywords = new Set(['await', 'case', 'delete', 'do', 'else', 'in', 'instanceof', 'new', 'of', 'return', 'throw', 'typeof', 'void', 'yield']);
const closingPunctuators = new Set([')', ']', '}']);
const declarationKeywords = new Set(['const', 'let', 'var']);
const loaderCall = /^(?:loadLocale|load[A-Z]\w*)$/;
const segmentPattern = /\.([A-Za-z_$][\w$]*)|\[\s*(?:'([^'\\]*)'|"([^"\\]*)")\s*\]/g;
// Array, String, Map and friends share names like `map` or `set` with message IDs; fallback bindings skip them.
const builtinMembers = new Set([Object.prototype, Array.prototype, String.prototype, Number.prototype, Map.prototype, Set.prototype, Promise.prototype, Function.prototype, Date.prototype, RegExp.prototype].flatMap(proto => Object.getOwnPropertyNames(proto)));

interface Segment { value: string; start: number; end: number }

export function flattenCatalog(value: unknown, prefix = '', output = new Map<string, string>()): Map<string, string> {
  if (typeof value === 'string') { if (prefix) output.set(prefix, value); return output; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return output;
  for (const [key, child] of Object.entries(value)) flattenCatalog(child, prefix ? `${prefix}.${key}` : key, output);
  return output;
}

export function validMessageIdentifiers(value: unknown): string[] {
  const names = Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string' && identifierName.test(name)) : [];
  return names.length ? [...new Set(names)] : [...defaultMessageIdentifiers];
}

// Linear, forgiving scanner: strings and comments are skipped, regex literals are recognized by the previous token,
// and unterminated strings or regexes end at the line break so a stray apostrophe in JSX text cannot hide later calls.
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const substitutions: boolean[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (/\s/.test(char)) { index++; continue; }
    if (char === '/' && text[index + 1] === '/') { const end = text.indexOf('\n', index); index = end < 0 ? text.length : end; continue; }
    if (char === '/' && text[index + 1] === '*') { const close = text.indexOf('*/', index + 2); index = close < 0 ? text.length : close + 2; continue; }
    if (char === '"' || char === "'") {
      const literal = quoted(text, index);
      if (literal.closed) tokens.push({ kind: 'string', value: text.slice(index + 1, literal.end - 1), start: index, end: literal.end });
      else tokens.push({ kind: 'punctuator', value: char, start: index, end: index + 1 });
      index = literal.closed ? literal.end : index + 1; continue;
    }
    if (char === '`') {
      const chunk = templateChunk(text, index + 1);
      if (chunk.interpolated) substitutions.push(true);
      else tokens.push({ kind: 'string', value: text.slice(index + 1, chunk.closed ? chunk.end - 1 : chunk.end), start: index, end: chunk.end });
      index = chunk.end; continue;
    }
    if (char === '}' && substitutions.pop()) {
      const chunk = templateChunk(text, index + 1);
      if (chunk.interpolated) substitutions.push(true);
      index = chunk.end; continue;
    }
    if (char === '/' && regexAllowed(tokens.at(-1), index)) {
      const end = regexEnd(text, index);
      if (end < 0) tokens.push({ kind: 'punctuator', value: char, start: index, end: index + 1 });
      else tokens.push({ kind: 'other', value: '/', start: index, end });
      index = end < 0 ? index + 1 : end; continue;
    }
    const word = matchAt(identifierPattern, text, index);
    if (word) { tokens.push({ kind: 'identifier', value: word, start: index, end: index + word.length }); index += word.length; continue; }
    const number = matchAt(numberPattern, text, index);
    if (number) { tokens.push({ kind: 'other', value: number, start: index, end: index + number.length }); index += number.length; continue; }
    if (char === '{') substitutions.push(false);
    const length = punctuatorLength(text, index);
    tokens.push({ kind: 'punctuator', value: text.slice(index, index + length), start: index, end: index + length });
    index += length;
  }
  return tokens;
}

export function findMessageOccurrences(text: string, identifiers: readonly string[] = defaultMessageIdentifiers): MessageOccurrence[] {
  const tokens = tokenize(text);
  const bindings = findMessageBindings(tokens);
  const fallback = new Set(identifiers);
  const found: MessageOccurrence[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (!isIdentifier(token) || isPunctuator(tokens[index - 1], '.') || isPunctuator(tokens[index - 1], '?.')) continue;
    const detected = bindings.has(token.value);
    if (!detected && !fallback.has(token.value)) continue;
    const segments = accessChain(tokens, index + 1);
    if (!segments || segments.some(segment => !segment.value)) continue;
    if (!detected && builtinMembers.has(segments[0]!.value)) continue;
    found.push({ id: segments.map(segment => segment.value).join('.'), start: segments[0]!.start, end: segments.at(-1)!.end });
  }
  return found;
}

// Bindings that hold a Nordbeam messages object: destructured `messages` from a loader or useI18n, or a useMessages result.
export function findMessageBindings(tokens: Token[]): Set<string> {
  const bindings = new Set<string>();
  for (let index = 0; index < tokens.length; index++) {
    if (!isIdentifier(tokens[index]) || !declarationKeywords.has(tokens[index]!.value)) continue;
    const first = index + 1;
    if (isPunctuator(tokens[first], '{')) {
      const close = closingBrace(tokens, first);
      const alias = close < 0 ? undefined : messagesAlias(tokens, first + 1, close);
      const equals = close < 0 ? -1 : assignmentAfter(tokens, close + 1);
      const callee = equals < 0 ? undefined : calleeName(tokens, equals + 1);
      if (alias && callee && (loaderCall.test(callee) || callee === 'useI18n')) bindings.add(alias);
    } else if (isIdentifier(tokens[first])) {
      const equals = assignmentAfter(tokens, first + 1);
      if (equals >= 0 && calleeName(tokens, equals + 1) === 'useMessages') bindings.add(tokens[first]!.value);
    }
  }
  return bindings;
}

export function accessFor(id: string, root = 'm'): string {
  const parts = id.split('.');
  return parts.every(part => safePart.test(part) && !['then', 'default', '__proto__'].includes(part))
    ? `${root}.${parts.join('.')}` : `${root}[${JSON.stringify(id)}]`;
}

// Context for completing a message ID from the text before the cursor on the current line.
export function completionContext(linePrefix: string, identifiers: readonly string[] = defaultMessageIdentifiers): CompletionContext | undefined {
  const names = identifiers.map(name => name.replace(/\$/g, '\\$')).join('|');
  const chain = String.raw`((?:\??\.[A-Za-z_$][\w$]*|\[\s*(?:'[^'\\]*'|"[^"\\]*")\s*\])*)`;
  const dot = new RegExp(String.raw`(?:^|[^\w$.])(?:${names})${chain}\??\.([\w$]*)$`);
  const bracket = new RegExp(String.raw`(?:^|[^\w$.])(?:${names})${chain}\[\s*(['"])([^'"\\]*)$`);
  const dotted = dot.exec(linePrefix);
  if (dotted) return { bracket: false, namespace: segmentsOf(dotted[1]!), partial: dotted[2]! };
  const bracketed = bracket.exec(linePrefix);
  if (bracketed) return { bracket: true, namespace: segmentsOf(bracketed[1]!), partial: bracketed[3]! };
  return undefined;
}

// Dot completion offers the next segment (leaf or namespace); bracket completion offers the rest of the ID.
export function messageCompletions(base: ReadonlyMap<string, string>, context: CompletionContext): CompletionCandidate[] {
  const prefix = context.namespace.map(part => `${part}.`).join('');
  const candidates = new Map<string, CompletionCandidate>();
  for (const [id, text] of base) {
    if (!id.startsWith(prefix)) continue;
    const rest = id.slice(prefix.length);
    if (context.bracket) { candidates.set(rest, { label: rest, leaf: true, text }); continue; }
    const label = rest.split('.')[0]!;
    const leaf = label === rest;
    if (!candidates.get(label)?.leaf) candidates.set(label, { label, leaf, text: leaf ? text : undefined });
  }
  return [...candidates.values()].sort((left, right) => left.label.localeCompare(right.label));
}

export function localeTable(id: string, catalogs: LocaleMessages): Array<{ locale: string; text?: string }> {
  return [...catalogs].sort(([left], [right]) => left.localeCompare(right)).map(([locale, messages]) => ({ locale, text: messages.get(id) }));
}

export function missingLocales(id: string, catalogs: LocaleMessages): string[] {
  return localeTable(id, catalogs).filter(row => row.text === undefined).map(row => row.locale);
}

export function missingReport(catalogs: LocaleMessages, baseLocale: string): MissingReport[] {
  const base = catalogs.get(baseLocale);
  if (!base) return [];
  return [...catalogs]
    .filter(([locale]) => locale !== baseLocale)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([locale, messages]) => ({ locale, ids: [...base.keys()].filter(id => !messages.has(id)).sort() }));
}

// Offsets of the quoted key that ends a dotted ID in a JSON catalog; nested keys are matched in order.
export function jsonKeyRange(json: string, id: string): { start: number; end: number } | undefined {
  let from = 0, start = -1, end = -1;
  for (const part of id.split('.')) {
    const quotedPart = JSON.stringify(part);
    const key = new RegExp(`${quotedPart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`, 'g');
    key.lastIndex = from;
    const match = key.exec(json);
    if (!match) return undefined;
    start = match.index; end = start + quotedPart.length; from = start + match[0].length;
  }
  return { start, end };
}

function isIdentifier(token: Token | undefined, value?: string): boolean {
  return token?.kind === 'identifier' && (value === undefined || token.value === value);
}

function isPunctuator(token: Token | undefined, value: string): boolean {
  return token?.kind === 'punctuator' && token.value === value;
}

function matchAt(pattern: RegExp, text: string, index: number): string | undefined {
  pattern.lastIndex = index;
  return pattern.exec(text)?.[0];
}

function quoted(text: string, start: number): { end: number; closed: boolean } {
  const quote = text[start];
  for (let index = start + 1; index < text.length; index++) {
    const char = text[index];
    if (char === '\\') index++;
    else if (char === quote) return { end: index + 1, closed: true };
    else if (char === '\n') return { end: index, closed: false };
  }
  return { end: text.length, closed: false };
}

function templateChunk(text: string, start: number): { end: number; interpolated: boolean; closed: boolean } {
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (char === '\\') index++;
    else if (char === '`') return { end: index + 1, interpolated: false, closed: true };
    else if (char === '$' && text[index + 1] === '{') return { end: index + 2, interpolated: true, closed: false };
  }
  return { end: text.length, interpolated: false, closed: false };
}

function regexAllowed(previous: Token | undefined, index: number): boolean {
  if (!previous) return true;
  if (previous.kind === 'identifier') return expressionKeywords.has(previous.value);
  if (previous.kind === 'punctuator') return previous.value === '<' ? previous.end !== index : !closingPunctuators.has(previous.value);
  return false;
}

// Returns -1 for an unterminated regex, which is then read as a plain slash.
function regexEnd(text: string, start: number): number {
  let inClass = false;
  for (let index = start + 1; index < text.length; index++) {
    const char = text[index];
    if (char === '\\') index++;
    else if (char === '\n') return -1;
    else if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    else if (char === '/' && !inClass) {
      index++;
      while (index < text.length && /[A-Za-z]/.test(text[index]!)) index++;
      return index;
    }
  }
  return -1;
}

function punctuatorLength(text: string, index: number): number {
  const char = text[index];
  if (char === '.' && text[index + 1] === '.' && text[index + 2] === '.') return 3;
  if (char === '?' && text[index + 1] === '.' && !/\d/.test(text[index + 2] ?? '')) return 2;
  if (char === '=' && text[index + 1] === '=') return text[index + 2] === '=' ? 3 : 2;
  if (char === '=' && text[index + 1] === '>') return 2;
  return 1;
}

function accessChain(tokens: Token[], at: number): Segment[] | undefined {
  const segments: Segment[] = [];
  let index = at;
  for (;;) {
    const token = tokens[index];
    if ((isPunctuator(token, '.') || isPunctuator(token, '?.')) && isIdentifier(tokens[index + 1])) {
      const name = tokens[index + 1]!;
      segments.push({ value: name.value, start: name.start, end: name.end });
      index += 2;
    } else if (isPunctuator(token, '[') && tokens[index + 1]?.kind === 'string' && isPunctuator(tokens[index + 2], ']')) {
      const literal = tokens[index + 1]!;
      segments.push({ value: literal.value, start: literal.start + 1, end: literal.end - 1 });
      index += 3;
    } else break;
  }
  return segments.length && isPunctuator(tokens[index], '(') ? segments : undefined;
}

function calleeName(tokens: Token[], at: number): string | undefined {
  let index = isIdentifier(tokens[at], 'await') ? at + 1 : at;
  if (!isIdentifier(tokens[index])) return undefined;
  let name = tokens[index]!.value;
  index++;
  while ((isPunctuator(tokens[index], '.') || isPunctuator(tokens[index], '?.')) && isIdentifier(tokens[index + 1])) {
    name = tokens[index + 1]!.value;
    index += 2;
  }
  return isPunctuator(tokens[index], '(') ? name : undefined;
}

function assignmentAfter(tokens: Token[], at: number): number {
  if (isPunctuator(tokens[at], '=')) return at;
  if (!isPunctuator(tokens[at], ':')) return -1;
  for (let index = at + 1; index < Math.min(tokens.length, at + 40); index++) {
    if (isPunctuator(tokens[index], '=')) return index;
    if (isPunctuator(tokens[index], ';')) break;
  }
  return -1;
}

function closingBrace(tokens: Token[], open: number): number {
  let depth = 0;
  for (let index = open; index < Math.min(tokens.length, open + 200); index++) {
    if (isPunctuator(tokens[index], '{')) depth++;
    else if (isPunctuator(tokens[index], '}') && --depth === 0) return index;
  }
  return -1;
}

// Finds `messages` or `messages: alias` as a top-level entry of an object pattern spanning [start, end).
function messagesAlias(tokens: Token[], start: number, end: number): string | undefined {
  for (let index = start; index < end; index++) {
    const entryStart = index === start || isPunctuator(tokens[index - 1], ',');
    if (!entryStart || !isIdentifier(tokens[index], 'messages')) continue;
    if (isPunctuator(tokens[index + 1], ':')) return isIdentifier(tokens[index + 2]) ? tokens[index + 2]!.value : undefined;
    return 'messages';
  }
  return undefined;
}

function segmentsOf(chain: string): string[] {
  return [...chain.matchAll(segmentPattern)].map(match => match[1] ?? match[2] ?? match[3] ?? '');
}
