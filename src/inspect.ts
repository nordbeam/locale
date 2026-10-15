import { hash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Diagnostic } from './compiler.js';
import { describeMessageContract } from './contracts.js';
import type { ContractArgumentKind } from './contracts.js';
import { inputDigest } from './persistent-cache.js';
import { readNotes } from './notes.js';
import type { InputDigest } from './persistent-cache.js';
import { check, discoverCatalogs, readOutputManifest } from './project.js';
import type { GenerateOptions } from './project.js';

export interface InspectCatalog {
  readonly locale: string;
  readonly file: string;
  readonly messageCount: number;
  readonly translatedCount: number;
  /** Base-locale IDs that are missing from this catalog or blank in it. */
  readonly untranslatedCount: number;
  /** Base-locale IDs with no entry in this catalog. */
  readonly missingCount: number;
  readonly bytes: number;
}

export interface InspectGeneratedOutput {
  readonly directory: string;
  readonly manifest: string;
  readonly exists: boolean;
  readonly manifestExists: boolean;
  readonly manifestValid: boolean;
  readonly ownedFiles: readonly string[];
  readonly presentFiles: readonly string[];
  readonly missingFiles: readonly string[];
  /** Ownership-manifest completeness. Use `freshness` for content and input checks. */
  readonly status: 'missing' | 'invalid' | 'incomplete' | 'complete';
}

/** Whether the generated files still match what the last generation produced. */
export type InspectFreshnessStatus = 'fresh' | 'stale' | 'modified' | 'missing' | 'unknown';

export interface InspectFreshnessItem {
  /** A catalog file name, `options`, `compiler` or `listing` for stale reasons; an output path for modified files. */
  readonly input: string;
  readonly message: string;
  readonly next: string;
}

export interface InspectFreshness {
  readonly status: InspectFreshnessStatus;
  /** Inputs that changed since the last generation, for example a catalog edit. */
  readonly staleReason: readonly InspectFreshnessItem[];
  /** Generated files whose content differs from the manifest, for example a hand edit. */
  readonly modifiedFiles: readonly InspectFreshnessItem[];
  /** The command that brings the output back in line. Absent when the output is fresh. */
  readonly next?: string;
}

export interface InspectFrameworkIntegration {
  readonly kind: 'next' | 'vite-react';
  readonly detected: boolean;
  readonly configured: boolean;
  readonly packageDependency: boolean;
  readonly files: readonly string[];
}

export interface InspectResult {
  readonly ok: boolean;
  readonly config: Record<string, unknown>;
  readonly locales: readonly string[];
  readonly catalogs: readonly InspectCatalog[];
  readonly catalogCount: number;
  readonly messageCount: number;
  readonly generated: InspectGeneratedOutput;
  readonly freshness: InspectFreshness;
  readonly integrations: readonly InspectFrameworkIntegration[];
  /** Alias retained for callers that name this section explicitly. */
  readonly frameworkIntegrations: readonly InspectFrameworkIntegration[];
  readonly diagnostics: { errors: readonly Diagnostic[]; warnings: readonly Diagnostic[] };
}

export interface InspectMessageLocale {
  readonly locale: string;
  readonly file: string;
  /** Whether the catalog has an entry for the ID. */
  readonly present: boolean;
  /** Present with blank text: untranslated, though the key exists. */
  readonly blank: boolean;
  /** 1-based position of the entry's value in the catalog file. Absent when not present. */
  readonly line?: number;
  readonly column?: number;
  readonly source?: string;
}

export interface InspectMessageResult {
  readonly id: string;
  readonly found: boolean;
  readonly baseLocale: string;
  /** Locales whose catalog has an entry for the ID, blank entries included. */
  readonly present: readonly string[];
  /** Locales whose catalog has no entry for the ID. */
  readonly missing: readonly string[];
  /** Locales whose entry is missing or blank. */
  readonly untranslated: readonly string[];
  /** Arguments from the base-locale source, or the first locale that has one. */
  readonly arguments: readonly { readonly name: string; readonly type: ContractArgumentKind; readonly choices: readonly string[] }[];
  /** Set when the source cannot be parsed, so arguments are unknown. */
  readonly argumentsError?: string;
  /** Access expression on the default export of the generated messages module. */
  readonly export: string;
  readonly locales: readonly InspectMessageLocale[];
}

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const sha1 = (value: string) => hash('sha1', value);
const outputMarker = '.nordbeam-locale-manifest.json';
const next = 'nordbeam-locale';

/** Flatten a parsed catalog into dotted message IDs, as the compiler does. */
function flatten(node: unknown, prefix = '', out = new Map<string, string>()): Map<string, string> {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return out;
  for (const [name, child] of Object.entries(node as Record<string, unknown>)) {
    const id = prefix ? `${prefix}.${name}` : name;
    if (typeof child === 'string') out.set(id, child);
    else flatten(child, id, out);
  }
  return out;
}

/** Offsets of each string value's opening quote, keyed by dotted ID. The text must already be valid JSON. */
function valueOffsets(text: string): Map<string, number> {
  const offsets = new Map<string, number>();
  const prefixes = [''];
  const colon = /\s*:/y;
  let key: string | undefined;
  for (const match of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\],:]|[^\s{}[\],:"]+/g)) {
    const token = match[0];
    if (token === '{') { prefixes.push(key === undefined ? prefixes.at(-1)! : join(prefixes.at(-1)!, key)); key = undefined; }
    else if (token === '}') { prefixes.pop(); key = undefined; }
    else if (token.startsWith('"')) {
      colon.lastIndex = match.index + token.length;
      if (colon.test(text)) key = JSON.parse(token) as string;
      else {
        const id = join(prefixes.at(-1)!, key ?? '');
        if (!offsets.has(id)) offsets.set(id, match.index);
        key = undefined;
      }
    }
  }
  return offsets;
}

const join = (prefix: string, name: string) => prefix ? `${prefix}.${name}` : name;

function positionOf(text: string, offset: number): { line: number; column: number } {
  let line = 1, lineStart = 0;
  for (let index = text.indexOf('\n'); index !== -1 && index < offset; index = text.indexOf('\n', index + 1)) { line++; lineStart = index + 1; }
  return { line, column: offset - lineStart + 1 };
}

function countMessages(value: unknown): { messageCount: number; translatedCount: number } {
  let messageCount = 0, translatedCount = 0;
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    for (const child of Object.values(node as Record<string, unknown>)) {
      if (typeof child === 'string') {
        messageCount++;
        if (child.trim()) translatedCount++;
      } else visit(child);
    }
  };
  visit(value);
  return { messageCount, translatedCount };
}

async function optionalFile(root: string, candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    const file = resolve(root, candidate);
    try {
      const stat = await lstat(file);
      if (stat.isFile()) return file;
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  return undefined;
}

async function fileText(file: string | undefined): Promise<string> {
  if (!file) return '';
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (missing(error)) return ''; throw error; }
}

interface ManifestRecord { version?: unknown; files?: unknown; inputs?: InputDigest; outputs?: Record<string, { hash?: unknown }> }

async function generatedOutput(root: string, outDir: string): Promise<{ output: InspectGeneratedOutput; record?: ManifestRecord }> {
  const directory = resolve(root, outDir);
  let exists = false;
  try { exists = (await lstat(directory)).isDirectory(); } catch (error) { if (!missing(error)) throw error; }
  let manifest = resolve(directory, outputMarker), manifestExists = false, manifestValid = false, ownedFiles: string[] = [];
  let record: ManifestRecord | undefined;
  try {
    // A manifest from an earlier release still proves ownership until the next generate renames it.
    const found = await readOutputManifest(directory);
    if (found) {
      manifest = found.file;
      manifestExists = true;
      const value = JSON.parse(found.text) as ManifestRecord;
      if (value.version === 1 && Array.isArray(value.files) && value.files.every(file => typeof file === 'string')) {
        ownedFiles = [...value.files].sort(compare);
        manifestValid = true;
        record = value;
      }
    }
  } catch (error) {
    if (!missing(error) && (error as SyntaxError).name !== 'SyntaxError') throw error;
  }
  const presentFiles: string[] = [], missingFiles: string[] = [];
  if (manifestValid) for (const name of ownedFiles) {
    // The manifest is compiler-owned metadata. Avoid treating an absolute or
    // traversal path as a valid output claim while inspecting untrusted data.
    const candidate = resolve(directory, name);
    const path = relative(directory, candidate);
    if (isAbsolute(name) || path === '..' || path.startsWith('../') || path.includes(`..${requireSeparator()}`)) { missingFiles.push(name); continue; }
    try {
      if ((await lstat(candidate)).isFile()) presentFiles.push(name); else missingFiles.push(name);
    } catch (error) { if (missing(error)) missingFiles.push(name); else throw error; }
  }
  const status = !exists || !manifestExists ? 'missing' : !manifestValid ? 'invalid' : missingFiles.length ? 'incomplete' : 'complete';
  return { output: { directory, manifest, exists, manifestExists, manifestValid, ownedFiles, presentFiles, missingFiles, status }, record };
}

// Keep path validation platform-neutral without importing a second path
// separator constant into the public result logic.
function requireSeparator(): string { return process.platform === 'win32' ? '\\' : '/'; }

/** Compare the recorded inputs with the current ones. Names the catalogs,
 * options or compiler that changed; an empty list means the inputs match. */
function staleReasons(recorded: InputDigest, current: InputDigest): InspectFreshnessItem[] {
  const reasons: InspectFreshnessItem[] = [];
  const reason = (input: string, message: string) => reasons.push({ input, message, next });
  if (recorded.compiler !== current.compiler) reason('compiler', 'the compiler changed since the last generation');
  if (recorded.options !== current.options) reason('options', 'generation options changed since the last generation');
  if (JSON.stringify(recorded.ignored) !== JSON.stringify(current.ignored)) reason('listing', 'catalog files were added or removed');
  const names = [...new Set([...Object.keys(recorded.catalogs), ...Object.keys(current.catalogs)])].sort(compare);
  for (const name of names) {
    if (!(name in recorded.catalogs)) reason(name, `catalog ${name} was added`);
    else if (!(name in current.catalogs)) reason(name, `catalog ${name} was removed`);
    else if (recorded.catalogs[name] !== current.catalogs[name]) reason(name, `catalog ${name} changed`);
  }
  if (!reasons.length && recorded.digest !== current.digest) reason('inputs', 'inputs changed since the last generation');
  return reasons;
}

async function outputFreshness(generated: InspectGeneratedOutput, record: ManifestRecord | undefined, current: InputDigest | undefined): Promise<InspectFreshness> {
  const outputs = record?.outputs;
  const modifiedFiles: InspectFreshnessItem[] = [];
  if (outputs) for (const name of generated.presentFiles) {
    const expected = outputs[name]?.hash;
    if (typeof expected !== 'string') continue;
    if (sha1(await readFile(resolve(generated.directory, name), 'utf8')) !== expected) modifiedFiles.push({ input: name, message: `${name} differs from the last generation`, next });
  }
  const recorded = record?.inputs;
  const staleReason = recorded && current ? staleReasons(recorded, current) : [];
  let status: InspectFreshnessStatus;
  if (!generated.exists || !generated.manifestExists || generated.missingFiles.length) status = 'missing';
  else if (!recorded || !outputs || !current) status = 'unknown';
  else if (staleReason.length) status = 'stale';
  else if (modifiedFiles.length) status = 'modified';
  else status = 'fresh';
  return { status, staleReason, modifiedFiles, ...(status === 'fresh' ? {} : { next }) };
}

async function frameworkIntegrations(root: string, outDir: string): Promise<InspectFrameworkIntegration[]> {
  const packageFile = await optionalFile(root, ['package.json']);
  let dependencies = new Set<string>();
  if (packageFile) {
    try {
      const packageJson = JSON.parse(await readFile(packageFile, 'utf8')) as Record<string, unknown>;
      dependencies = new Set([
        ...Object.keys((packageJson.dependencies ?? {}) as object),
        ...Object.keys((packageJson.devDependencies ?? {}) as object),
        ...Object.keys((packageJson.peerDependencies ?? {}) as object),
      ]);
    } catch { /* package metadata is advisory; diagnostics belong to config/catalog checks. */ }
  }
  const nextFile = await optionalFile(root, ['next.config.mjs', 'next.config.js', 'next.config.ts']);
  const viteFile = await optionalFile(root, ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']);
  const nextAdapters = (await Promise.all(['next.ts', 'client.ts', 'provider.ts'].map(file => optionalFile(resolve(root, outDir), [file])))).filter((file): file is string => !!file);
  const viteAdapters = (await Promise.all(['client.ts'].map(file => optionalFile(resolve(root, outDir), [file])))).filter((file): file is string => !!file);
  const nextText = await fileText(nextFile), viteText = await fileText(viteFile);
  // Accept the current and the earlier API names, so configs written before the rename still count as configured.
  const nextConfigured = /withNordbeam(?:Locale|I18n)\s*\(/.test(nextText);
  const viteConfigured = /nordbeam(?:Locale|I18n)\s*\(/.test(viteText);
  const nextDependency = dependencies.has('next');
  const viteDependency = dependencies.has('vite');
  return [
    { kind: 'next', detected: nextDependency || !!nextFile || nextConfigured || nextAdapters.length > 0, configured: nextConfigured, packageDependency: nextDependency, files: [nextFile, ...nextAdapters].filter((file, index, all): file is string => !!file && all.indexOf(file) === index) },
    { kind: 'vite-react', detected: viteDependency || !!viteFile || viteConfigured || viteAdapters.length > 0, configured: viteConfigured, packageDependency: viteDependency, files: [viteFile, ...viteAdapters].filter((file, index, all): file is string => !!file && all.indexOf(file) === index) },
  ];
}

/** Return a complete project snapshot without compiling or writing output. */
export async function inspectProject(options: GenerateOptions, configFile: string, loaded?: Partial<GenerateOptions>): Promise<InspectResult> {
  const root = resolve(options.root ?? '.');
  const checked = await check(options);
  const input = resolve(root, options.catalogs ?? 'messages');
  const baseLocale = options.baseLocale ?? 'en';
  const texts = new Map<string, string>();
  for (const file of checked.catalogFiles) {
    try { texts.set(file, await readFile(file, 'utf8')); }
    catch { /* check() already reports this failure in diagnostics. */ }
  }
  const parsed = new Map<string, { file: string; text: string; value: unknown }>();
  for (const [file, text] of texts) {
    try { parsed.set(file, { file, text, value: JSON.parse(text) as unknown }); }
    catch { /* check() already reports this failure in diagnostics. */ }
  }
  const baseFile = [...parsed.values()].find(item => item.file.slice(input.length + 1, -5) === baseLocale);
  const base = flatten(baseFile?.value);
  const catalogs: InspectCatalog[] = [];
  for (const { file, text, value } of [...parsed.values()].sort((a, b) => compare(a.file, b.file))) {
    const locale = file.slice(input.length + 1, -5);
    const flat = flatten(value);
    const counts = countMessages(value);
    let missingCount = 0, untranslatedCount = 0;
    // Judge completeness against the base locale: a key absent from this
    // catalog is untranslated even though this catalog never lists it.
    for (const id of base.keys()) {
      const entry = flat.get(id);
      if (entry === undefined) { missingCount++; untranslatedCount++; }
      else if (!entry.trim()) untranslatedCount++;
    }
    catalogs.push({ locale, file, ...counts, missingCount, untranslatedCount, bytes: Buffer.byteLength(text) });
  }
  const generatedResult = await generatedOutput(root, options.outDir ?? 'src/i18n');
  const generated = generatedResult.output;
  const integrations = await frameworkIntegrations(root, options.outDir ?? 'src/i18n');
  // The same options and catalog bytes that generate() hashes, so a match means
  // the recorded output is what these inputs would produce.
  const { persistentCache, ...compilerOptions } = options;
  const notes = await readNotes(options).catch(() => undefined);
  const ignored = checked.warnings.filter(warning => warning.code === 'IGNORED_CATALOG_FILE').map(warning => (warning.file ?? '').slice(input.length + 1));
  const current = await inputDigest({ ...compilerOptions, ...(notes ? { notes } : {}) }, [...texts].map(([file, text]) => ({ name: file.slice(input.length + 1), text })), options.outDir ?? 'src/i18n', ignored);
  const freshness = await outputFreshness(generated, generatedResult.record, current);
  const config = {
    file: resolve(configFile),
    root,
    ...(loaded ?? {}),
    baseLocale,
    catalogs: options.catalogs ?? 'messages',
    outDir: options.outDir ?? 'src/i18n',
  } as Record<string, unknown>;
  return {
    ok: checked.ok,
    config,
    locales: checked.locales,
    catalogs,
    catalogCount: catalogs.length,
    messageCount: checked.messageCount,
    generated,
    freshness,
    integrations,
    frameworkIntegrations: integrations,
    diagnostics: { errors: checked.errors, warnings: checked.warnings },
  };
}

/** Message IDs of the base catalog, for did-you-mean suggestions. Empty when the catalog cannot be read. */
export async function baseMessageIds(options: GenerateOptions): Promise<string[]> {
  const file = resolve(options.root ?? '.', options.catalogs ?? 'messages', `${options.baseLocale ?? 'en'}.json`);
  try { return [...flatten(JSON.parse(await readFile(file, 'utf8'))).keys()]; }
  catch { return []; }
}

/** Describe one message across all catalogs: which locales have it, its
 * arguments, each locale's source text and where that entry sits in its file. */
export async function inspectMessage(options: GenerateOptions, id: string): Promise<InspectMessageResult> {
  const root = resolve(options.root ?? '.');
  const input = resolve(root, options.catalogs ?? 'messages');
  const baseLocale = options.baseLocale ?? 'en';
  // An unreadable catalog directory is reported by check(); this query then has no locales.
  const files = await discoverCatalogs(input).then(found => found.files, () => [] as string[]);
  const locales: InspectMessageLocale[] = [];
  for (const file of files) {
    const locale = file.slice(input.length + 1, -5);
    let text: string, value: unknown;
    try { text = await readFile(file, 'utf8'); value = JSON.parse(text); }
    catch { /* check() already reports unreadable or invalid catalogs. */ continue; }
    const entry = flatten(value).get(id);
    const offset = valueOffsets(text).get(id);
    const position = offset === undefined ? undefined : positionOf(text, offset);
    locales.push({
      locale, file, present: entry !== undefined, blank: entry !== undefined && !entry.trim(),
      ...(entry === undefined ? {} : { source: entry, line: position!.line, column: position!.column }),
    });
  }
  const sourced = locales.find(item => item.locale === baseLocale && item.source !== undefined) ?? locales.find(item => item.source !== undefined);
  let argumentsList: InspectMessageResult['arguments'] = [], argumentsError: string | undefined;
  if (sourced) {
    try {
      const contract = describeMessageContract(sourced.source!, id);
      argumentsList = Object.entries(contract.arguments).map(([name, argument]) => ({ name, type: argument.kind, choices: [...argument.choices] }));
    } catch (error) { argumentsError = (error as Error).message; }
  }
  const presentLocales = locales.filter(item => item.present).map(item => item.locale);
  const missingLocales = locales.filter(item => !item.present).map(item => item.locale);
  const untranslatedLocales = locales.filter(item => !item.present || item.blank).map(item => item.locale);
  return {
    id,
    found: presentLocales.length > 0,
    baseLocale,
    present: presentLocales,
    missing: missingLocales,
    untranslated: untranslatedLocales,
    arguments: argumentsList,
    ...(argumentsError === undefined ? {} : { argumentsError }),
    export: `messages[${JSON.stringify(id)}]`,
    locales,
  };
}
