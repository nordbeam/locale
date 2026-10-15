import { CompileError } from './diagnostics.js';
import type { Diagnostic } from './diagnostics.js';
import { findDuplicateKeys } from './catalog-text.js';

export interface CatalogSource { file: string; text: string }
interface Entry { key: number; value: number; end: number; string: boolean }

/** Scan only on failure, after JSON.parse has validated the source. */
function findEntries(text: string, targets: Set<string>): Map<string, Entry> {
  const tokens = /\s*("(?:[^"\\]|\\.)*"|true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}\[\]:,])/y;
  let position = 0;
  const found = new Map<string, Entry>();
  function next(): { token: string; start: number; end: number } {
    tokens.lastIndex = position;
    const match = tokens.exec(text);
    if (!match) throw new Error('Expected validated JSON while locating a catalog diagnostic.');
    position = tokens.lastIndex;
    return { token: match[1]!, start: position - match[1]!.length, end: position };
  }
  function value(prefix?: string): { start: number; end: number; string: boolean } {
    const first = next();
    if (first.token === '{') {
      let key = next();
      if (key.token !== '}') for (;;) {
        const name = JSON.parse(key.token) as string;
        const id = prefix === undefined ? undefined : prefix ? `${prefix}.${name}` : name;
        next(); // colon
        const entry = value(id);
        if (id !== undefined && targets.has(id)) found.set(id, { key: key.start, value: entry.start, end: entry.end, string: entry.string });
        if (next().token === '}') break;
        key = next();
      }
    } else if (first.token === '[') {
      const saved = position;
      if (next().token !== ']') {
        position = saved;
        for (;;) { value(); if (next().token === ']') break; }
      }
    }
    return { start: first.start, end: position, string: first.token.startsWith('"') };
  }
  value('');
  return found;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\r') { if (text[i + 1] === '\n') i++; starts.push(i + 1); }
    else if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function filePosition(text: string, offset: number, starts?: number[]): NonNullable<Diagnostic['location']> {
  if (starts) {
    let low = 0, high = starts.length;
    while (low + 1 < high) { const mid = (low + high) >>> 1; if (starts[mid]! <= offset) low = mid; else high = mid; }
    return { line: low + 1, column: offset - starts[low]! + 1, offset };
  }
  let line = 1, start = 0;
  for (let i = 0; i < offset; i++) {
    if (text[i] === '\r') {
      if (text[i + 1] === '\n' && i + 1 < offset) i++;
      line++; start = i + 1;
    } else if (text[i] === '\n') { line++; start = i + 1; }
  }
  return { line, column: offset - start + 1, offset };
}

function frame(text: string, location: NonNullable<Diagnostic['location']>, starts?: number[]): string {
  const start = location.offset - location.column + 1;
  let end = start;
  if (starts) {
    end = starts[location.line] ?? text.length;
    if (text[end - 1] === '\n') end--;
    if (text[end - 1] === '\r') end--;
  } else while (end < text.length && text[end] !== '\r' && text[end] !== '\n') end++;
  // Keep minified catalogs readable without including the entire source file.
  let left = Math.max(start, location.offset - 60), right = Math.min(end, left + 140);
  if (left > start && text.charCodeAt(left) >= 0xdc00 && text.charCodeAt(left) <= 0xdfff) left--;
  if (right < end && text.charCodeAt(right) >= 0xdc00 && text.charCodeAt(right) <= 0xdfff) right++;
  // Editor lines use CR/LF, not ECMAScript's additional LS/PS separators.
  // Make those invisible characters visible in the frame without moving the
  // file coordinate, and expand tabs consistently before placing the caret.
  const display = (value: string) => value.replaceAll('\t', '    ').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  const prefix = left > start ? '…' : '';
  const line = prefix + display(text.slice(left, right)) + (right < end ? '…' : '');
  const caret = prefix.length + display(text.slice(left, location.offset)).length;
  const gutter = `${location.line} | `;
  return `${gutter}${line}\n${' '.repeat(gutter.length + caret)}^`;
}

function located(diagnostic: Diagnostic, source: CatalogSource, offset?: number, starts?: number[]): Diagnostic {
  if (offset === undefined) return { ...diagnostic, file: source.file };
  const location = filePosition(source.text, Math.max(0, Math.min(source.text.length, offset)), starts);
  // Editors do not count a leading BOM as a column on the first line.
  if (hasBom(source.text) && location.line === 1) location.column = Math.max(1, location.column - 1);
  return { ...diagnostic, file: source.file, location, frame: frame(source.text, location, starts) };
}

function hasBom(text: string): boolean {
  return text.charCodeAt(0) === 0xfeff;
}

/** Map a decoded UTF-16 ICU offset through the original JSON string escapes. */
function encodedOffset(text: string, start: number, offset: number): number {
  let position = start + 1;
  for (let decoded = 0; decoded < offset; decoded++) {
    position += text[position] === '\\' ? text[position + 1] === 'u' ? 6 : 2 : 1;
  }
  return position;
}

/** A single JSON scan per affected file; temporary indexes contain only requested keys. */
export function locateDiagnostics(diagnostics: readonly Diagnostic[], sources: ReadonlyMap<string, CatalogSource>): Diagnostic[] {
  const requests = new Map<string, Set<string>>();
  for (const diagnostic of diagnostics) {
    if (diagnostic.locale === undefined || diagnostic.messageId === undefined || diagnostic.file || diagnostic.code === 'MISSING_MESSAGE' || diagnostic.code === 'FALLBACK_MESSAGE') continue;
    if (!requests.has(diagnostic.locale)) requests.set(diagnostic.locale, new Set());
    requests.get(diagnostic.locale)!.add(diagnostic.messageId);
  }
  const indexes = new Map<string, { entries: Map<string, Entry>; starts: number[] }>();
  return diagnostics.map(diagnostic => {
    const source = diagnostic.locale === undefined ? undefined : sources.get(diagnostic.locale);
    if (!source || diagnostic.file) return diagnostic;
    if (diagnostic.messageId === undefined || diagnostic.code === 'MISSING_MESSAGE' || diagnostic.code === 'FALLBACK_MESSAGE') return located(diagnostic, source);
    const locale = diagnostic.locale!;
    let index = indexes.get(locale);
    if (!index) {
      index = { entries: findEntries(source.text, requests.get(locale)!), starts: lineStarts(source.text) };
      indexes.set(locale, index);
    }
    const entry = index.entries.get(diagnostic.messageId);
    if (!entry) return located(diagnostic, source);
    let offset = entry.key;
    if (entry.string && diagnostic.offset !== undefined && diagnostic.source !== undefined) {
      const decoded = JSON.parse(source.text.slice(entry.value, entry.end)) as string;
      if (decoded === diagnostic.source && diagnostic.offset >= 0 && diagnostic.offset <= decoded.length) {
        offset = encodedOffset(source.text, entry.value, diagnostic.offset);
      }
    }
    return located(diagnostic, source, offset, index.starts);
  });
}

export function locateCompileError(error: CompileError, sources: Map<string, CatalogSource>): CompileError {
  return new CompileError(locateDiagnostics(error.diagnostics, sources));
}

export function invalidJson(error: Error, locale: string, source: CatalogSource): CompileError {
  // JSON.parse error wording is engine-specific. Do not invent a position when
  // the engine provides neither an offset nor a recognizable EOF diagnostic.
  const match = /\bposition (\d+)\b/.exec(error.message);
  // The caller parses without the BOM, so its positions are one UTF-16 unit early.
  const offset = match ? Number(match[1]) + (hasBom(source.text) ? 1 : 0) : /(?:end of JSON input|Unexpected end)/i.test(error.message) ? source.text.length : undefined;
  return new CompileError([located({ code: 'INVALID_JSON', message: error.message, locale }, source, offset)]);
}

/** JSON.parse keeps only the last of repeated keys, so duplicates need their own scan. Pass the parsed catalog to skip it when possible. */
export function duplicateKeyDiagnostics(source: CatalogSource, locale: string, parsed?: unknown): Diagnostic[] {
  const duplicates = findDuplicateKeys(source.text, parsed);
  if (!duplicates.length) return [];
  const starts = lineStarts(source.text);
  return duplicates.map(duplicate => located({
    code: 'DUPLICATE_KEY', message: `Message key ${JSON.stringify(duplicate.id)} is defined more than once; only the last value would be used.`, locale, messageId: duplicate.id,
    hint: 'Keep one value per message key.',
  }, source, duplicate.start, starts));
}
