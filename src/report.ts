import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { sourceUsage } from './cli-tools.js';
import { CompileError, compileProject } from './compiler.js';
import type { Catalog, CompiledProject, Diagnostic } from './compiler.js';
import { describeCatalog } from './contracts.js';
import type { MessageContract } from './contracts.js';
import { inspectProject } from './inspect.js';
import { coreVersion } from './migrate-loader.js';
import { readNotes } from './notes.js';
import type { Notes } from './notes.js';
import type { GenerateOptions } from './project.js';
import { isModuleScope, resolveModuleScopes, sourceMessageIds, staticScopes } from './scope-modules.js';

/** Bytes of one generated module, before the application's bundler. */
export interface ReportSize {
  readonly raw: number;
  readonly gzip: number;
  readonly brotli: number;
}

/** How a locale holds one base message. `same` is text identical to the base text. */
export type ReportMessageStatus = 'translated' | 'same' | 'blank' | 'missing';

export interface ReportLocale {
  readonly locale: string;
  readonly base: boolean;
  /** Project-relative catalog file. */
  readonly file: string;
  /** Base messages with their own text in this catalog. */
  readonly translated: number;
  /** Base messages whose text equals the base text: often copied, sometimes intended (names, codes). */
  readonly same: number;
  readonly blank: number;
  readonly missing: number;
  /** Entries the base catalog lacks. */
  readonly extra: number;
  /** Share of base messages with text in this catalog, `same` included. */
  readonly coverage: number;
  readonly catalogBytes: number;
  /** The generated module that `loadLocale` downloads for this locale. Absent when the project does not compile. */
  readonly module?: ReportSize;
}

export interface ReportScope {
  readonly name: string;
  /** `modules` scopes are computed from source files; `messages` scopes list IDs and patterns. */
  readonly kind: 'messages' | 'modules';
  readonly messages: number;
  /** Share of the base catalog. */
  readonly share: number;
  /** Configured `modules` globs of a computed scope. */
  readonly modules?: readonly string[];
  /** The scope's generated module per locale. */
  readonly sizes?: Readonly<Record<string, ReportSize>>;
}

export interface ReportNamespace {
  /** Dotted ID prefix, or an empty string for top-level messages. */
  readonly name: string;
  readonly messages: number;
  readonly unused: number;
  /** Missing or blank translations summed over the other locales. */
  readonly untranslated: number;
  readonly children: readonly ReportNamespace[];
}

export interface ReportFeatures {
  readonly plain: number;
  readonly arguments: number;
  readonly plural: number;
  readonly ordinal: number;
  readonly select: number;
  readonly number: number;
  readonly date: number;
  readonly tags: number;
}

export type ReportFeature = Exclude<keyof ReportFeatures, 'plain'>;

export interface ReportMessage {
  readonly id: string;
  /** Base-locale text, shortened past 240 characters. */
  readonly text: string;
  readonly length: number;
  readonly features: readonly ReportFeature[];
  /** Status in every locale except the base locale. */
  readonly status: Readonly<Record<string, ReportMessageStatus>>;
  /** Project-relative source files that reference the message. */
  readonly files: readonly string[];
  readonly scopes: readonly string[];
  readonly note?: string;
}

export interface ReportDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly locale?: string;
  readonly messageId?: string;
  readonly file?: string;
  readonly line?: number;
  readonly hint?: string;
}

export interface ReportUsage {
  readonly sourceFiles: number;
  /** Base messages that a source file references. */
  readonly used: number;
  /** Base messages that no scanned source file references. Empty when no source file was found. */
  readonly unused: readonly string[];
  readonly topFiles: readonly { readonly file: string; readonly messages: number }[];
  /** References to message IDs the base catalog lacks. */
  readonly unknown: readonly ReportDiagnostic[];
  /** Files left out of usage because they name most of the catalog, such as an old dictionary. */
  readonly copies: readonly { readonly file: string; readonly messages: number }[];
}

export interface ReportHardcoded {
  /** False when the optional text scanner (oxc-parser) is not installed; `reason` says so. */
  readonly available: boolean;
  readonly reason?: string;
  /** High-confidence findings: UI text in source that is not a catalog message. */
  readonly high: number;
  /** Findings that read like UI text but may not be; hardcoded --confidence medium lists them. */
  readonly medium: number;
  /** High-confidence findings whose text is already a catalog message, which hardcoded --fix can reuse. */
  readonly inCatalog: number;
  readonly files: number;
  /** Of those files, the ones that already render catalog messages. */
  readonly mixedFiles: number;
  readonly areas: readonly { readonly area: string; readonly findings: number; readonly files: number }[];
  readonly topFiles: readonly { readonly file: string; readonly findings: number; readonly mixed: boolean }[];
  /** Up to 200 high-confidence findings, from the files with the most. */
  readonly samples: readonly { readonly file: string; readonly line: number; readonly text: string; readonly where: string; readonly catalog?: string }[];
}

export interface ReportSummary {
  readonly messages: number;
  readonly locales: number;
  /** Mean coverage of the locales other than the base locale; 1 without other locales. */
  readonly coverage: number;
  /** Missing or blank translations summed over the other locales. */
  readonly untranslated: number;
  readonly unused: number;
  readonly sourceFiles: number;
  readonly errors: number;
  readonly warnings: number;
  readonly notes: number;
  /** The base locale's generated catalog module. */
  readonly catalog?: ReportSize;
  /** Whether the generated output matches the catalogs, as `inspect` reports it. */
  readonly freshness: string;
}

export interface ProjectReport {
  readonly reportVersion: 1;
  readonly generatedAt: string;
  readonly tool: { readonly name: 'nordbeam-locale'; readonly version: string };
  readonly project: {
    readonly name?: string;
    readonly root: string;
    readonly baseLocale: string;
    readonly catalogs: string;
    readonly outDir: string;
    readonly frameworks: readonly string[];
  };
  readonly summary: ReportSummary;
  readonly locales: readonly ReportLocale[];
  readonly scopes: readonly ReportScope[];
  readonly namespaces: readonly ReportNamespace[];
  readonly features: ReportFeatures;
  readonly usage: ReportUsage;
  readonly hardcoded: ReportHardcoded;
  /** Generated sizes need a project that compiles; `reason` says why they are missing. */
  readonly sizes: { readonly available: boolean; readonly reason?: string; readonly shared?: ReportSize };
  readonly diagnostics: { readonly errors: readonly ReportDiagnostic[]; readonly warnings: readonly ReportDiagnostic[] };
  readonly messages: readonly ReportMessage[];
}

export interface BuildReportOptions extends GenerateOptions {
  /** Source directory to scan for message references. Default: the usual application roots, as doctor scans them. */
  sourceDir?: string;
}

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const frameworkPackages = ['next', '@tanstack/react-start', 'vite', 'react', 'vue', 'svelte', 'solid-js'];
const featureOrder: readonly ReportFeature[] = ['plural', 'ordinal', 'select', 'number', 'date', 'tags', 'arguments'];

function flatten(node: unknown, prefix = '', out = new Map<string, string>()): Map<string, string> {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return out;
  for (const [name, child] of Object.entries(node as Record<string, unknown>)) {
    const id = prefix ? `${prefix}.${name}` : name;
    if (typeof child === 'string') out.set(id, child);
    else flatten(child, id, out);
  }
  return out;
}

function size(text: string): ReportSize {
  const buffer = Buffer.from(text);
  return {
    raw: buffer.length,
    gzip: gzipSync(buffer, { level: 9 }).length,
    brotli: brotliCompressSync(buffer, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: buffer.length } }).length,
  };
}

/** Identical text counts as copied only when it has words: "{count}" or "—" are the same in every locale. */
function wordy(text: string): boolean {
  return /\p{L}{2,}/u.test(text.replace(/\{[^{}]*\}/g, ''));
}

function features(contract: MessageContract | undefined): ReportFeature[] {
  if (!contract) return [];
  const found = new Set<ReportFeature>();
  const plural = new Set<string>();
  for (const branch of contract.branches) {
    if (branch.kind === 'select') found.add('select');
    else { plural.add(branch.argument); found.add(branch.pluralType === 'ordinal' ? 'ordinal' : 'plural'); }
  }
  for (const [name, argument] of Object.entries(contract.arguments)) {
    if (argument.kind === 'date') found.add('date');
    else if (argument.kind === 'number' && !plural.has(name)) found.add('number');
    else if (argument.kind === 'slot') found.add('tags');
  }
  if (contract.slots.length) found.add('tags');
  if (Object.keys(contract.arguments).length || contract.slots.length) found.add('arguments');
  return featureOrder.filter(feature => found.has(feature));
}

function contracts(baseLocale: string, catalog: Catalog | undefined, base: Map<string, string>): Map<string, MessageContract> {
  const result = new Map<string, MessageContract>();
  if (!catalog) return result;
  try {
    for (const [id, contract] of Object.entries(describeCatalog({ catalogs: { [baseLocale]: catalog }, baseLocale }).contracts)) result.set(id, contract);
  } catch {
    // One invalid message fails the whole description; describe the rest one by one.
    for (const [id, text] of base) {
      try { const [contract] = describeCatalog({ catalog: { [id]: text } }).messages; if (contract) result.set(id, contract); }
      catch { /* check reports the invalid message. */ }
    }
  }
  return result;
}

function matches(id: string, pattern: string): boolean {
  if (pattern.endsWith('.*')) return id.startsWith(pattern.slice(0, -1));
  if (pattern.endsWith('*')) return id.startsWith(pattern.slice(0, -1));
  return id === pattern;
}

/** Group IDs by their first two dotted segments, keeping catalog order. */
function namespaces(ids: readonly string[], unused: ReadonlySet<string>, untranslated: ReadonlyMap<string, number>): ReportNamespace[] {
  interface Node { name: string; messages: number; unused: number; untranslated: number; children: Map<string, Node> }
  const node = (name: string): Node => ({ name, messages: 0, unused: 0, untranslated: 0, children: new Map() });
  const top = new Map<string, Node>();
  const add = (target: Node, id: string): void => { target.messages++; if (unused.has(id)) target.unused++; target.untranslated += untranslated.get(id) ?? 0; };
  for (const id of ids) {
    const parts = id.split('.');
    const name = parts.length > 1 ? parts[0]! : '';
    let first = top.get(name);
    if (!first) top.set(name, first = node(name));
    add(first, id);
    if (parts.length > 2) {
      const childName = `${parts[0]}.${parts[1]}`;
      let child = first.children.get(childName);
      if (!child) first.children.set(childName, child = node(childName));
      add(child, id);
    }
  }
  const freeze = (item: Node): ReportNamespace => ({ name: item.name, messages: item.messages, unused: item.unused, untranslated: item.untranslated,
    children: [...item.children.values()].sort((a, b) => b.messages - a.messages || compare(a.name, b.name)).map(freeze) });
  return [...top.values()].sort((a, b) => b.messages - a.messages || compare(a.name, b.name)).map(freeze);
}

async function packageInfo(root: string): Promise<{ name?: string; frameworks: string[] }> {
  try {
    const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as { name?: unknown; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
    const dependencies = { ...manifest.devDependencies, ...manifest.dependencies };
    return { ...(typeof manifest.name === 'string' ? { name: manifest.name } : {}), frameworks: frameworkPackages.filter(name => Object.hasOwn(dependencies, name)) };
  } catch { return { frameworks: [] }; }
}

/** Analyze catalogs, translation coverage, source usage, scopes and generated sizes without writing anything. */
const noHardcoded = (reason: string): ReportHardcoded => ({ available: false, reason, high: 0, medium: 0, inCatalog: 0, files: 0, mixedFiles: 0, areas: [], topFiles: [], samples: [] });

/** UI text outside the catalog, as hardcoded reports it, for the report page. */
async function hardcodedReport(options: BuildReportOptions, path: (file: string) => string): Promise<ReportHardcoded> {
  const { scanText, textArea } = await import('./text-scan.js');
  let result;
  try { result = await scanText(options); }
  catch (error) {
    if (error instanceof CompileError && error.diagnostics[0]?.code === 'TEXT_SCANNER_UNAVAILABLE') return noHardcoded('The text scan needs the optional dependency oxc-parser. Install it with npm install --save-dev oxc-parser.');
    return noHardcoded(`The text scan failed: ${(error as Error).message.split('\n')[0]}`);
  }
  const high = result.findings.filter(finding => finding.confidence === 'high');
  const byFile = new Map<string, typeof high>();
  for (const finding of high) { let list = byFile.get(finding.file); if (!list) byFile.set(finding.file, list = []); list.push(finding); }
  const areas = new Map<string, { findings: number; files: Set<string> }>();
  for (const finding of high) {
    const key = textArea(result.root, finding.file);
    let area = areas.get(key);
    if (!area) areas.set(key, area = { findings: 0, files: new Set() });
    area.findings++; area.files.add(finding.file);
  }
  const files = [...byFile].sort((a, b) => b[1].length - a[1].length || compare(a[0], b[0]));
  const samples: ReportHardcoded['samples'][number][] = [];
  // Breadth first: a few from each file, so one long page does not fill the list.
  for (let round = 0; samples.length < 200 && round < 50; round++) {
    let added = false;
    for (const [, list] of files) {
      const finding = list[round];
      if (!finding || samples.length >= 200) continue;
      added = true;
      samples.push({ file: path(finding.file), line: finding.line, text: finding.text.length > 160 ? `${finding.text.slice(0, 159)}…` : finding.text, where: finding.where, ...(finding.catalog?.exact ? { catalog: finding.catalog.id } : {}) });
    }
    if (!added) break;
  }
  return {
    available: true, high: high.length, medium: result.findings.length - high.length, inCatalog: high.filter(finding => finding.catalog?.exact).length,
    files: byFile.size, mixedFiles: files.filter(([, list]) => list[0]!.context === 'mixed').length,
    areas: [...areas].sort((a, b) => b[1].findings - a[1].findings || compare(a[0], b[0])).slice(0, 12).map(([area, item]) => ({ area, findings: item.findings, files: item.files.size })),
    topFiles: files.slice(0, 10).map(([file, list]) => ({ file: path(file), findings: list.length, mixed: list[0]!.context === 'mixed' })),
    samples: samples.sort((a, b) => compare(a.file, b.file) || a.line - b.line),
  };
}

export async function buildReport(options: BuildReportOptions, configFile: string, loaded?: Partial<GenerateOptions>): Promise<ProjectReport> {
  const root = resolve(options.root ?? '.');
  const path = (file: string): string => {
    const local = relative(root, file);
    return (local && !local.startsWith('..') && !isAbsolute(local) ? local : file).split(sep).join('/');
  };
  const diagnostic = (item: Diagnostic): ReportDiagnostic => ({
    code: item.code, message: item.message,
    ...(item.locale ? { locale: item.locale } : {}), ...(item.messageId ? { messageId: item.messageId } : {}),
    ...(item.file ? { file: path(item.file) } : {}), ...(item.location ? { line: item.location.line } : {}), ...(item.hint ? { hint: item.hint } : {}),
  });
  const baseLocale = options.baseLocale ?? 'en';
  const inspected = await inspectProject({ ...options, root }, configFile, loaded);

  const catalogs: Record<string, Catalog> = Object.create(null);
  const entries = new Map<string, Map<string, string>>();
  for (const item of inspected.catalogs) {
    try {
      const value = JSON.parse(await readFile(item.file, 'utf8')) as Catalog;
      catalogs[item.locale] = value;
      entries.set(item.locale, flatten(value));
    } catch { /* inspect reports unreadable catalogs. */ }
  }
  const base = entries.get(baseLocale) ?? new Map<string, string>();
  const ids = [...base.keys()];

  let notes: Notes | undefined;
  try { notes = await readNotes({ ...options, root }); } catch { /* check reports INVALID_NOTES. */ }
  const resolved = await resolveModuleScopes({ ...options, root }, base.size ? ids : undefined)
    .catch(() => ({ scopes: staticScopes(options.scopes), files: [] as string[], computed: [] as string[] }));

  // Compile in memory, as a production build would, to measure what ships.
  let project: CompiledProject | undefined, reason: string | undefined;
  if (!base.size) reason = `No messages in the base locale ${JSON.stringify(baseLocale)}.`;
  else {
    try {
      const { root: _root, outDir: _outDir, catalogs: _catalogs, notes: _notes, scopes: _scopes, cache: _cache, persistentCache: _persistentCache, sourceDir: _sourceDir, text: _text, ...compilerOptions } = options;
      project = compileProject({ ...compilerOptions, baseLocale, catalogs, development: false,
        ...(resolved.scopes ? { scopes: resolved.scopes } : {}), ...(resolved.computed.length ? { checkedScopes: resolved.computed } : {}), ...(notes ? { notes } : {}) });
    } catch (error) {
      reason = `The project does not compile, so generated sizes are missing: ${(error as Error).message.split('\n')[0]}`;
    }
  }

  const status = new Map<string, Record<string, ReportMessageStatus>>();
  const untranslated = new Map<string, number>();
  const locales: ReportLocale[] = [];
  for (const item of inspected.catalogs) {
    const values = entries.get(item.locale);
    if (!values) continue;
    const isBase = item.locale === baseLocale;
    let translated = 0, same = 0, blank = 0, missing = 0;
    for (const [id, text] of base) {
      const value = values.get(id);
      const state: ReportMessageStatus = value === undefined ? 'missing' : !value.trim() ? 'blank' : !isBase && value === text && wordy(text) ? 'same' : 'translated';
      if (state === 'missing') missing++;
      else if (state === 'blank') blank++;
      else if (state === 'same') same++;
      else translated++;
      if (!isBase) {
        let row = status.get(id);
        if (!row) status.set(id, row = {});
        row[item.locale] = state;
        if (state === 'missing' || state === 'blank') untranslated.set(id, (untranslated.get(id) ?? 0) + 1);
      }
    }
    let extra = 0;
    for (const id of values.keys()) if (!base.has(id)) extra++;
    const module = project?.files[`internal/locales/${item.locale}.js`];
    locales.push({ locale: item.locale, base: isBase, file: path(item.file), translated, same, blank, missing, extra,
      coverage: base.size ? (translated + same) / base.size : 1, catalogBytes: item.bytes, ...(module ? { module: size(module) } : {}) });
  }
  // The base locale first, then the others by name.
  locales.sort((a, b) => Number(b.base) - Number(a.base) || compare(a.locale, b.locale));

  const scan = base.size ? await sourceUsage({ ...options, root }, ids) : { files: [], usage: new Map<string, Set<string>>(), unknown: [] };
  // doctor's scan finds calls; also count what module scopes count: string literals,
  // property chains such as m.pricing.title, and template-literal patterns. A file
  // that names most of the catalog is a copy of it, such as an old dictionary, not a use.
  const known = new Set(ids), copies: { file: string; messages: number }[] = [];
  for (const file of scan.files) {
    let code: string;
    try { code = await readFile(file, 'utf8'); } catch { continue; }
    const named = sourceMessageIds(code, ids, known);
    if (named.size >= Math.max(100, ids.length / 2)) {
      copies.push({ file: path(file), messages: named.size });
      for (const users of scan.usage.values()) users.delete(file);
      continue;
    }
    for (const id of named) {
      let users = scan.usage.get(id);
      if (!users) scan.usage.set(id, users = new Set());
      users.add(file);
    }
  }
  for (const [id, users] of scan.usage) if (!users.size) scan.usage.delete(id);
  // Without source files there is no evidence that any message is unused.
  const unused = scan.files.length ? ids.filter(id => !scan.usage.has(id)) : [];
  const unusedSet = new Set(unused);
  const perFile = new Map<string, number>();
  for (const files of scan.usage.values()) for (const file of files) perFile.set(file, (perFile.get(file) ?? 0) + 1);
  const topFiles = [...perFile].sort(([a, left], [b, right]) => right - left || compare(a, b)).slice(0, 15).map(([file, messages]) => ({ file: path(file), messages }));

  const scopeIds = new Map<string, string[]>();
  for (const [name, list] of Object.entries(resolved.scopes ?? {})) {
    const group = project?.groups[`scopes/${name}/index.js`];
    scopeIds.set(name, group ? [...group] : ids.filter(id => list.some(pattern => matches(id, pattern))));
  }
  const memberOf = new Map<string, string[]>();
  for (const [name, members] of scopeIds) for (const id of members) { const list = memberOf.get(id); if (list) list.push(name); else memberOf.set(id, [name]); }
  const scopes: ReportScope[] = [...scopeIds].sort(([a], [b]) => compare(a, b)).map(([name, members]) => {
    const configured = options.scopes?.[name];
    const sizes: Record<string, ReportSize> = {};
    for (const locale of locales) { const module = project?.files[`scopes/${name}/internal/locales/${locale.locale}.js`]; if (module) sizes[locale.locale] = size(module); }
    return {
      name, kind: isModuleScope(configured) ? 'modules' : 'messages', messages: members.length, share: ids.length ? members.length / ids.length : 0,
      ...(isModuleScope(configured) ? { modules: [...configured.modules] } : {}), ...(Object.keys(sizes).length ? { sizes } : {}),
    };
  });

  const described = contracts(baseLocale, catalogs[baseLocale], base);
  const counts = { plain: 0, arguments: 0, plural: 0, ordinal: 0, select: 0, number: 0, date: 0, tags: 0 };
  const messages: ReportMessage[] = ids.map(id => {
    const text = base.get(id)!;
    const found = features(described.get(id));
    if (!found.length) counts.plain++;
    for (const feature of found) counts[feature]++;
    const files = [...(scan.usage.get(id) ?? [])].map(path).sort(compare);
    const note = notes?.[id];
    return { id, text: text.length > 240 ? `${text.slice(0, 239)}…` : text, length: text.length, features: found, status: status.get(id) ?? {}, files,
      scopes: memberOf.get(id) ?? [], ...(note ? { note } : {}) };
  });

  const translations = locales.filter(locale => !locale.base);
  const baseModule = locales.find(locale => locale.base)?.module;
  const info = await packageInfo(root);
  const frameworks = [...new Set([...info.frameworks, ...inspected.integrations.filter(item => item.detected).map(item => item.kind)])];
  const shared = project?.files['internal/shared.js'];
  return {
    reportVersion: 1,
    generatedAt: new Date().toISOString(),
    tool: { name: 'nordbeam-locale', version: await coreVersion() },
    project: { ...(info.name ? { name: info.name } : {}), root, baseLocale, catalogs: options.catalogs ?? 'messages', outDir: options.outDir ?? 'src/i18n', frameworks },
    summary: {
      messages: ids.length,
      locales: locales.length,
      coverage: translations.length ? translations.reduce((sum, locale) => sum + locale.coverage, 0) / translations.length : 1,
      untranslated: translations.reduce((sum, locale) => sum + locale.missing + locale.blank, 0),
      unused: unused.length,
      sourceFiles: scan.files.length,
      errors: inspected.diagnostics.errors.length,
      warnings: inspected.diagnostics.warnings.length,
      notes: notes ? ids.filter(id => notes![id]).length : 0,
      ...(baseModule ? { catalog: baseModule } : {}),
      freshness: inspected.freshness.status,
    },
    locales,
    scopes,
    namespaces: namespaces(ids, unusedSet, untranslated),
    features: counts,
    usage: { sourceFiles: scan.files.length, used: scan.files.length ? ids.length - unused.length : 0, unused, topFiles, unknown: scan.unknown.map(diagnostic), copies },
    hardcoded: await hardcodedReport({ ...options, root }, path),
    sizes: { available: !!project, ...(reason ? { reason } : {}), ...(shared ? { shared: size(shared) } : {}) },
    diagnostics: { errors: inspected.diagnostics.errors.map(diagnostic), warnings: inspected.diagnostics.warnings.map(diagnostic) },
    messages,
  };
}
