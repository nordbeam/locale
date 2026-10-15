import { checkProject, CompileError } from './compiler.js';
import type { Diagnostic } from './diagnostics.js';
import type { Catalog, Formats } from './compiler.js';

/** Internal, deliberately bounded ICU-in-PO transport, not a gettext runtime. */
export interface PoEntry {
  id: string;
  source: string;
  translation: string;
  fuzzy: boolean;
  empty: boolean;
  line: number;
}
export interface PoDocument { headers: Map<string, string>; entries: PoEntry[]; obsolete: number }

const emptyMarker = '#. nordbeam-locale:empty';
/** Markers written by earlier releases. They are still read so existing PO files import. */
const legacyEmptyMarkers: ReadonlySet<string> = new Set(['#. nordbeam-i18n:empty', '#. fasti18n:empty']);

export function poError(code: string, message: string, file?: string, line?: number, messageId?: string): never {
  throw new CompileError([{ code, message, file, messageId, ...(line ? { location: { line, column: 1, offset: 0 } } : {}) }]);
}

/** PO is UTF-8 text. Reject strings which would be changed by encoding/gettext. */
export function assertPoText(text: string, context: Partial<Diagnostic> = {}): void {
  if (/[\u0000\u0004\uD800-\uDFFF]/u.test(text)) {
    throw new CompileError([{ code: 'PO_UNREPRESENTABLE_TEXT', message: 'PO transport cannot represent NUL, EOT or unpaired UTF-16 surrogates. Use valid Unicode text without NUL/EOT.', ...context }]);
  }
}

export function quotePo(text: string): string {
  return '"' + text.replace(/[\x00-\x1f\x7f"\\]/g, char => {
    const escapes: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f', '\v': '\\v', '\x07': '\\a', '"': '\\"', '\\': '\\\\' };
    return escapes[char] ?? '\\' + char.charCodeAt(0).toString(8).padStart(3, '0');
  }) + '"';
}

function unquote(text: string, file: string | undefined, line: number): string {
  const invalid = (message: string): never => poError('INVALID_PO', message, file, line);
  if (!text.startsWith('"')) invalid('Expected a double-quoted PO string.');
  let result = '';
  for (let i = 1; i < text.length; i++) {
    const char = text[i]!;
    if (char === '"') {
      if (text.slice(i + 1).trim()) invalid('Unexpected text after the closing quote.');
      assertPoText(result, { file, location: { line, column: 1, offset: 0 } });
      return result;
    }
    if (char === '\\') {
      const escape = text[++i];
      if (escape === undefined) invalid('Unterminated PO string.');
      const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', a: '\x07', '"': '"', '\\': '\\' };
      if (Object.hasOwn(escapes, escape!)) result += escapes[escape!]!;
      else if (/[0-7x]/.test(escape!)) {
        const digits = escape === 'x' ? text.slice(i + 1).match(/^[0-9a-fA-F]+/)?.[0] : text.slice(i).match(/^[0-7]{1,3}/)?.[0];
        if (!digits) invalid('Invalid numeric PO escape.');
        const value = parseInt(digits!, escape === 'x' ? 16 : 8);
        if (value > 127) invalid('Use literal UTF-8 characters for non-ASCII text instead of numeric byte escapes.');
        result += String.fromCharCode(value);
        i += digits!.length - (escape === 'x' ? 0 : 1);
      } else invalid(`Unsupported PO escape \\${escape}. Use PO C-style escapes, not JSON Unicode escapes.`);
    } else {
      if (char === '\r') invalid('Escape carriage returns inside PO strings as \\r.');
      result += char;
    }
  }
  return invalid('Unterminated PO string.');
}

/** Strict single-string entries; gettext plural arrays have different semantics. */
export function parsePo(text: string, file?: string): PoDocument {
  try { return readPo(text, file); }
  catch (error) {
    if (!(error instanceof CompileError)) throw error;
    const offsets = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') offsets.push(i + 1);
    throw new CompileError(error.diagnostics.map(d => d.location ? { ...d, location: { ...d.location, offset: offsets[d.location.line - 1]! } } : d));
  }
}

function readPo(text: string, file?: string): PoDocument {
  assertPoText(text, { file });
  const result: PoDocument = { headers: new Map(), entries: [], obsolete: 0 };
  type Field = 'msgctxt' | 'msgid' | 'msgstr';
  let fields: Partial<Record<Field, string>> = {}, current: Field | undefined;
  let fuzzy = false, empty = false, start = 1, header = false;
  const seen = new Set<string>();
  const finish = (): void => {
    if (!current) return;
    if (fields.msgid === undefined || fields.msgstr === undefined) poError('INVALID_PO', 'Each PO entry requires msgid and one msgstr.', file, start, fields.msgctxt);
    if (fields.msgctxt === undefined && fields.msgid === '') {
      if (header || result.entries.length) poError('INVALID_PO', 'The PO header must appear once, before message entries.', file, start);
      header = true;
      if (fuzzy) poError('PO_FUZZY_HEADER', 'Review and remove the fuzzy flag on the PO header before importing.', file, start);
      for (const line of fields.msgstr.split('\n')) {
        if (!line.trim()) continue;
        const colon = line.indexOf(':');
        if (colon < 1) poError('INVALID_PO', 'Expected a Name: value header field.', file, start);
        const name = line.slice(0, colon).trim().toLowerCase();
        if (result.headers.has(name)) poError('INVALID_PO', `Duplicate PO header ${JSON.stringify(name)}.`, file, start);
        result.headers.set(name, line.slice(colon + 1).trim());
      }
    } else {
      const id = fields.msgctxt;
      if (!id) poError('PO_MISSING_CONTEXT', 'Each translation needs its stable message ID in msgctxt. Export a PO file with Nordbeam Locale export first.', file, start);
      if (seen.has(id)) poError('PO_DUPLICATE_ID', `Duplicate message ID ${JSON.stringify(id)}.`, file, start, id);
      seen.add(id);
      result.entries.push({ id, source: fields.msgid, translation: fields.msgstr, fuzzy, empty, line: start });
    }
    fields = {}; current = undefined; fuzzy = false; empty = false;
  };
  for (const [index, raw] of text.replace(/^\uFEFF/, '').split('\n').entries()) {
    const line = index + 1, value = raw.replace(/\r$/, '').trim();
    if (!value) { finish(); continue; }
    if (value.startsWith('#')) {
      finish();
      if (/^#~\s*msgid\s/.test(value)) result.obsolete++;
      if (value.startsWith('#~')) { fuzzy = false; empty = false; continue; }
      if (value.startsWith('#,')) fuzzy ||= value.slice(2).split(',').some(flag => flag.trim() === 'fuzzy');
      if (value === emptyMarker || legacyEmptyMarkers.has(value)) empty = true;
      continue;
    }
    if (value.startsWith('"')) {
      if (!current) poError('INVALID_PO', 'A continuation string must follow msgctxt, msgid or msgstr.', file, line);
      fields[current] += unquote(value, file, line);
      continue;
    }
    if (/^(msgid_plural|msgstr\[)/.test(value)) poError('PO_GETTEXT_PLURAL', 'Keep ICU plurals inside a single msgid/msgstr. Gettext plural arrays cannot be imported.', file, line, fields.msgctxt);
    // Lines end only at \n. U+2028 and U+2029 are literal text inside PO strings.
    const match = /^(msgctxt|msgid|msgstr)[ \t]+([^]*)$/.exec(value);
    if (!match) poError('INVALID_PO', 'Expected msgctxt, msgid, msgstr, a quoted continuation or a comment.', file, line);
    const field = match[1] as Field;
    if ((field === 'msgctxt' || field === 'msgid') && current === 'msgstr') finish();
    if (fields[field] !== undefined || (field === 'msgctxt' && current) || (field === 'msgid' && current && current !== 'msgctxt') || (field === 'msgstr' && current !== 'msgid')) {
      poError('INVALID_PO', 'Expected one msgctxt, then msgid, then one msgstr per entry.', file, line, fields.msgctxt);
    }
    if (!current) start = line;
    current = field;
    fields[field] = unquote(match[2]!, file, line);
  }
  finish();
  if (!header) poError('PO_MISSING_HEADER', 'A PO header with Language and UTF-8 Content-Type is required.', file);
  return result;
}

export interface SerializePoOptions {
  readonly baseLocale: string;
  readonly locale: string;
  readonly catalogs: Readonly<Record<string, Catalog>>;
  readonly missing?: 'fallback' | 'error';
  readonly formats?: Formats;
  readonly timeZone?: string;
}

export interface SerializePoResult {
  readonly po: string;
  readonly locale: string;
  readonly messageCount: number;
  readonly translatedCount: number;
}

export interface MergePoOptions extends SerializePoOptions {
  readonly po: string | PoDocument;
}

export interface MergePoResult {
  readonly locale: string;
  readonly catalog: Catalog;
  readonly catalogs: Record<string, Catalog>;
  readonly added: string[];
  readonly updated: string[];
  readonly unchanged: number;
  readonly skipped: { fuzzy: number; untranslated: number; obsolete: number };
  readonly warnings: Diagnostic[];
}

interface PureLeaf { text: string; path: string[] }

function pureLocaleName(locale: string): void {
  try {
    if (!locale || Intl.getCanonicalLocales(locale)[0] !== locale) throw new Error();
  } catch { poError('INVALID_LOCALE', `Use a canonical BCP 47 locale, such as en, fr or pt-BR, instead of ${JSON.stringify(locale)}.`); }
}

function pureIndexCatalog(catalog: Catalog, locale: string): Map<string, PureLeaf> {
  const index = new Map<string, PureLeaf>();
  const ancestors = new Set<object>();
  const visit = (value: unknown, path: string[]): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CompileError([{ code: 'INVALID_CATALOG', message: 'Expected an object containing strings or nested catalogs.', locale, messageId: path.join('.') }]);
    if (ancestors.has(value)) throw new CompileError([{ code: 'INVALID_CATALOG', message: 'Catalog contains a circular reference.', locale, messageId: path.join('.') }]);
    ancestors.add(value);
    for (const [key, entry] of Object.entries(value)) {
      const next = [...path, key], id = next.join('.');
      if (!key) throw new CompileError([{ code: 'INVALID_KEY', message: 'Message keys must not be empty.', locale, messageId: id }]);
      if (typeof entry === 'string') {
        if (index.has(id)) throw new CompileError([{ code: 'DUPLICATE_KEY', message: `Nested and flat keys both resolve to ${JSON.stringify(id)}.`, locale, messageId: id }]);
        index.set(id, { text: entry, path: next });
      } else visit(entry, next);
    }
    ancestors.delete(value);
  };
  visit(catalog, []);
  return index;
}

function cloneCatalog(catalog: Catalog, locale = 'catalog', ancestors = new Set<object>(), path: readonly string[] = []): Catalog {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    throw new CompileError([{ code: 'INVALID_CATALOG', message: 'Expected an object containing strings or nested catalogs.', locale, messageId: path.join('.') }]);
  }
  if (ancestors.has(catalog)) {
    throw new CompileError([{ code: 'INVALID_CATALOG', message: 'Catalog contains a circular reference.', locale, messageId: path.join('.') }]);
  }
  ancestors.add(catalog);
  const result = Object.create(null) as Catalog;
  for (const [key, value] of Object.entries(catalog)) Object.defineProperty(result, key, {
    value: typeof value === 'string' ? value : cloneCatalog(value as Catalog, locale, ancestors, [...path, key]), enumerable: true, configurable: true, writable: true,
  });
  ancestors.delete(catalog);
  return result;
}

function pureSetMessage(catalog: Catalog, id: string, preferredPath: readonly string[], text: string): void {
  let path = [...preferredPath];
  let node = catalog;
  let usable = true;
  for (const key of path.slice(0, -1)) {
    if (!Object.hasOwn(node, key)) break;
    if (typeof node[key] === 'string') { usable = false; break; }
    node = node[key] as Catalog;
  }
  if (!usable) path = [id];
  node = catalog;
  for (const key of path.slice(0, -1)) {
    if (!Object.hasOwn(node, key)) Object.defineProperty(node, key, { value: Object.create(null), enumerable: true, configurable: true, writable: true });
    if (typeof node[key] === 'string') poError('CATALOG_LAYOUT_CONFLICT', `Adding ${JSON.stringify(id)} would replace a nested catalog.`, undefined, undefined, id);
    node = node[key] as Catalog;
  }
  const key = path.at(-1)!;
  if (Object.hasOwn(node, key) && typeof node[key] !== 'string') poError('CATALOG_LAYOUT_CONFLICT', `Adding ${JSON.stringify(id)} would replace a nested catalog.`, undefined, undefined, id);
  Object.defineProperty(node, key, { value: text, enumerable: true, configurable: true, writable: true });
}

function pureCompilerOptions(options: SerializePoOptions, catalogs: Record<string, Catalog>): Parameters<typeof checkProject>[0] {
  return { baseLocale: options.baseLocale, catalogs, missing: options.missing ?? 'fallback', formats: options.formats, timeZone: options.timeZone };
}

/** Serialize catalogs already held in memory; no filesystem access is performed. */
export function serializePo(options: SerializePoOptions): SerializePoResult {
  pureLocaleName(options.baseLocale); pureLocaleName(options.locale);
  if (options.baseLocale === options.locale) poError('PO_BASE_LOCALE', 'Choose a target locale different from the base locale. Edit source messages in the base JSON catalog.');
  const base = options.catalogs[options.baseLocale];
  if (!base) poError('BASE_LOCALE_MISSING', `No catalog for base locale ${JSON.stringify(options.baseLocale)}.`);
  const checked = checkProject(pureCompilerOptions(options, { ...options.catalogs }));
  if (!checked.ok) throw new CompileError(checked.errors);
  const baseIndex = pureIndexCatalog(base!, options.baseLocale);
  const targetIndex = pureIndexCatalog(options.catalogs[options.locale] ?? Object.create(null), options.locale);
  const lines = [
    '# ICU MessageFormat: translate text; retain argument and rich-text slot names.',
    '# msgctxt is a stable message ID. Do not change it.',
    '# An empty msgstr is untranslated. Add the nordbeam-locale:empty marker for intentional empty text.',
    'msgid ""', 'msgstr ""',
    ...[`Language: ${options.locale}\n`, 'MIME-Version: 1.0\n', 'Content-Type: text/plain; charset=UTF-8\n', 'Content-Transfer-Encoding: 8bit\n', 'X-Nordbeam-Locale-Format: 1\n', `X-Source-Language: ${options.baseLocale}\n`].map(quotePo),
  ];
  for (const [id, source] of [...baseIndex].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const translation = targetIndex.get(id);
    for (const text of [id, source.text, translation?.text ?? '']) assertPoText(text, { locale: options.locale, messageId: id });
    lines.push('');
    if (translation?.text === '') lines.push('#. nordbeam-locale:empty');
    lines.push(`msgctxt ${quotePo(id)}`, `msgid ${quotePo(source.text)}`, `msgstr ${quotePo(translation?.text ?? '')}`);
  }
  return { po: lines.join('\n') + '\n', locale: options.locale, messageCount: baseIndex.size, translatedCount: targetIndex.size };
}

/** Merge a reviewed PO document into cloned in-memory catalogs and validate the complete result. */
export function mergePo(options: MergePoOptions): MergePoResult {
  pureLocaleName(options.baseLocale); pureLocaleName(options.locale);
  if (options.baseLocale === options.locale) poError('PO_BASE_LOCALE', 'Choose a target locale different from the base locale. Edit source messages in the base JSON catalog.');
  const po = typeof options.po === 'string' ? parsePo(options.po) : options.po;
  const language = po.headers.get('language');
  if (language !== options.locale) poError('PO_LOCALE_MISMATCH', `PO Language is ${JSON.stringify(language ?? '')}; expected ${JSON.stringify(options.locale)}.`);
  if (!/^text\/plain\s*;\s*charset\s*=\s*"?utf-8"?\s*$/i.test(po.headers.get('content-type') ?? '')) poError('PO_ENCODING', 'PO Content-Type must declare text/plain; charset=UTF-8.');
  const version = po.headers.get('x-nordbeam-locale-format') ?? po.headers.get('x-nordbeam-i18n-format') ?? po.headers.get('x-fasti18n-format');
  if (version !== undefined && version !== '1') poError('PO_VERSION', `Unsupported PO transport version ${JSON.stringify(version)}.`);
  const sourceLocale = po.headers.get('x-source-language');
  if (sourceLocale !== undefined && sourceLocale !== options.baseLocale) poError('PO_BASE_LOCALE', 'PO source language does not match the project base locale.');
  const base = options.catalogs[options.baseLocale];
  if (!base) poError('BASE_LOCALE_MISSING', `No catalog for base locale ${JSON.stringify(options.baseLocale)}.`);
  const catalogs: Record<string, Catalog> = Object.create(null);
  for (const [locale, catalog] of Object.entries(options.catalogs)) catalogs[locale] = cloneCatalog(catalog, locale);
  const target = catalogs[options.locale] ?? Object.create(null) as Catalog;
  catalogs[options.locale] = target;
  const baseIndex = pureIndexCatalog(base!, options.baseLocale);
  const targetIndex = pureIndexCatalog(target, options.locale);
  const added: string[] = [], updated: string[] = [];
  let unchanged = 0;
  const skipped = { fuzzy: 0, untranslated: 0, obsolete: po.obsolete };
  for (const entry of po.entries) {
    if (entry.fuzzy) { skipped.fuzzy++; continue; }
    if (entry.translation === '' && !entry.empty) { skipped.untranslated++; continue; }
    const source = baseIndex.get(entry.id);
    if (!source) poError('PO_UNKNOWN_ID', 'This message ID is absent from the base catalog. Remove the entry or mark it obsolete.', undefined, undefined, entry.id);
    if (entry.source !== source!.text) poError('PO_STALE_SOURCE', 'The source message changed. Export current source text and review this translation before importing.', undefined, undefined, entry.id);
    const existing = targetIndex.get(entry.id);
    if (existing?.text === entry.translation) unchanged++;
    else {
      (existing ? updated : added).push(entry.id);
      pureSetMessage(target, entry.id, existing?.path ?? source!.path, entry.translation);
      targetIndex.set(entry.id, { text: entry.translation, path: existing?.path ?? source!.path });
    }
  }
  const checked = checkProject(pureCompilerOptions(options, catalogs));
  if (!checked.ok) throw new CompileError(checked.errors);
  added.sort(); updated.sort();
  return { locale: options.locale, catalog: target, catalogs, added, updated, unchanged, skipped, warnings: checked.warnings };
}
