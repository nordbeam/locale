import type { TextScanConfig } from './text-scan.js';
import { readFileSync } from 'node:fs';
import { readdir, readFile, mkdir, writeFile, rename, unlink, lstat } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { randomUUID, hash } from 'node:crypto';
import { compileProject, checkProject, createCompiler, CompileError } from './compiler.js';
import type { Catalog, CompilerOptions, CompilerCacheOptions, CompiledProject, CheckResult, Diagnostic } from './compiler.js';
import { markGenerated } from './codegen.js';
import { attachDeclarationMaps } from './source-maps.js';
import { inputDigest, restoreCache, encodeCache, cacheName } from './persistent-cache.js';
import type { InputDigest } from './persistent-cache.js';
import type { DeclarationMapCache } from './source-maps.js';
import { parseCatalogSnapshot } from './catalog-input.js';
import { locateCompileError, locateDiagnostics, invalidJson, duplicateKeyDiagnostics } from './catalog-diagnostics.js';
import { thenableKeyDiagnostics } from './key-policy.js';
import type { CatalogSource } from './catalog-diagnostics.js';
import { CliError } from './error-codes.js';
import { catalogIds, notesFile, readNotes, unknownNotes } from './notes.js';
import { resolveModuleScopes, staticScopes } from './scope-modules.js';
import type { ScopeConfig } from './scope-modules.js';
export type { ModuleScope, ScopeConfig } from './scope-modules.js';
export { updateCatalogText } from './catalog-text.js';
export type { CatalogTextChanges } from './catalog-text.js';

export interface GenerateOptions extends Omit<CompilerOptions, 'catalogs' | 'notes' | 'scopes' | 'checkedScopes'> {
  /** Loaders for parts of the catalog, by name: message IDs and `prefix.*` patterns,
   * or `{ modules, messages }` to take the messages that those modules and their imports name. */
  scopes?: Readonly<Record<string, ScopeConfig>>;
  /** Directory containing one JSON catalog per locale. Default: messages. */
  catalogs?: string;
  /** JSON file of notes about messages, shaped like a catalog, relative to root.
   * Notes reach editor hovers and PO exports. Outside the catalog directory. */
  notes?: string;
  /** Generated files only; existing unrelated files are never removed. */
  outDir?: string;
  root?: string;
  /** Watch-session message-body cache policy. Ignored by stateless generation. */
  cache?: CompilerCacheOptions;
  /** Opt-in artifact cache for stateless generation, relative to root. One entry
   * per project. true uses node_modules/.cache/nordbeam-locale. Disabled by default;
   * watch sessions retain their existing in-memory cache instead. */
  persistentCache?: boolean | string;
  /** How hardcoded and doctor find UI text outside the catalog. Not used by generation. */
  text?: TextScanConfig;
}
export interface GenerateResult extends CompiledProject {
  catalogFiles: string[];
  /** Source files read to compute module scopes. A change to one can change a scope. */
  scopeFiles: string[];
  changed: string[];
  outDir: string;
}
const marker = '.nordbeam-locale-manifest.json';
/** Ownership manifests from earlier releases. They are read when the current manifest is absent, and generate removes them. */
const legacyMarkers = ['.nordbeam-i18n-manifest.json', '.fasti18n-manifest.json'];
const generatedPath = /^(?:package\.json|(?:scopes\/[A-Za-z][A-Za-z0-9_-]*\/)?(?:messages\.d\.ts(?:\.map)?|types\/\d+\.d\.ts(?:\.map)?|index\.(?:js|d\.ts)|locales\/[A-Za-z0-9-]+\.(?:js|d\.ts)|internal\/(?:shared\.js|locales\/[A-Za-z0-9-]+\.js)))$/;
const isMissing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';
type OutputCache = Map<string, { content: string; stamp: string }>;
async function fileStamp(file: string): Promise<{ regular: boolean; stamp: string } | undefined> {
  try {
    const stat = await lstat(file, { bigint: true });
    return { regular: stat.isFile(), stamp: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':') };
  } catch (error) { if (isMissing(error)) return; throw error; }
}

async function readOptional(file: string): Promise<string | undefined> {
  try { return await readFile(file, 'utf8'); } catch (error) { if (isMissing(error)) return; throw error; }
}

/** The output directory's ownership manifest, under its current name or a legacy one. */
export async function readOutputManifest(outDir: string): Promise<{ file: string; text: string; legacy: boolean } | undefined> {
  const names = [marker, ...legacyMarkers];
  for (const name of names) {
    const file = resolve(outDir, name), text = await readOptional(file);
    if (text !== undefined) return { file, text, legacy: name !== marker };
  }
}
async function atomicWrite(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content);
    await rename(temporary, file);
  } catch (error) {
    // rename() moves the temporary name away on success. Avoid an
    // unnecessary unlink syscall on the hot path; only clean up when the
    // write/rename failed and the temporary name can still exist.
    await unlink(temporary).catch(error => { if (!isMissing(error)) throw error; });
    throw error;
  }
}

/** Write compiler-owned files, preserving unrelated files and unchanged mtimes. */
/** Names the build mode and the catalog directory in each header line. Run it after declaration maps are
 * attached: it never adds lines. The path is project-relative, so it is right in nested generated files too. */
export function markProject(project: CompiledProject, development: boolean, root: string, input: string): CompiledProject {
  const files = Object.assign(Object.create(null), project.files) as Record<string, string>;
  const catalogPath = (relative(root, input) || '.').split(sep).join('/');
  for (const name of Object.keys(files)) files[name] = markGenerated(files[name]!, development, catalogPath);
  return { ...project, files };
}

export async function writeProject(project: CompiledProject, directory: string): Promise<string[]> {
  return writeOutput(project, directory);
}

/** Manifest fields that let a later run prove it can skip compile and write. */
interface ManifestRecord { inputs: InputDigest; project: { locales: string[]; groups: CompiledProject['groups']; warnings: Diagnostic[] } }
interface OutputRecord { hash: string; size: number; mtime: number }

const digest = (value: string) => hash('sha1', value);

async function writeOutput(project: CompiledProject, directory: string, cache?: OutputCache, record?: ManifestRecord): Promise<string[]> {
  const outDir = resolve(directory);
  // Read a legacy ownership marker only when the current marker is absent. A
  // write always produces the current name and removes the legacy ones, so
  // this compatibility path is bounded to one migration.
  const currentMarker = resolve(outDir, marker);
  const previousText = (await readOutputManifest(outDir))?.text;
  let previous: string[] = [];
  if (previousText) {
    const manifest = JSON.parse(previousText) as { version: number; files: string[] };
    if (manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.some(file => typeof file !== 'string' || !generatedPath.test(file))) throw new Error(`Nordbeam Locale: invalid ownership manifest in ${outDir}`);
    previous = manifest.files;
  }
  const names = Object.keys(project.files).sort();
  const owned = new Set(previous);
  const stamps = new Map<string, string>();
  if (names.some(name => !generatedPath.test(name))) throw new Error('Compiled project contains an unsafe output path');
  // Preflight every destination before touching existing output. Bound pending
  // filesystem work, settle each batch, and report errors in filename order.
  for (let offset = 0; offset < names.length; offset += 16) {
    const batch = names.slice(offset, offset + 16);
    const states = await Promise.allSettled(batch.map(name => fileStamp(resolve(outDir, name))));
    for (let index = 0; index < batch.length; index++) {
      const name = batch[index]!, result = states[index]!;
      if (result.status === 'rejected') throw result.reason;
      const state = result.value;
      if (state && (!state.regular || !owned.has(name))) throw new CliError('FILE_EXISTS', `Refusing to overwrite unowned output: ${resolve(outDir, name)}. Choose an empty outDir.`, { path: resolve(outDir, name) });
      if (state) stamps.set(name, state.stamp);
    }
  }
  const changed: string[] = [];
  const nextCache: OutputCache = new Map();
  const writes: string[] = [];
  // Resolve content equality in bounded, deterministic batches. Preflight has
  // already completed for every destination, so these reads cannot race an
  // unowned overwrite check.
  for (let offset = 0; offset < names.length; offset += 16) {
    const batch = names.slice(offset, offset + 16);
    const decisions = await Promise.allSettled(batch.map(async name => {
      const file = resolve(outDir, name);
      const content = project.files[name]!;
      const cached = cache?.get(name);
      const stamp = stamps.get(name);
      const verified = cached !== undefined && cached.stamp === stamp;
      if (verified && cached.content === content) return false;
      // A missing destination or verified older content already proves a write
      // is needed. Reread only existing files whose content is not known.
      return stamp === undefined || verified || await readOptional(file) !== content;
    }));
    for (let index = 0; index < batch.length; index++) {
      const result = decisions[index]!;
      if (result.status === 'rejected') throw result.reason;
      if (result.value) writes.push(batch[index]!);
    }
  }
  // Atomic writes may run concurrently, but batches are settled and inspected
  // in sorted filename order. This bounds open descriptors and makes the first
  // reported failure deterministic while preserving changed[] ordering.
  for (let offset = 0; offset < writes.length; offset += 8) {
    const batch = writes.slice(offset, offset + 8);
    const results = await Promise.allSettled(batch.map(name => atomicWrite(resolve(outDir, name), project.files[name]!)));
    for (let index = 0; index < batch.length; index++) {
      const result = results[index]!, name = batch[index]!;
      if (result.status === 'rejected') throw result.reason;
      const file = resolve(outDir, name);
      changed.push(file);
      if (cache) stamps.set(name, (await fileStamp(file))!.stamp);
      if (cache) nextCache.set(name, { content: project.files[name]!, stamp: stamps.get(name)! });
    }
  }
  // Preserve cache entries for files that were already current or did not need
  // a write. They are added after the write batches so cache mutation remains
  // deterministic even when filesystem operations complete out of order.
  if (cache) for (const name of names) if (!nextCache.has(name)) {
    nextCache.set(name, { content: project.files[name]!, stamp: stamps.get(name)! });
  }
  for (const stale of previous.filter(name => !Object.hasOwn(project.files, name))) {
    const file = resolve(outDir, stale);
    await unlink(file).catch(error => { if (!isMissing(error)) throw error; });
    changed.push(file);
  }
  // Record each output's content hash and stat after all writes, so inspection
  // can detect hand edits and a no-op run can verify outputs by stat alone.
  const outputs: Record<string, OutputRecord> = {};
  for (let offset = 0; offset < names.length; offset += 16) {
    const batch = names.slice(offset, offset + 16);
    const states = await Promise.all(batch.map(name => lstat(resolve(outDir, name))));
    batch.forEach((name, index) => { outputs[name] = { hash: digest(project.files[name]!), size: states[index]!.size, mtime: states[index]!.mtimeMs }; });
  }
  const manifest = JSON.stringify({ version: 1, files: names, ...(record ? { inputs: record.inputs, project: record.project } : {}), outputs }, null, 2) + '\n';
  if (manifest !== await readOptional(currentMarker)) await atomicWrite(currentMarker, manifest);
  for (const name of legacyMarkers) await unlink(resolve(outDir, name)).catch(error => { if (!isMissing(error)) throw error; });
  if (cache) { cache.clear(); for (const [name, entry] of nextCache) cache.set(name, entry); }
  return changed;
}

export async function generate(options: GenerateOptions, read: (file: string) => Promise<string> = file => readFile(file, 'utf8')): Promise<GenerateResult> {
  return generateProject(options, read, compileProject);
}

export interface CheckProjectResult extends CheckResult { catalogFiles: string[] }

/** Catalog-looking names that discovery skips, so they must be reported rather than silently ignored. */
const looksLikeCatalog = /\.(?:json|json5|jsonc|ya?ml)$/i;

/** Catalog discovery shared by check and generate: loads `.json` files and reports ignored catalog-like names. */
export async function discoverCatalogs(input: string): Promise<{ files: string[]; ignored: Diagnostic[] }> {
  const entries = await readdir(input, { withFileTypes: true });
  const files = entries.filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => resolve(input, entry.name)).sort();
  const ignored = entries.filter(entry => entry.isFile() && !entry.name.endsWith('.json') && looksLikeCatalog.test(entry.name)).map(entry => ({
    code: 'IGNORED_CATALOG_FILE',
    message: `Ignoring ${JSON.stringify(entry.name)}: only .json files named by a canonical BCP 47 tag are loaded as catalogs.`,
    hint: 'Rename the file to a canonical tag with a lowercase .json extension, for example en.json or pt-BR.json.',
    file: resolve(input, entry.name),
  }));
  return { files, ignored };
}

/** The base locale's top-level keys are enough: `then` and `then.*` are both top-level members. */
function thenableWarnings(catalogs: Record<string, Catalog>, baseLocale: string): Diagnostic[] {
  return thenableKeyDiagnostics(Object.keys(catalogs[baseLocale] ?? {}));
}

/** Read and validate catalogs. Does not create, inspect or update generated output. */
export async function check(options: GenerateOptions, read: (file: string) => Promise<string> = file => readFile(file, 'utf8')): Promise<CheckProjectResult> {
  const input = resolve(options.root ?? '.', options.catalogs ?? 'messages');
  let discovered: Awaited<ReturnType<typeof discoverCatalogs>>;
  try { discovered = await discoverCatalogs(input); }
  catch (error) { return { ok: false, errors: [{ code: 'CATALOG_READ_ERROR', message: (error as Error).message, file: input }], warnings: [], locales: [], messageCount: 0, catalogFiles: [] }; }
  const catalogFiles = discovered.files;
  const catalogs: Record<string, Catalog> = Object.create(null);
  const sources = new Map<string, CatalogSource>();
  const errors: Diagnostic[] = [];
  const locales: string[] = [];
  for (const file of catalogFiles) {
    const locale = file.slice(input.length + 1, -5);
    locales.push(locale);
    let text: string;
    try { text = await read(file); }
    catch (error) { errors.push({ code: 'CATALOG_READ_ERROR', message: (error as Error).message, locale, file }); continue; }
    try { catalogs[locale] = parseCatalogSnapshot(text); }
    catch (error) { errors.push(...invalidJson(error as Error, locale, { file, text }).diagnostics); continue; }
    sources.set(locale, { file, text });
    errors.push(...duplicateKeyDiagnostics({ file, text }, locale, catalogs[locale]));
  }
  let notes: Awaited<ReturnType<typeof readNotes>>;
  try { notes = await readNotes(options, read); }
  catch (error) { if (!(error instanceof CompileError)) throw error; errors.push(...error.diagnostics); }
  let scopes: Record<string, readonly string[]> | undefined;
  let scopeWarnings: Diagnostic[] = [];
  const base = catalogs[options.baseLocale];
  try { ({ scopes, warnings: scopeWarnings } = await resolveModuleScopes(options, base && [...catalogIds(base)])); }
  catch (error) { if (!(error instanceof CompileError)) throw error; errors.push(...error.diagnostics); scopes = staticScopes(options.scopes); }
  const { notes: _file, ...compilerOptions } = options;
  const result = checkProject({ ...compilerOptions, scopes, catalogs });
  // A base file that could not be read/parsed is already explained by its load error.
  const baseFailed = errors.some(error => error.locale === options.baseLocale);
  errors.push(...locateDiagnostics(result.errors.filter(error => !baseFailed || error.code !== 'BASE_LOCALE_MISSING'), sources));
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  errors.sort((a, b) => compare(a.locale ?? '', b.locale ?? '') || (a.location?.offset ?? -1) - (b.location?.offset ?? -1) || compare(a.code, b.code));
  const warnings = [...locateDiagnostics(result.warnings, sources), ...discovered.ignored, ...thenableWarnings(catalogs, options.baseLocale),
    ...(catalogs[options.baseLocale] ? unknownNotes(notes, catalogIds(catalogs[options.baseLocale]!), notesFile(options)) : []), ...scopeWarnings];
  return { ...result, ok: errors.length === 0, errors, warnings, locales, catalogFiles };
}

/** An isolated, serialized generation session for watch mode and build plugins.
 * Configuration is captured at creation. Every run rereads source files;
 * output metadata is checked before skipping IO.
 */
export function createGenerator(options: GenerateOptions, cacheOptions?: CompilerCacheOptions): (read?: (file: string) => Promise<string>) => Promise<GenerateResult> {
  const config = structuredClone(options);
  const compile = createCompiler(cacheOptions ?? config.cache);
  const output: OutputCache = new Map();
  const declarationMaps: DeclarationMapCache = new Map();
  let sources = new Map<string, { text: string; catalog: Catalog }>();
  let compiled: CompiledProject | undefined;
  // Module scopes follow source code, so the same catalogs can produce other scopes.
  let scopes: string | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  return (read = file => readFile(file, 'utf8')) => {
    const job = tail.then(async () => {
      const next = new Map<string, { text: string; catalog: Catalog }>();
      let nextCompiled = compiled, nextScopes = scopes;
      const result = await generateProject(config, read, input => {
        const key = JSON.stringify(input.scopes ?? null);
        if (!nextCompiled || key !== nextScopes || next.size !== sources.size || [...next].some(([file, item]) => item !== sources.get(file))) nextCompiled = compile(input);
        nextScopes = key;
        // Keep the memoized output private even if callers edit returned metadata.
        return { ...nextCompiled, files: Object.assign(Object.create(null), nextCompiled.files), locales: [...nextCompiled.locales],
          groups: Object.assign(Object.create(null), Object.fromEntries(Object.entries(nextCompiled.groups).map(([entry, ids]) => [entry, [...ids]]))),
          warnings: nextCompiled.warnings.map(warning => ({ ...warning })) };
      }, output, (file, text) => {
        const previous = sources.get(file);
        const item = previous?.text === text ? previous : { text, catalog: parseCatalogSnapshot(text) };
        next.set(file, item);
        return item.catalog;
      }, declarationMaps);
      sources = next;
      compiled = nextCompiled;
      scopes = nextScopes;
      return result;
    });
    tail = job.catch(() => undefined);
    return job;
  };
}

/** Return the complete previous result when the manifest's input digest matches
 * and every output still matches. An output whose stat is unchanged is trusted
 * without reading; a changed stat falls back to a content hash. Contents of
 * trusted outputs are read on first access, so a no-op run does not decode
 * every generated file. Any mismatch, missing file or old-format manifest
 * returns undefined. */
async function verifiedOutput(outDir: string, inputs: InputDigest): Promise<Pick<CompiledProject, 'files' | 'locales' | 'groups' | 'warnings'> | undefined> {
  let manifest: { version?: unknown; files?: unknown; inputs?: { digest?: unknown }; outputs?: Record<string, OutputRecord>; project?: ManifestRecord['project'] };
  let found: Awaited<ReturnType<typeof readOutputManifest>>;
  try { found = await readOutputManifest(outDir); manifest = JSON.parse(found?.text ?? 'null'); }
  catch { return; }
  // A legacy manifest is only trusted by the write path, which moves it to the current name.
  if (!found || found.legacy) return;
  if (manifest.version !== 1 || manifest.inputs?.digest !== inputs.digest || !Array.isArray(manifest.files) || !manifest.outputs || !manifest.project) return;
  const { locales, groups, warnings } = manifest.project;
  if (!Array.isArray(locales) || !groups || typeof groups !== 'object' || !Array.isArray(warnings)) return;
  const files: Record<string, string> = Object.create(null);
  for (const name of manifest.files) {
    const record = typeof name === 'string' && generatedPath.test(name) ? manifest.outputs[name] : undefined;
    if (!record || Object.hasOwn(files, name)) return;
    const file = resolve(outDir, name);
    let state: Awaited<ReturnType<typeof lstat>>;
    try { state = await lstat(file); }
    catch { return; }
    if (!state.isFile()) return;
    if (state.size === record.size && state.mtimeMs === record.mtime) {
      let value: string | undefined;
      Object.defineProperty(files, name, { enumerable: true, get: () => value ??= readFileSync(file, 'utf8') });
      continue;
    }
    const content = await readFile(file, 'utf8');
    if (digest(content) !== record.hash) return;
    files[name] = content;
  }
  return { files, locales, groups: Object.assign(Object.create(null), groups), warnings };
}

async function generateProject(options: GenerateOptions, read: (file: string) => Promise<string>, compile: (options: CompilerOptions) => CompiledProject,
  output?: OutputCache, parseCatalog: (file: string, text: string) => Catalog = (_file, text) => parseCatalogSnapshot(text), declarationMaps?: DeclarationMapCache): Promise<GenerateResult> {
  const root = resolve(options.root ?? '.');
  const input = resolve(root, options.catalogs ?? 'messages');
  const outDir = resolve(root, options.outDir ?? 'src/i18n');
  if (options.persistentCache !== undefined && typeof options.persistentCache !== 'boolean' && (typeof options.persistentCache !== 'string' || !options.persistentCache)) throw new TypeError('persistentCache must be a boolean or nonempty directory string.');
  const inputFromOutput = relative(outDir, input);
  if (inputFromOutput === '' || (!inputFromOutput.startsWith('..') && !isAbsolute(inputFromOutput))) throw new Error('Catalogs cannot be inside the generated output directory.');
  let cacheFile: string | undefined;
  if (options.persistentCache && !output) {
    const directory = resolve(root, typeof options.persistentCache === 'string' ? options.persistentCache : 'node_modules/.cache/nordbeam-locale');
    const inside = (parent: string, child: string) => {
      const path = relative(parent, child);
      return path === '' || (!path.startsWith('..') && !isAbsolute(path));
    };
    // A cache below either input directory would be discovered as a locale
    // JSON file on the next run; below outDir it would be an unowned output
    // that the cache writer could overwrite. Keep the cache a sibling or an
    // external directory so catalog discovery and output ownership remain
    // unchanged.
    if (inside(input, directory)) throw new Error('Persistent cache directory must differ from the catalog directory.');
    if (inside(outDir, directory)) throw new Error('Persistent cache directory must differ from the output directory.');
    cacheFile = resolve(directory, cacheName(input, outDir));
  }
  const { files: catalogFiles, ignored } = await discoverCatalogs(input);
  const sources: { file: string; locale: string; text: string }[] = [];
  for (const file of catalogFiles) {
    const locale = file.slice(input.length + 1, -5);
    let text: string;
    try { text = await read(file); }
    catch (error) { throw new CompileError([{ code: 'CATALOG_READ_ERROR', message: (error as Error).message, locale, file }]); }
    sources.push({ file, locale, text });
  }
  const notes = await readNotes(options, read);
  // Module scopes become message ID lists before the digest, so a code change that
  // names another message regenerates the scope.
  const baseSource = sources.find(item => item.locale === options.baseLocale);
  let baseIds: string[] | undefined;
  if (baseSource) { try { baseIds = [...catalogIds(parseCatalog(baseSource.file, baseSource.text))]; } catch { /* Compilation reports it. */ } }
  const scoped = await resolveModuleScopes({ ...options, root }, baseIds);
  // Development loaders of computed scopes check reads, since the crawl can miss a message.
  const resolved = { ...options, scopes: scoped.scopes, ...(scoped.computed.length ? { checkedScopes: scoped.computed } : {}) };
  // The digest covers what decides the output. The cache setting does not, so
  // enabling or disabling the artifact cache keeps the same manifest.
  const { persistentCache, text, ...compilerOptions } = resolved;
  const inputs = await inputDigest({ ...compilerOptions, ...(notes ? { notes } : {}) }, sources.map(({ file, text }) => ({ name: file.slice(input.length + 1), text })), options.outDir ?? 'src/i18n',
    ignored.map(item => (item.file ?? '').slice(input.length + 1)));
  // Only stateless generation trusts the manifest. A watch session restores
  // its memory of the previous output instead.
  if (inputs && !output) {
    const restored = await verifiedOutput(outDir, inputs);
    if (restored) return { ...restored, catalogFiles, scopeFiles: scoped.files, changed: [], outDir };
  }
  // The cache is a shortcut around compilation. A stored project is written
  // through the same output path, so missing or modified files are restored.
  const key = inputs?.digest;
  let stored: CompiledProject | undefined;
  if (cacheFile && key) { try { stored = await restoreCache(cacheFile, key); } catch { /* An unavailable cache must not prevent normal generation. */ } }
  const catalogs: Record<string, Catalog> = Object.create(null);
  const catalogSources = new Map<string, CatalogSource>();
  const duplicates: Diagnostic[] = [];
  let source: {file:string;text:string} | undefined;
  for (const { file, locale, text } of sources) {
    catalogSources.set(locale, { file, text });
    try {
      catalogs[locale] = parseCatalog(file, text);
      if(locale===options.baseLocale)source={file,text};
    }
    catch (error) { throw invalidJson(error as Error, locale, { file, text }); }
    duplicates.push(...duplicateKeyDiagnostics({ file, text }, locale, catalogs[locale]));
  }
  // Repeated keys are reported for every file before compilation starts.
  if (duplicates.length) throw new CompileError(duplicates);
  let project: CompiledProject;
  if (stored) project = stored;
  else {
    const { notes: _file, ...rest } = resolved;
    try { project = compile({ ...rest, catalogs, ...(notes ? { notes } : {}) }); }
    catch (error) { if (error instanceof CompileError) throw locateCompileError(error, catalogSources); throw error; }
  }
  catalogSources.clear();
  if (source && !stored && options.artifacts !== 'runtime' && options.artifacts !== 'loader') attachDeclarationMaps(project, source, outDir, declarationMaps);
  project = markProject(project, !!options.development, root, input);
  // Source-level warnings are added after caching so a restored project never repeats them.
  const warnings = [...project.warnings, ...ignored, ...thenableWarnings(catalogs, options.baseLocale),
    ...unknownNotes(notes, new Set(project.groups['index.js']), notesFile(options)), ...scoped.warnings];
  const record = inputs && { inputs, project: { locales: project.locales, groups: project.groups, warnings } };
  const changed = await writeOutput(project, outDir, output, record || undefined);
  if (!stored && cacheFile && key) {
    const encoded = encodeCache(project, key);
    if (encoded) await atomicWrite(cacheFile, encoded).catch(() => undefined);
  }
  return { ...project, warnings, catalogFiles, scopeFiles: scoped.files, changed, outDir };
}
