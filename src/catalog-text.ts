import type { Catalog } from './compiler.js';
import { CompileError } from './diagnostics.js';

export type CatalogTextChanges = ReadonlyMap<string, string> | Readonly<Record<string, string>>;

interface StringEntry { id: string; start: number; end: number; value: string }
/** A repeated message key. `start` is the offset of its opening quote. */
export interface CatalogDuplicate { id: string; start: number }

const tokenPattern = /\s*("(?:[^"\\]|\\.)*"|true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}\[\]:,])/y;

function parseToken(text: string, state: { position: number }): { token: string; start: number; end: number } {
  tokenPattern.lastIndex = state.position;
  const match = tokenPattern.exec(text);
  if (!match) throw new CompileError([{ code: 'INVALID_JSON', message: 'Expected a valid JSON catalog.' }]);
  state.position = tokenPattern.lastIndex;
  return { token: match[1]!, start: state.position - match[1]!.length, end: state.position };
}

/**
 * With `duplicates`, repeated keys at any depth are collected instead of thrown,
 * so the caller can report every location. JSON.parse keeps only the last value.
 */
function scanEntries(text: string, duplicates?: CatalogDuplicate[]): StringEntry[] {
  const state = { position: text.startsWith('\uFEFF') ? 1 : 0 };
  const result: StringEntry[] = [];
  const seen = new Set<string>();
  const reported = new Set<number>();
  const ancestors = new Set<object>();
  const duplicate = (id: string, start: number): void => {
    if (!duplicates) throw new CompileError([{ code: 'DUPLICATE_KEY', message: `Message key ${JSON.stringify(id)} is defined more than once.`, messageId: id }]);
    if (!reported.has(start)) { reported.add(start); duplicates.push({ id, start }); }
  };
  const value = (prefix: string, keyStart = 0): void => {
    const first = parseToken(text, state);
    if (first.token === '{') {
      const marker = {};
      if (ancestors.has(marker)) throw new Error('unreachable');
      ancestors.add(marker);
      let key = parseToken(text, state);
      const names = new Set<string>();
      if (key.token !== '}') for (;;) {
        if (!key.token.startsWith('"')) throw new CompileError([{ code: 'INVALID_JSON', message: 'Catalog object keys must be JSON strings.' }]);
        const name = JSON.parse(key.token) as string;
        if (!name) throw new CompileError([{ code: 'INVALID_KEY', message: 'Message keys must not be empty.', messageId: prefix }]);
        const id = prefix ? `${prefix}.${name}` : name;
        if (parseToken(text, state).token !== ':') throw new CompileError([{ code: 'INVALID_JSON', message: 'Expected a colon after a catalog key.', messageId: id }]);
        if (names.has(name)) duplicate(id, key.start);
        names.add(name);
        const before = result.length;
        value(id, key.start);
        if (result.length === before && !seen.has(id)) {
          // The child was a nested object. Its leaves are indexed by their full IDs.
        }
        if (parseToken(text, state).token === '}') break;
        key = parseToken(text, state);
      }
      ancestors.delete(marker);
      return;
    }
    if (first.token.startsWith('"')) {
      const id = prefix;
      if (!id) throw new CompileError([{ code: 'INVALID_CATALOG', message: 'Catalog root must be an object.' }]);
      if (seen.has(id)) { duplicate(id, keyStart); return; }
      seen.add(id); result.push({ id, start: first.start, end: first.end, value: JSON.parse(first.token) as string });
      return;
    }
    if (first.token === '[' || first.token === 'true' || first.token === 'false' || first.token === 'null' || first.token === '}' || first.token === ']') {
      throw new CompileError([{ code: 'INVALID_CATALOG', message: 'Catalog values must be strings or nested objects.', messageId: prefix }]);
    }
    throw new CompileError([{ code: 'INVALID_JSON', message: 'Catalog contains an unsupported JSON value.', messageId: prefix }]);
  };
  value('');
  const trailing = text.slice(state.position).trim();
  if (trailing) throw new CompileError([{ code: 'INVALID_JSON', message: 'Unexpected data after the JSON catalog.' }]);
  return result;
}

/** Every key token in JSON ends with `"` + optional whitespace + `:`, so this counts each key once. */
const keyTokenEnd = /"\s*:/g;

function countKeys(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  let count = 0;
  for (const key of Object.keys(value)) count += 1 + countKeys((value as Record<string, unknown>)[key]);
  return count;
}

/**
 * Locate repeated keys in JSON that already passed JSON.parse. Structural errors
 * are left to the compiler, so only duplicates found before them are returned.
 * `parsed` is the JSON.parse result: it has one key per unique name, so equal
 * counts prove there are no repeats and skip the scanner. A mismatch can also
 * come from `":` inside a string, so it falls through to the full scan.
 */
export function findDuplicateKeys(text: string, parsed?: unknown): CatalogDuplicate[] {
  if (parsed !== undefined && (text.match(keyTokenEnd)?.length ?? 0) === countKeys(parsed)) return [];
  const duplicates: CatalogDuplicate[] = [];
  try { scanEntries(text, duplicates); }
  catch (error) { if (!(error instanceof CompileError)) throw error; }
  return duplicates;
}

function entries(changes: CatalogTextChanges): Array<[string, string]> {
  const values = changes instanceof Map ? [...changes.entries()] : Object.entries(changes);
  for (const [id, value] of values) {
    if (!id) throw new TypeError('Catalog change IDs must be nonempty strings.');
    if (typeof value !== 'string') throw new TypeError(`Catalog change ${JSON.stringify(id)} must be a string.`);
  }
  return values.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}

/** Update only selected JSON string tokens, preserving all other bytes. */
export function updateCatalogText(text: string, changes: CatalogTextChanges): string {
  if (typeof text !== 'string') throw new TypeError('Catalog text must be a string.');
  let parsed: unknown;
  try { parsed = JSON.parse(text.startsWith('\uFEFF') ? text.slice(1) : text); }
  catch (error) { throw new CompileError([{ code: 'INVALID_JSON', message: (error as Error).message }]); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new CompileError([{ code: 'INVALID_CATALOG', message: 'Catalog root must be an object.' }]);
  const found = new Map(scanEntries(text).map(entry => [entry.id, entry]));
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  for (const [id, value] of entries(changes)) {
    const entry = found.get(id);
    if (!entry) throw new CompileError([{ code: 'UNKNOWN_MESSAGE', message: `Catalog does not contain message ${JSON.stringify(id)}.`, messageId: id }]);
    if (entry.value !== value) replacements.push({ start: entry.start, end: entry.end, text: JSON.stringify(value) });
  }
  let output = text;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) output = output.slice(0, replacement.start) + replacement.text + output.slice(replacement.end);
  return output;
}
