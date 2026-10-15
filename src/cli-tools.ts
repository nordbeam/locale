import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { checkProject, CompileError } from './compiler.js';
import type { Catalog, Diagnostic } from './compiler.js';
import { staticScopes } from './scope-modules.js';
import { generate } from './project.js';
import type { GenerateOptions } from './project.js';
import { invalidJson, locateDiagnostics } from './catalog-diagnostics.js';
import type { CatalogSource } from './catalog-diagnostics.js';
import { pseudoLocalizeCatalog } from './pseudo.js';
import { catalogSchema, configSchema } from './schema.js';
import { notesFile, parseNotes } from './notes.js';

/** Result of a source/catalog edit.  The CLI deliberately keeps this data
 * serializable so editors and other tools can consume the same commands. */
export interface RefactorResult {
  changed: string[];
  references: string[];
  ids: string[];
  warnings: Diagnostic[];
}

export interface ExtractOptions extends GenerateOptions {
  id: string;
  message: string;
  locale?: string;
  /** Regenerate the output after writing the catalog. Without it the result is marked stale. */
  regenerate?: boolean;
}

export interface RefactorOptions extends GenerateOptions {
  sourceDir?: string;
}

/** Whether generated output reflects the catalogs after a write. */
export interface RegenerationStatus {
  regenerated: boolean;
  generated: string[];
  stale: boolean;
  /** Command that makes the generated output fresh, present only when stale. */
  next?: string;
}

export interface RenameResult extends Omit<RefactorResult, 'ids'>, RegenerationStatus {
  ids: Array<{ from: string; to: string }>;
  locales: string[];
}

export interface ExtractResult extends RefactorResult, RegenerationStatus {}

export interface PruneResult extends RefactorResult {
  unused: string[];
  sourceFiles: number;
}

export interface DoctorResult {
  ok: boolean;
  errors: Diagnostic[];
  warnings: Diagnostic[];
  locales: string[];
  messageCount: number;
  catalogFiles: string[];
  sourceFiles: number;
  unused: string[];
}

export interface PseudoOptions extends GenerateOptions {
  locale: string;
  fromLocale?: string;
  expansion?: number;
  dryRun?: boolean;
  update?: boolean;
}

export interface PseudoResult {
  ok: boolean;
  locale: string;
  fromLocale: string;
  catalogFile: string;
  dryRun: boolean;
  written: boolean;
  messageCount: number;
  output: string;
  warnings: Diagnostic[];
}

export interface EditorSchemaResult {
  directory: string;
  files: string[];
  messageCount: number;
}

interface FileCatalog { locale: string; file: string; text: string; catalog: Catalog }
interface LoadedCatalogs { root: string; directory: string; files: FileCatalog[]; catalogs: Record<string, Catalog>; sources: Map<string, CatalogSource> }
interface Leaf { id: string; path: string[]; text: string }

const own = (object: object, key: PropertyKey): boolean => Object.hasOwn(object, key);
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const sourceExtensions = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.vue', '.svelte']);
const ignoredDirectories = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'target']);

function fail(code: string, message: string, context: Partial<Diagnostic> = {}): never {
  throw new CompileError([{ code, message, ...context }]);
}

function assertId(id: string, label: string): string[] {
  if (!id || id.startsWith('.') || id.endsWith('.') || id.includes('..')) fail('INVALID_MESSAGE_ID', `${label} must be a nonempty dotted message ID, such as ${JSON.stringify('checkout.pay')}.`);
  const parts = id.split('.');
  if (parts.some(part => !part || part === '__proto__')) fail('INVALID_MESSAGE_ID', `${label} contains an invalid path segment.`);
  return parts;
}

/** Stage every file before replacing any destination. This prevents a failed
 * source/catalog preflight or disk write from leaving a half-applied rename. */
async function writeFilesTransaction(files: Map<string, string>): Promise<string[]> {
  const staged: Array<{ file: string; temporary: string }> = [];
  try {
    for (const [file, text] of [...files].sort(([a], [b]) => compare(a, b))) {
      await mkdir(dirname(file), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, text, { flag: 'wx' });
      staged.push({ file, temporary });
    }
    for (const item of staged) await rename(item.temporary, item.file);
    return staged.map(item => item.file);
  } finally {
    for (const item of staged) await unlink(item.temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
  }
}

async function loadCatalogs(options: GenerateOptions): Promise<LoadedCatalogs> {
  const root = resolve(options.root ?? '.');
  const directory = resolve(root, options.catalogs ?? 'messages');
  let names: string[];
  try { names = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => entry.name).sort(compare); }
  catch (error) { fail('CATALOG_READ_ERROR', (error as Error).message, { file: directory }); }
  const files: FileCatalog[] = [];
  const catalogs: Record<string, Catalog> = Object.create(null);
  const sources = new Map<string, CatalogSource>();
  for (const name of names) {
    const locale = name.slice(0, -5), file = resolve(directory, name);
    let text: string;
    try { text = await readFile(file, 'utf8'); }
    catch (error) { fail('CATALOG_READ_ERROR', (error as Error).message, { locale, file }); }
    let catalog: Catalog;
    try { catalog = JSON.parse(text) as Catalog; }
    catch (error) { throw invalidJson(error as Error, locale, { file, text }); }
    if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) fail('INVALID_CATALOG', 'Expected a JSON object containing strings or nested catalogs.', { locale, file });
    files.push({ locale, file, text, catalog }); catalogs[locale] = catalog; sources.set(locale, { file, text });
  }
  return { root, directory, files, catalogs, sources };
}

function leaves(catalog: Catalog, locale: string): Leaf[] {
  const result: Leaf[] = [];
  const ancestors = new Set<object>();
  function visit(value: unknown, prefix: string, path: string[]): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_CATALOG', 'Expected an object containing strings or nested catalogs.', { locale, messageId: prefix });
    if (ancestors.has(value)) fail('INVALID_CATALOG', 'Catalog contains a circular reference.', { locale, messageId: prefix });
    ancestors.add(value);
    for (const [key, child] of Object.entries(value as Catalog)) {
      if (!key) fail('INVALID_KEY', 'Message keys must not be empty.', { locale, messageId: prefix });
      const id = prefix ? `${prefix}.${key}` : key, next = [...path, key];
      if (typeof child === 'string') result.push({ id, path: next, text: child }); else visit(child, id, next);
    }
    ancestors.delete(value);
  }
  visit(catalog, '', []);
  const seen = new Set<string>();
  for (const leaf of result) if (seen.has(leaf.id)) fail('DUPLICATE_KEY', `Nested and flat keys both resolve to ${JSON.stringify(leaf.id)}.`, { locale, messageId: leaf.id }); else seen.add(leaf.id);
  return result;
}

function getLeaf(catalog: Catalog, id: string, locale: string): Leaf | undefined { return leaves(catalog, locale).find(leaf => leaf.id === id); }

function deleteAt(catalog: Catalog, path: string[]): void {
  let node = catalog;
  for (const key of path.slice(0, -1)) node = node[key] as Catalog;
  delete node[path.at(-1)!];
  // Keep source formatting stable while removing empty containers created by
  // the old key. A user-owned empty object is retained if it was pre-existing.
  for (let i = path.length - 1; i > 0; i--) {
    let parent = catalog;
    for (const key of path.slice(0, i - 1)) parent = parent[key] as Catalog;
    const key = path[i - 1]!;
    if (parent[key] && typeof parent[key] === 'object' && !Object.keys(parent[key] as Catalog).length) delete parent[key]; else break;
  }
}

function setAt(catalog: Catalog, path: string[], text: string): void {
  let node = catalog;
  for (const key of path.slice(0, -1)) {
    if (!own(node, key)) Object.defineProperty(node, key, { value: Object.create(null), enumerable: true, writable: true, configurable: true });
    if (!node[key] || typeof node[key] !== 'object' || Array.isArray(node[key])) fail('CATALOG_LAYOUT_CONFLICT', `Cannot create ${JSON.stringify(path.join('.'))}: ${JSON.stringify(path.slice(0, path.indexOf(key) + 1).join('.'))} is a message.`);
    node = node[key] as Catalog;
  }
  const key = path.at(-1)!;
  if (own(node, key)) fail('MESSAGE_ALREADY_EXISTS', `Message ID ${JSON.stringify(path.join('.'))} already exists.`);
  Object.defineProperty(node, key, { value: text, enumerable: true, writable: true, configurable: true });
}

function indentation(text: string): string { return text.match(/\n([ \t]+)"/)?.[1] ?? '  '; }
function serialize(catalog: Catalog, source: string): string {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  return JSON.stringify(catalog, null, indentation(source)).replaceAll('\n', eol) + eol;
}

async function writeCatalogChanges(changes: Map<string, { catalog: Catalog; source: string }>): Promise<string[]> {
  const outputs = new Map<string, string>();
  for (const [file, value] of [...changes].sort(([a], [b]) => compare(a, b))) {
    const output = serialize(value.catalog, value.source);
    if (output !== value.source) outputs.set(file, output);
  }
  return writeFilesTransaction(outputs);
}

function codeFiles(root: string, sourceDir?: string, excluded: string[] = []): Promise<string[]> {
  // Restrict the default scan to application source. A repository-wide scan
  // would include benchmarks, docs and generated modules and could make a
  // rename unexpectedly edit user-owned research files.
  const start = resolve(root, sourceDir ?? 'src');
  const excludedPaths = new Set(excluded.map(path => resolve(root, path)));
  const result: string[] = [];
  async function visit(directory: string): Promise<void> {
    if (excludedPaths.has(directory)) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const entry of entries.sort((a, b) => compare(a.name, b.name))) {
      if (entry.isDirectory()) { if (!ignoredDirectories.has(entry.name)) await visit(resolve(directory, entry.name)); }
      else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) result.push(resolve(directory, entry.name));
    }
  }
  return visit(start).then(() => result);
}

interface SourceScan { files: string[]; ids: Set<string>; references: string[]; unknown: Diagnostic[] }
const messageImport = /\bimport\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s*from\s*(['"])([^'"]+)\2/g;

/** Local names bound to the generated messages object. An import from a
 * messages module is authoritative; the conventional `m` counts only when the
 * file does not declare `m` some other way, so unrelated objects stay quiet. */
function messageBindings(text: string): Set<string> {
  const names = new Set<string>();
  for (const match of text.matchAll(messageImport)) if (/(?:^|\/)messages(?:\.d)?(?:\.[cm]?[jt]s)?$/.test(match[3]!)) names.add(match[1]!);
  if (!/\b(?:const|let|var|function|class)\s+m\b|\bimport\b[^;\n]*\bm\b[^;\n]*\bfrom\b/.test(text.replace(messageImport, ''))) names.add('m');
  return names;
}

/** One-based line/column for a UTF-16 offset, in the shape diagnostics use. */
function position(text: string, offset: number): { line: number; column: number; offset: number } {
  const before = text.slice(0, offset), line = before.split('\n').length;
  return { line, column: offset - before.lastIndexOf('\n'), offset };
}

function editDistance(a: string, b: string): number {
  const row = [...Array(b.length + 1).keys()];
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!; row[0] = i;
    for (let j = 1; j <= b.length; j++) { const current = row[j]!; row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1)); previous = current; }
  }
  return row[b.length]!;
}

/** Unknown IDs are reported only for references rooted at a messages binding,
 * so ordinary objects with the same property shape never produce errors. */
function unknownReference(file: string, text: string, offset: number, id: string, sorted: string[]): Diagnostic {
  let suggestion: string | undefined, best = 4;
  for (const candidate of sorted) {
    if (Math.abs(candidate.length - id.length) >= best) continue;
    const distance = editDistance(id, candidate); if (distance < best) { best = distance; suggestion = candidate; }
  }
  return {
    code: 'UNKNOWN_MESSAGE_ID', message: `Message ID ${JSON.stringify(id)} does not exist in the base catalog.`, messageId: id, file, location: position(text, offset),
    hint: suggestion ? `Did you mean ${JSON.stringify(suggestion)}?` : 'Check the ID against the base catalog, or add it with extract.',
  };
}

async function scanSources(root: string, sourceDir?: string, known?: Set<string>, excluded: string[] = []): Promise<SourceScan> {
  const files = await codeFiles(root, sourceDir, excluded), ids = new Set<string>(), references: string[] = [], unknown: Diagnostic[] = [];
  // This is intentionally a lexical, conservative scan. It only rewrites
  // property calls/bracket access and known key-taking calls, never arbitrary
  // prose. False negatives stay safe; callers can review dynamic keys.
  const property = /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)(?=\s*\()/g;
  const bracket = /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\[\s*(['"])([^'"\\]+)\2\s*\]/g;
  const quoted = /\b(?:selectMessages|useMessages|messageKey|key|t)\s*\(\s*(['"])([^'"\\]+)\1/g;
  const knownIds = known ? [...known].sort((left, right) => right.length - left.length || compare(left, right)) : undefined;
  // Namespace prefixes such as "checkout" for "checkout.pay" are valid calls too.
  const namespaces = new Set<string>();
  let sortedIds: string[] | undefined;
  for (const id of known ?? []) for (let i = id.indexOf('.'); i !== -1; i = id.indexOf('.', i + 1)) namespaces.add(id.slice(0, i));
  const checkUnknown = (file: string, text: string, offset: number, chain: string, bindings: Set<string>): void => {
    const root = chain.split('.')[0]!;
    if (!known || !bindings.has(root)) return;
    const path = chain.slice(root.length + 1);
    if (path && !known.has(path) && !namespaces.has(path)) unknown.push(unknownReference(file, text, offset, path, sortedIds ??= [...known].sort(compare)));
  };
  for (const file of files) {
    const text = await readFile(file, 'utf8'), mask = codeMask(text), bindings = known ? messageBindings(text) : new Set<string>();
    for (const match of text.matchAll(property)) {
      if (!mask[match.index!]) continue;
      const chain = match[1]!;
      const id = knownIds?.find(candidate => chain === candidate || chain.endsWith(`.${candidate}`)) ?? (known ? undefined : chain.slice(chain.indexOf('.') + 1));
      if (id) { ids.add(id); references.push(file); }
      checkUnknown(file, text, match.index!, chain, bindings);
    }
    for (const match of text.matchAll(bracket)) {
      if (!mask[match.index!]) continue;
      const id = match[3]!; if (!known || known.has(id)) { ids.add(id); references.push(file); }
      const chain = match[1]!, root = chain.split('.')[0]!;
      if (known && bindings.has(root)) { const rest = chain.slice(root.length + 1); checkUnknown(file, text, match.index!, rest ? `${root}.${rest}.${id}` : `${root}.${id}`, bindings); }
    }
    for (const match of text.matchAll(quoted)) {
      if (!mask[match.index!]) continue;
      const id = match[2]!; if (!known || known.has(id)) { ids.add(id); references.push(file); }
    }
  }
  return { files, ids, references: [...new Set(references)].sort(compare), unknown };
}

async function defaultSourceDirectories(root: string): Promise<string[]> {
  const directories: string[] = [];
  // Cover the layouts used by Vite/React, Next App Router and common library
  // projects while keeping scans away from repository-wide research files.
  for (const directory of ['src', 'app', 'pages', 'components', 'lib', 'routes']) {
    try { if ((await lstat(resolve(root, directory))).isDirectory()) directories.push(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return directories;
}

async function scanDefaultSources(root: string, known: Set<string>, excluded: string[]): Promise<SourceScan> {
  const directories = await defaultSourceDirectories(root);
  const scans = await Promise.all(directories.map(directory => scanSources(root, directory, known, excluded)));
  const files = [...new Set(scans.flatMap(scan => scan.files))].sort(compare);
  const ids = new Set(scans.flatMap(scan => [...scan.ids]));
  const references = [...new Set(scans.flatMap(scan => scan.references))].sort(compare);
  return { files, ids, references, unknown: scans.flatMap(scan => scan.unknown) };
}

function replaceReferences(text: string, from: string, to: string): { text: string; count: number } {
  const parts = to.split('.');
  const propertyTarget = parts.every(part => /^[A-Za-z_$][\w$]*$/.test(part)) ? `.${parts.join('.')}` : null;
  let code = codeMask(text);
  const isCode = (args: unknown[]): boolean => {
    const offset = args.at(-2);
    return typeof offset === 'number' && code[offset] === 1;
  };
  let output = text, count = 0;
  if (propertyTarget && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(from)) {
    const property = new RegExp(`(\\b[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*)\\.${from.replaceAll('.', '\\.')}(?=\\s*\\()`,'g');
    output = output.replace(property, (...args: unknown[]) => {
      if (!isCode(args)) return args[0] as string;
      count++; return `${args[1] as string}${propertyTarget}`;
    });
    code = codeMask(output);
  }
  const bracket = new RegExp(`(\\b[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*\\s*\\[\\s*)(['"])${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\2(\\s*\\])`, 'g');
  output = output.replace(bracket, (...args: unknown[]) => {
    if (!isCode(args)) return args[0] as string;
    count++; return `${args[1] as string}${args[2] as string}${to}${args[2] as string}${args[3] as string}`;
  });
  code = codeMask(output);
  const calls = new RegExp(`(\\b(?:selectMessages|useMessages|messageKey|key|t)\\s*\\(\\s*)(['"])${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\2`, 'g');
  output = output.replace(calls, (...args: unknown[]) => {
    if (!isCode(args)) return args[0] as string;
    count++; return `${args[1] as string}${args[2] as string}${to}${args[2] as string}`;
  });
  return { text: output, count };
}

/** Mark executable source while ignoring comments and quoted text. This small
 * lexer keeps refactors out of docs/comments without requiring a runtime
 * TypeScript parser dependency. Template literals are treated as text (a safe
 * false negative); callers can still rename those dynamic usages manually.
 * Literal openers are marked so dynamic keys can be located; contents are not. */
function codeMask(text: string): Uint8Array {
  const mask = new Uint8Array(text.length); let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!, next = text[i + 1];
    if (state === 'code') {
      if (char === '/' && next === '/') { state = 'line'; i++; continue; }
      if (char === '/' && next === '*') { state = 'block'; i++; continue; }
      mask[i] = 1;
      if (char === "'") state = 'single';
      else if (char === '"') state = 'double';
      else if (char === '`') state = 'template';
      continue;
    }
    if (state === 'line') { if (char === '\n' || char === '\r') state = 'code'; continue; }
    if (state === 'block') { if (char === '*' && next === '/') { state = 'code'; i++; } continue; }
    if (char === '\\') { i++; continue; }
    if ((state === 'single' && char === "'") || (state === 'double' && char === '"') || (state === 'template' && char === '`')) state = 'code';
  }
  return mask;
}

function validate(options: GenerateOptions, catalogs: Record<string, Catalog>): { warnings: Diagnostic[] } {
  const result = checkProject({ ...options, catalogs, notes: undefined, scopes: staticScopes(options.scopes) });
  if (!result.ok) throw new CompileError([...result.errors]);
  return { warnings: result.warnings };
}

/** Literal prefixes of the old ID inside code, such as `checkout.${step}` or
 * 'checkout.' + step. Rename cannot prove these references, so it reports them. */
function dynamicReferences(file: string, text: string, from: string): Diagnostic[] {
  const mask = codeMask(text), found: Diagnostic[] = [];
  for (let i = 0; i < text.length; i++) {
    const quote = text[i]!;
    if (!mask[i] || (quote !== '"' && quote !== "'" && quote !== '`')) continue;
    let end = i + 1;
    while (end < text.length && text[end] !== quote) end += text[end] === '\\' ? 2 : 1;
    let value = text.slice(i + 1, end);
    if (quote === '`') { const at = value.indexOf('${'); if (at === -1) { i = end; continue; } value = value.slice(0, at); }
    if (value.endsWith('.') && value.length < from.length && from.startsWith(value)) found.push({
      code: 'RENAME_DYNAMIC_REFERENCE', message: `Dynamic key ${JSON.stringify(value)} may reference ${JSON.stringify(from)}, and rename cannot rewrite it.`,
      file, location: position(text, i), hint: 'Check this key by hand; it was not renamed.',
    });
    i = end;
  }
  return found;
}

/** Regenerate output on request; otherwise say plainly that it is now stale. */
async function refreshOutput(options: RefactorOptions & { regenerate?: boolean }, changedCatalogs: boolean): Promise<RegenerationStatus> {
  if (options.regenerate) return { regenerated: true, generated: (await generate(options)).changed, stale: false };
  return changedCatalogs ? { regenerated: false, generated: [], stale: true, next: 'nordbeam-locale generate' } : { regenerated: false, generated: [], stale: false };
}

/** Rename a message in every catalog and in statically recognizable source calls. */
export async function renameMessage(options: RefactorOptions & { from: string; to: string; regenerate?: boolean }): Promise<RenameResult> {
  const fromParts = assertId(options.from, 'The old message ID'), toParts = assertId(options.to, 'The new message ID');
  if (options.from === options.to) fail('INVALID_MESSAGE_ID', 'The old and new message IDs must differ.');
  const input = await loadCatalogs(options);
  const base = input.catalogs[options.baseLocale];
  if (!base) fail('BASE_LOCALE_MISSING', `No catalog for base locale ${JSON.stringify(options.baseLocale)}.`, { file: input.directory });
  const changes = new Map<string, { catalog: Catalog; source: string }>();
  const locales: string[] = [];
  for (const file of input.files) {
    const old = getLeaf(file.catalog, options.from, file.locale);
    if (!old) continue;
    if (getLeaf(file.catalog, options.to, file.locale)) fail('MESSAGE_ALREADY_EXISTS', `Cannot rename ${JSON.stringify(options.from)} to ${JSON.stringify(options.to)} in ${file.locale}: the destination already exists.`, { file: file.file });
    deleteAt(file.catalog, old.path); setAt(file.catalog, old.path.length === fromParts.length && old.path.length === 1 ? toParts : old.path.length === 1 ? [options.to] : toParts, old.text);
    changes.set(file.file, { catalog: file.catalog, source: file.text }); locales.push(file.locale);
  }
  if (!getLeaf(input.catalogs[options.baseLocale]!, options.to, options.baseLocale)) fail('MESSAGE_NOT_FOUND', `Message ID ${JSON.stringify(options.from)} is not present in the base catalog.`);
  const checked = validate(options, input.catalogs);
  const source = await scanSources(input.root, options.sourceDir, undefined, [options.catalogs ?? 'messages', options.outDir ?? 'src/i18n']);
  const sourceChanges = new Map<string, string>(), dynamic: Diagnostic[] = [];
  for (const file of source.files) {
    const text = await readFile(file, 'utf8'), result = replaceReferences(text, options.from, options.to);
    if (result.count) sourceChanges.set(file, result.text);
    dynamic.push(...dynamicReferences(file, text, options.from));
  }
  const catalogOutputs = new Map<string, string>();
  for (const [file, value] of changes) { const output = serialize(value.catalog, value.source); if (output !== value.source) catalogOutputs.set(file, output); }
  // The message's note moves with it, unless the new ID already has one.
  const notes = notesFile(options);
  const notesText = notes && await readFile(notes, 'utf8').catch(() => undefined);
  if (notes && notesText !== undefined) {
    parseNotes(notesText, notes);
    const catalog = JSON.parse(notesText) as Catalog, note = getLeaf(catalog, options.from, 'notes');
    if (note && !getLeaf(catalog, options.to, 'notes')) {
      deleteAt(catalog, note.path); setAt(catalog, note.path.length === fromParts.length && note.path.length === 1 ? toParts : note.path.length === 1 ? [options.to] : toParts, note.text);
      catalogOutputs.set(notes, serialize(catalog, notesText));
    }
  }
  const changed = await writeFilesTransaction(new Map([...catalogOutputs, ...sourceChanges]));
  const status = await refreshOutput(options, changed.length > 0);
  return { changed, references: [...sourceChanges.keys()].sort(compare), ids: [{ from: options.from, to: options.to }], locales, warnings: [...checked.warnings.map(warning => ({ ...warning })), ...dynamic], ...status };
}

/** Add one source message to a catalog, validating the full project before writing. */
export async function extractMessage(options: ExtractOptions): Promise<ExtractResult> {
  const idParts = assertId(options.id, 'The message ID'), input = await loadCatalogs(options), locale = options.locale ?? options.baseLocale;
  const target = input.catalogs[locale];
  if (!target) fail('LOCALE_MISSING', `No catalog for locale ${JSON.stringify(locale)}.`, { file: input.directory });
  if (getLeaf(target, options.id, locale)) fail('MESSAGE_ALREADY_EXISTS', `Message ID ${JSON.stringify(options.id)} already exists in ${locale}.`);
  setAt(target, idParts, options.message);
  const file = input.files.find(item => item.locale === locale);
  if (!file) fail('LOCALE_MISSING', `No catalog file for locale ${JSON.stringify(locale)}.`, { file: input.directory });
  try { validate(options, input.catalogs); }
  catch (error) { throw error; }
  const changed = await writeCatalogChanges(new Map([[file.file, { catalog: target, source: file.text }]]));
  return { changed, references: [], ids: [options.id], warnings: [], ...(await refreshOutput(options, changed.length > 0)) };
}

/** Report catalog IDs absent from statically recognizable source usage. */
export async function pruneMessages(options: RefactorOptions & { dryRun?: boolean }): Promise<PruneResult> {
  // Prune is intentionally report-only, so the default is already safe. Keep
  // accepting --dry-run for scripts written against older releases, but do
  // not force an otherwise ceremonial flag on every invocation.
  const input = await loadCatalogs(options), base = input.catalogs[options.baseLocale];
  if (!base) fail('BASE_LOCALE_MISSING', `No catalog for base locale ${JSON.stringify(options.baseLocale)}.`, { file: input.directory });
  const baseLeaves = leaves(base, options.baseLocale).map(item => item.id).sort(compare), scan = await scanSources(input.root, options.sourceDir, new Set(baseLeaves), [options.catalogs ?? 'messages', options.outDir ?? 'src/i18n']);
  const unused = baseLeaves.filter(id => !scan.ids.has(id));
  const checked = validate(options, input.catalogs);
  return { changed: [], references: scan.references, ids: baseLeaves, warnings: checked.warnings, unused, sourceFiles: scan.files.length };
}

/** Validate the project and provide a compact inventory useful in editors/CI. */
export async function doctor(options: RefactorOptions): Promise<DoctorResult> {
  let checked;
  try {
    const input = await loadCatalogs(options), result = checkProject({ ...options, catalogs: input.catalogs, notes: undefined, scopes: staticScopes(options.scopes) });
    const errors = locateDiagnostics(result.errors, input.sources), warnings = locateDiagnostics(result.warnings, input.sources);
    const base = input.catalogs[options.baseLocale];
    const ids = base ? leaves(base, options.baseLocale).map(item => item.id) : [];
    // Infer common application roots when --source-dir is omitted. Next apps
    // often use app/ or pages/, while Vite projects generally use src/.
    const source = options.sourceDir === undefined
      ? await scanDefaultSources(input.root, new Set(ids), [options.catalogs ?? 'messages', options.outDir ?? 'src/i18n'])
      : await scanSources(input.root, options.sourceDir, new Set(ids), [options.catalogs ?? 'messages', options.outDir ?? 'src/i18n']);
    // An empty project has no evidence from which to make a usage claim.
    const unused = source.files.length === 0 ? [] : ids.filter(id => !source.ids.has(id)).sort(compare);
    errors.push(...source.unknown);
    if (unused.length) warnings.push({ code: 'UNUSED_MESSAGE', message: `${unused.length} base-catalog message${unused.length === 1 ? '' : 's'} are not referenced by statically recognizable source calls.`, hint: 'Use --source-dir to include the application source or keep dynamic keys explicit.' });
    checked = { ok: errors.length === 0, errors, warnings, locales: input.files.map(file => file.locale), messageCount: ids.length, catalogFiles: input.files.map(file => file.file), sourceFiles: source.files.length, unused };
  } catch (error) {
    const diagnostics = error instanceof CompileError ? [...error.diagnostics] : [{ code: 'DOCTOR_ERROR', message: (error as Error).message }];
    checked = { ok: false, errors: diagnostics, warnings: [], locales: [], messageCount: 0, catalogFiles: [], sourceFiles: 0, unused: [] };
  }
  return checked;
}

/** Materialize local editor schemas. These two paths are command-owned and
 * intentionally refreshed so catalog completions follow source-key changes. */
export async function writeEditorSchemas(options: GenerateOptions & { directory?: string }): Promise<EditorSchemaResult> {
  const input = await loadCatalogs(options), base = input.catalogs[options.baseLocale];
  if (!base) fail('BASE_LOCALE_MISSING', `No catalog for base locale ${JSON.stringify(options.baseLocale)}.`, { file: input.directory });
  const directory = resolve(input.root, options.directory ?? '.nordbeam');
  const files = new Map([
    [resolve(directory, 'catalog.schema.json'), JSON.stringify(catalogSchema(base, options.baseLocale), null, 2) + '\n'],
    [resolve(directory, 'config.schema.json'), JSON.stringify(configSchema, null, 2) + '\n'],
  ]);
  return { directory, files: await writeFilesTransaction(files), messageCount: leaves(base, options.baseLocale).length };
}

/** Generate a pseudo-locale catalog from one source locale. Existing target
 * catalogs require --update so a preview can never be mistaken for approval. */
export async function pseudoCatalog(options: PseudoOptions): Promise<PseudoResult> {
  const input = await loadCatalogs(options), fromLocale = options.fromLocale ?? options.baseLocale;
  const source = input.catalogs[fromLocale];
  if (!source) fail('LOCALE_MISSING', `No catalog for source locale ${JSON.stringify(fromLocale)}.`, { file: input.directory });
  if (options.locale === fromLocale) fail('INVALID_LOCALE', 'Pseudo locale must differ from its source locale.');
  let canonical: string;
  try { canonical = Intl.getCanonicalLocales(options.locale)[0]!; }
  catch { fail('INVALID_LOCALE', `Invalid pseudo locale ${JSON.stringify(options.locale)}.`); }
  if (canonical !== options.locale) fail('INVALID_LOCALE', `Use the canonical locale ${JSON.stringify(canonical)} for the pseudo catalog.`);
  const targetFile = resolve(input.directory, `${options.locale}.json`), existing = input.files.find(file => file.locale === options.locale);
  if (existing && !options.update) fail('PSEUDO_TARGET_EXISTS', `Refusing to overwrite ${targetFile}. Pass --update to replace an existing pseudo catalog.`, { file: targetFile });
  const pseudo = pseudoLocalizeCatalog(source, { expansion: options.expansion });
  const catalogs = { ...input.catalogs, [options.locale]: pseudo };
  const checked = checkProject({ ...options, catalogs, missing: 'fallback', notes: undefined, scopes: staticScopes(options.scopes) });
  if (!checked.ok) throw new CompileError(locateDiagnostics(checked.errors, input.sources));
  const sourceText = existing?.text ?? input.files.find(file => file.locale === fromLocale)?.text ?? '';
  const output = serialize(pseudo, sourceText);
  let written = false;
  if (!options.dryRun) { await writeFilesTransaction(new Map([[targetFile, output]])); written = true; }
  return { ok: true, locale: options.locale, fromLocale, catalogFile: targetFile, dryRun: options.dryRun === true, written, messageCount: leaves(source, fromLocale).length, output, warnings: checked.warnings };
}
