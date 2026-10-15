import { chmod, lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { compileProject } from '@nordbeam/locale/internal/migrate';
import type { Catalog } from '@nordbeam/locale/internal/migrate';
import { discoverConfig, readConfig } from '@nordbeam/locale/internal/migrate';
import { initialize, planInitialize } from '@nordbeam/locale/internal/migrate';
import type { InitPlan } from '@nordbeam/locale/internal/migrate';
import type { InitFramework } from '@nordbeam/locale/internal/migrate';
import type { GenerateOptions } from '@nordbeam/locale/internal/migrate';
import { migrateCatalog } from './migrate-catalog.js';
import type { MigrationFormat } from './catalog-formats.js';
import type { MigrationResult } from './migrate-catalog.js';
import { CodemodStrictError, codemodProject, readMessageIdBySourceFile } from './codemods.js';
import type { CodemodFormat, CodemodResult, CustomTranslationCall } from './codemods.js';
import { applyNextMigration, planNextMigration } from './migrate-next.js';
import type { NextI18nFramework, NextMigrationPlan } from './migrate-next.js';
import { applyReactProject, planReactProject } from './migrate-react.js';
import type { ReactMigrationFormat, ReactProjectMigrationPlan } from './migrate-react.js';
import { applyFrameworkProject, planFrameworkProject } from './migrate-frameworks.js';
import type { FrameworkMigration, FrameworkProjectPlan } from './migrate-frameworks.js';
import { CliError } from '@nordbeam/locale/internal/migrate';

export interface ProjectMigrationOptions extends GenerateOptions {
  from: string;
  format: CodemodFormat;
  catalogFormat?: MigrationFormat;
  locale?: string;
  framework?: InitFramework;
  sourceDir?: string;
  messagesObject?: string;
  customCalls?: readonly CustomTranslationCall[];
  /** Explicit source-text -> generated-ID map, useful for Lingui catalogs
   * whose stable IDs are not derivable from the migrated catalog alone. */
  messageIdBySource?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  /** JSON file containing the same source-text -> generated-ID map. */
  messageIdBySourceFile?: string;
  write?: boolean;
  configFile?: string;
  initialLocaleExpression?: string;
  /** Additional source files or directories to inspect for migration residue.
   * Useful for monorepos where shared library code lives outside sourceDir.
   */
  auditPaths?: readonly string[];
  /** Fail before any write when a source call, integration boundary, or
   * incumbent runtime residue is not proven safe to migrate. */
  strict?: boolean;
}

export interface ProjectMigrationCatalog {
  readonly locale: string;
  readonly source: string;
  readonly destination: string;
  readonly messageCount: number;
  readonly warnings: MigrationResult['warnings'];
}

export interface ProjectMigrationResult {
  readonly ok: boolean;
  readonly dryRun: boolean;
  readonly format: CodemodFormat;
  readonly catalogFormat: MigrationFormat;
  readonly framework?: InitFramework;
  readonly catalogs: readonly ProjectMigrationCatalog[];
  readonly codemod: CodemodResult;
  readonly integration?: ProjectIntegrationResult;
  /** Project-relative paths. Preview lists what --write would create or update. */
  readonly generatedFiles: readonly string[];
  readonly scaffoldFiles: readonly string[];
  readonly configFiles: readonly string[];
  readonly packageEdits: readonly string[];
  readonly residueAudit: ProjectResidueAudit;
  readonly manualActions: readonly string[];
}

export type ProjectResidueKind = 'incumbent-runtime-import' | 'raw-catalog-dynamic-import';

export interface ProjectResidueFinding {
  readonly file: string;
  readonly line: number;
  readonly kind: ProjectResidueKind;
  readonly specifier: string;
  readonly reason: string;
}

export interface ProjectResidueAudit {
  readonly status: 'clean' | 'manual-review';
  readonly filesScanned: number;
  readonly files: readonly string[];
  readonly findings: readonly ProjectResidueFinding[];
}

export interface ProjectResidueAuditOptions {
  readonly root?: string;
  readonly paths: readonly string[];
  readonly format?: CodemodFormat;
  /** Optional planned bytes used by strict pre-write audits. The files on
   * disk remain untouched; this lets an integration plan prove that an
   * incumbent import will be removed before the transaction commits. */
  readonly contents?: ReadonlyMap<string, string>;
}

export interface ProjectIntegrationResult {
  readonly kind: 'next' | 'react' | 'framework';
  readonly filesScanned: number;
  readonly filesChanged: number;
  readonly replacements: number;
  readonly skipped: readonly { file?: string; reason: string; kind?: string }[];
}

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

const projectSourceExtensions = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.vue', '.svelte', '.html']);
const projectIgnoredDirectories = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'out', '.turbo']);

/** Return a mask with comments and quoted strings cleared. This keeps the
 * residue report focused on executable imports while retaining offsets for
 * useful line numbers. */
function projectCodeMask(text: string): Uint8Array {
  const mask = new Uint8Array(text.length);
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!, next = text[index + 1];
    if (state === 'code') {
      if (character === '/' && next === '/') { state = 'line'; index++; continue; }
      if (character === '/' && next === '*') { state = 'block'; index++; continue; }
      if (character === "'") { state = 'single'; continue; }
      if (character === '"') { state = 'double'; continue; }
      if (character === '`') { state = 'template'; continue; }
      mask[index] = 1; continue;
    }
    if (state === 'line') { if (character === '\n' || character === '\r') state = 'code'; continue; }
    if (state === 'block') { if (character === '*' && next === '/') { state = 'code'; index++; } continue; }
    if (character === '\\') { index++; continue; }
    if ((state === 'single' && character === "'") || (state === 'double' && character === '"') || (state === 'template' && character === '`')) state = 'code';
  }
  return mask;
}

function projectCodeMatches(text: string, pattern: RegExp): RegExpExecArray[] {
  const mask = projectCodeMask(text);
  return [...text.matchAll(pattern)].filter(match => typeof match.index === 'number' && !!mask[match.index]) as RegExpExecArray[];
}

function canonicalResidueFormat(format: CodemodFormat | undefined): CodemodFormat | 'all' {
  if (!format || format === 'auto') return 'all';
  if (format === 'react-i18next' || format === 'next-i18next') return 'i18next';
  if (format === 'react-intl') return 'formatjs';
  if (format === 'lingui-react') return 'lingui';
  if (format === 'tolgee-react') return 'tolgee';
  if (format === 'nuxt-i18n') return 'vue-i18n';
  return format;
}

const incumbentPackages: Record<string, readonly RegExp[]> = {
  i18next: [/^i18next(?:\/|$)/, /^react-i18next(?:\/|$)/, /^next-i18next(?:\/|$)/],
  'next-intl': [/^next-intl(?:\/|$)/],
  formatjs: [/^react-intl(?:\/|$)/, /^@formatjs\//],
  lingui: [/^@lingui\//],
  'vue-i18n': [/^vue-i18n(?:\/|$)/, /^@intlify\//, /^@nuxtjs\/i18n(?:\/|$)/],
  tolgee: [/^@tolgee\//],
  'next-international': [/^next-international(?:\/|$)/],
  'typesafe-i18n': [/^typesafe-i18n(?:\/|$)/],
  'svelte-i18n': [/^svelte-i18n(?:\/|$)/],
  transloco: [/^@jsverse\/transloco(?:\/|$)/, /^@ngneat\/transloco(?:\/|$)/],
  'ngx-translate': [/^@ngx-translate\//],
};

function incumbentSpecifier(specifier: string, format: CodemodFormat | undefined): boolean {
  const selected = canonicalResidueFormat(format);
  const groups = selected === 'all' ? Object.values(incumbentPackages) : [incumbentPackages[selected] ?? []];
  return groups.some(patterns => patterns.some(pattern => pattern.test(specifier)));
}

function rawCatalogSpecifier(specifier: string): boolean {
  const lower = specifier.toLowerCase();
  if (!/\.json(?:[?#].*)?$/.test(lower)) return false;
  return /(?:^|[\\/_.-])(?:locale|locales|messages?|translations?|catalogs?)(?:[\\/_.-]|$)/.test(lower)
    || /\$\{[^}]*locale/i.test(specifier);
}

function hasRuntimeImportClause(clause: string): boolean {
  const trimmed = clause.trim();
  if (/^type\b/.test(trimmed)) return false;
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return true;
  return trimmed.slice(1, -1).split(',').some(item => !/^\s*type\b/.test(item));
}

async function residueFiles(paths: readonly string[]): Promise<string[]> {
  const result = new Set<string>();
  const visit = async (path: string, explicitFile = false): Promise<void> => {
    const stat = await lstat(path);
    if (stat.isFile()) {
      if (explicitFile || projectSourceExtensions.has(extname(path).toLowerCase())) result.add(resolve(path));
      return;
    }
    if (!stat.isDirectory()) return;
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory() && projectIgnoredDirectories.has(entry.name)) continue;
      await visit(resolve(path, entry.name));
    }
  };
  // A direct path is an explicit file selection even when its extension is
  // unconventional; directory traversal remains limited to source files.
  for (const path of paths) await visit(resolve(path), true);
  return [...result].sort();
}

/** Include conventional Next/root boundaries in the default audit without
 * requiring callers to enumerate every layout. Explicit audit paths still
 * fail on ENOENT; only these optional defaults are ignored when absent. */
async function defaultResiduePaths(root: string, sourceDir: string | undefined, auditPaths: readonly string[] = []): Promise<string[]> {
  const candidates = [
    sourceDir ?? 'src', 'app', 'src/app', 'pages', 'src/pages', 'components', 'lib', 'routes',
    'middleware.ts', 'middleware.js', 'middleware.mts', 'middleware.mjs', 'middleware.tsx', 'middleware.jsx', 'middleware.cjs',
    'src/middleware.ts', 'src/proxy.ts',
    'proxy.ts', 'proxy.js', 'proxy.mts', 'proxy.mjs', 'proxy.tsx', 'proxy.jsx', 'proxy.cjs',
    'next.config.ts', 'next.config.js', 'next.config.mts', 'next.config.mjs', 'next.config.cts', 'next.config.cjs',
    'package.json',
    ...auditPaths,
  ];
  const result: string[] = [], seen = new Set<string>();
  for (const candidate of candidates) {
    const path = resolve(root, candidate);
    if (seen.has(path)) continue;
    try { await lstat(path); result.push(candidate); seen.add(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || auditPaths.includes(candidate)) throw error; }
  }
  return result;
}

/** Inspect explicitly supplied project files for imports that a migration
 * cannot safely remove automatically. The audit never edits or deletes code.
 * Pass sibling package roots in `paths` for monorepo-wide coverage. */
export async function auditProjectResidues(options: ProjectResidueAuditOptions): Promise<ProjectResidueAudit> {
  const root = resolve(options.root ?? '.');
  const selectedPaths = await defaultResiduePaths(root, undefined, options.paths);
  const files = await residueFiles(selectedPaths.map(path => resolve(root, path)));
  const findings: ProjectResidueFinding[] = [];
  for (const file of files) {
    const source = options.contents?.get(file) ?? await readFile(file, 'utf8');
    const add = (kind: ProjectResidueKind, specifier: string, offset: number): void => {
      const line = source.slice(0, offset).split('\n').length;
      const reason = kind === 'incumbent-runtime-import'
        ? `Runtime import of incumbent package ${JSON.stringify(specifier)} remains; remove or manually replace it after verifying provider/server boundaries.`
        : `Dynamic import of raw catalog JSON ${JSON.stringify(specifier)} remains; replace it with Nordbeam loadLocale/generated messages or prove it is still needed to avoid duplicate locale chunks.`;
      findings.push({ file, line, kind, specifier, reason });
    };
    for (const match of projectCodeMatches(source, /\bimport\s+(?!\()([\s\S]*?)\s+from\s*(['"])([^'"]+)\2/g)) {
      if (!hasRuntimeImportClause(match[1]!)) continue;
      const specifier = match[3]!;
      if (incumbentSpecifier(specifier, options.format)) add('incumbent-runtime-import', specifier, match.index!);
    }
    for (const match of projectCodeMatches(source, /\bexport\s+(?!type\b)(?:\*|\{[\s\S]*?\})\s+from\s*(['"])([^'"]+)\1/g)) {
      const specifier = match[2]!;
      if (incumbentSpecifier(specifier, options.format)) add('incumbent-runtime-import', specifier, match.index!);
    }
    for (const match of projectCodeMatches(source, /\bimport\s*(['"])([^'"]+)\1/g)) {
      const specifier = match[2]!;
      if (incumbentSpecifier(specifier, options.format)) add('incumbent-runtime-import', specifier, match.index!);
    }
    for (const match of projectCodeMatches(source, /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g)) {
      const specifier = match[2]!;
      if (incumbentSpecifier(specifier, options.format)) add('incumbent-runtime-import', specifier, match.index!);
    }
    for (const match of projectCodeMatches(source, /\bimport\s*\(\s*(["'`])([\s\S]*?)\1\s*\)/g)) {
      const specifier = match[2]!;
      if (incumbentSpecifier(specifier, options.format)) add('incumbent-runtime-import', specifier, match.index!);
      else if (rawCatalogSpecifier(specifier)) add('raw-catalog-dynamic-import', specifier, match.index!);
    }
    if (basename(file) === 'package.json') {
      try {
        const packageJson = JSON.parse(source) as Record<string, unknown>;
        for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
          const dependencies = packageJson[section];
          if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue;
          for (const specifier of Object.keys(dependencies)) if (incumbentSpecifier(specifier, options.format)) {
            const offset = source.indexOf(`"${specifier}"`);
            add('incumbent-runtime-import', specifier, offset >= 0 ? offset : 0);
          }
        }
      } catch { /* malformed package JSON is reported by the normal project check */ }
    }
  }
  return { status: findings.length ? 'manual-review' : 'clean', filesScanned: files.length, files, findings };
}

function inferredCatalogFormat(format: CodemodFormat): MigrationFormat {
  return format === 'i18next' || format === 'react-i18next' || format === 'next-i18next' ? 'i18next'
    : format === 'vue-i18n' || format === 'nuxt-i18n' ? 'vue-i18n'
    : format === 'formatjs' || format === 'react-intl' ? 'formatjs' : 'next-intl';
}

function nextFormat(format: CodemodFormat): NextI18nFramework | 'auto' | undefined {
  if (format === 'auto') return 'auto';
  if (format === 'next-intl') return 'next-intl';
  if (format === 'next-i18next') return 'next-i18next';
  if (format === 'i18next' || format === 'react-i18next') return 'react-i18next';
  if (format === 'next-international') return 'next-international';
}

function reactFormat(format: CodemodFormat): ReactMigrationFormat | undefined {
  if (['auto', 'i18next', 'react-i18next', 'formatjs', 'react-intl', 'lingui', 'lingui-react', 'tolgee', 'tolgee-react'].includes(format)) return format as ReactMigrationFormat;
}

function frameworkFormat(format: CodemodFormat): FrameworkMigration | undefined {
  if (format === 'nuxt-i18n') return 'vue-i18n';
  if (['vue-i18n', 'svelte-i18n', 'transloco', 'ngx-translate', 'typesafe-i18n'].includes(format)) return format as FrameworkMigration;
}

async function catalogInputs(path: string, locale?: string): Promise<Array<{ locale: string; file: string }>> {
  const source = resolve(path);
  const stat = await lstat(source);
  if (stat.isFile()) return [{ locale: locale ?? 'en', file: source }];
  if (!stat.isDirectory()) throw new Error(`Migration source must be a catalog file or directory: ${source}`);
  const children = await readdir(source, { withFileTypes: true });
  const files = children
    .filter(entry => entry.isFile() && ['.json', '.yaml', '.yml', '.arb', '.xml', '.strings', '.xcstrings', '.po', '.pot', '.mo'].includes(extname(entry.name).toLowerCase()))
    .map(entry => ({ locale: basename(entry.name, extname(entry.name)), file: resolve(source, entry.name) }));
  // i18next `<locale>/<namespace>.json` layout: a locale folder is one catalog whose namespaces become nested IDs.
  const folders: Array<{ locale: string; file: string }> = [];
  for (const entry of children) {
    if (!entry.isDirectory() || !/^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]+)*$/.test(entry.name)) continue;
    const inner = await readdir(resolve(source, entry.name));
    if (inner.some(name => extname(name).toLowerCase() === '.json')) folders.push({ locale: entry.name, file: resolve(source, entry.name) });
  }
  const entries = [...files, ...folders].sort((left, right) => left.locale.localeCompare(right.locale));
  if (!entries.length) throw new Error(`Migration source directory contains no supported catalogs: ${source}. Expected <locale>.json files, or <locale>/<namespace>.json folders for the JSON formats.`);
  return entries;
}

async function filesAbsent(files: readonly string[]): Promise<void> {
  for (const file of files) {
    try { await lstat(file); throw new CliError('MIGRATION_OUTPUT_EXISTS', `Refusing to overwrite project migration output: ${file}`, { path: file }); }
    catch (error) { if (!missing(error)) throw error; }
  }
}

async function writeTransaction(files: Map<string, string>): Promise<void> {
  const staged: Array<{ file: string; temporary: string }> = [];
  try {
    for (const [file, text] of files) {
      await mkdir(dirname(file), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, text, { flag: 'wx' });
      staged.push({ file, temporary });
    }
    for (const item of staged) await rename(item.temporary, item.file);
  } finally {
    for (const item of staged) await unlink(item.temporary).catch(error => { if (!missing(error)) throw error; });
  }
}

interface SnapshotFile { readonly content: Buffer; readonly mode: number }
type MigrationSnapshot = Map<string, Map<string, SnapshotFile> | undefined>;

async function collectSnapshot(path: string): Promise<Map<string, SnapshotFile> | undefined> {
  const files = new Map<string, SnapshotFile>();
  const visit = async (current: string): Promise<void> => {
    const stat = await lstat(current);
    if (stat.isFile()) { files.set(current, { content: await readFile(current), mode: stat.mode & 0o7777 }); return; }
    if (!stat.isDirectory()) return;
    for (const entry of await readdir(current, { withFileTypes: true })) await visit(resolve(current, entry.name));
  };
  try { await visit(path); }
  catch (error) { if (missing(error)) return; throw error; }
  return files;
}

async function takeMigrationSnapshot(paths: readonly string[]): Promise<MigrationSnapshot> {
  const snapshot: MigrationSnapshot = new Map();
  for (const path of [...new Set(paths.map(path => resolve(path)))].sort()) snapshot.set(path, await collectSnapshot(path));
  return snapshot;
}

/** Restore only the exact roots this migration is allowed to mutate. This
 * turns catalog generation, initialization, scaffolding, integration and
 * source writes into one recoverable transaction when any later phase fails. */
async function restoreMigrationSnapshot(snapshot: MigrationSnapshot): Promise<void> {
  for (const [root, expected] of snapshot) {
    const current = await collectSnapshot(root);
    if (current) for (const file of current.keys()) if (!expected?.has(file)) await unlink(file).catch(error => { if (!missing(error)) throw error; });
    if (!expected) continue;
    // Each original is staged beside its destination, given its original mode,
    // and renamed into place, so an interrupted rollback never leaves a
    // truncated source file behind.
    for (const [file, { content, mode }] of expected) {
      await mkdir(dirname(file), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, content, { flag: 'wx', mode });
        await chmod(temporary, mode);
        await rename(temporary, file);
      } finally {
        await unlink(temporary).catch(error => { if (!missing(error)) throw error; });
      }
    }
  }
}

async function withMigrationTransaction<T>(paths: readonly string[], action: () => Promise<T>): Promise<T> {
  const snapshot = await takeMigrationSnapshot(paths);
  try { return await action(); }
  catch (error) {
    try { await restoreMigrationSnapshot(snapshot); }
    catch (rollbackError) { throw new Error('Migration failed and rollback also failed: ' + (error as Error).message + '; ' + (rollbackError as Error).message); }
    throw error;
  }
}

async function verifyIntegrationPlan(plan: NextMigrationPlan | ReactProjectMigrationPlan | FrameworkProjectPlan): Promise<void> {
  if ('dryRun' in plan) {
    for (const item of plan.changed) if (await readFile(item.file, 'utf8') !== item.before) throw new CliError('STALE_PLAN', `Refusing to apply stale Next migration plan: ${item.file}`, { path: item.file });
  } else if ('changed' in plan) {
    for (const item of plan.changed) {
      const hash = createHash('sha256').update(await readFile(item.file, 'utf8')).digest('hex');
      if (hash !== item.sourceHash) throw new CliError('STALE_PLAN', `Refusing to apply stale React migration plan: ${item.file}`, { path: item.file });
    }
  } else {
    for (const item of plan.files) if (await readFile(item.file, 'utf8') !== item.plan.source) throw new CliError('STALE_PLAN', `Refusing to apply stale framework migration plan: ${item.file}`, { path: item.file });
  }
}

/** Convert catalogs, verify their combined contracts, scaffold the target
 * framework, and rewrite proven source calls. Preview is the default.
 */
export async function migrateProject(options: ProjectMigrationOptions): Promise<ProjectMigrationResult> {
  const root = resolve(options.root ?? '.');
  const catalogFormat = options.catalogFormat ?? inferredCatalogFormat(options.format);
  const inputs = await catalogInputs(resolve(root, options.from), options.locale);
  const outputDirectory = resolve(root, options.catalogs ?? 'messages-nordbeam');
  const previews: Array<{ locale: string; source: string; destination: string; result: MigrationResult }> = [];
  const catalogs: Record<string, Catalog> = Object.create(null);
  for (const input of inputs) {
    const canonical = Intl.getCanonicalLocales(input.locale)[0];
    if (canonical !== input.locale) throw new Error(`Use canonical locale ${JSON.stringify(canonical)} instead of ${JSON.stringify(input.locale)}.`);
    const destination = resolve(outputDirectory, `${input.locale}.json`);
    const result = await migrateCatalog({ from: input.file, format: catalogFormat, out: destination, dryRun: true, locale: input.locale });
    if (!result.ok) throw new Error(`Cannot migrate ${input.file}: ${result.collisions.map(item => `${item.code}: ${item.message}`).join('; ')}`);
    catalogs[input.locale] = JSON.parse(result.output) as Catalog;
    previews.push({ locale: input.locale, source: input.file, destination, result });
  }
  const baseLocale = options.baseLocale ?? options.locale ?? 'en';
  if (!Object.hasOwn(catalogs, baseLocale)) throw new Error(`Migration input has no base locale ${JSON.stringify(baseLocale)}.`);
  compileProject({ ...options, baseLocale, catalogs });
  await filesAbsent(previews.map(item => item.destination));
  const messageIds: string[] = [], idBySource = new Map<string, string>(), ambiguousSources = new Set<string>();
  const collectIds = (value: unknown, path: string[]): void => {
    if (typeof value === 'string') {
      const id = path.join('.'); messageIds.push(id);
      if (idBySource.has(value)) { idBySource.delete(value); ambiguousSources.add(value); }
      else if (!ambiguousSources.has(value)) idBySource.set(value, id);
      return;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) for (const [key, child] of Object.entries(value)) collectIds(child, [...path, key]);
  };
  collectIds(catalogs[baseLocale], []);
  const explicitSourceIds = options.messageIdBySource instanceof Map
    ? options.messageIdBySource
    : new Map(Object.entries(options.messageIdBySource ?? {}));
  for (const [source, id] of explicitSourceIds) if (source && id) idBySource.set(source, id);
  if (options.messageIdBySourceFile) for (const [source, id] of await readMessageIdBySourceFile(options.messageIdBySourceFile, root)) idBySource.set(source, id);
  const codemod = await codemodProject({ root, sourceDir: options.sourceDir, format: options.format, messagesObject: options.messagesObject, customCalls: options.customCalls, messageIds, messageIdBySource: idBySource, write: false });
  let integrationPlan: NextMigrationPlan | ReactProjectMigrationPlan | FrameworkProjectPlan | undefined;
  let integration: ProjectIntegrationResult | undefined;
  const targetNextFormat = nextFormat(options.format);
  const targetReactFormat = reactFormat(options.format);
  const targetFrameworkFormat = frameworkFormat(options.format);
  if (options.framework === 'next' && targetNextFormat) {
    const plan = await planNextMigration({ root, sourceDir: options.sourceDir, outDir: options.outDir, framework: targetNextFormat, messagesObject: options.messagesObject, strict: options.strict });
    integrationPlan = plan;
    const clientNeedsProvider = plan.changed.some(item => /['"]use client['"]/.test(item.before) && /i18n\.useI18n\(\)/.test(item.after));
    const providerHandled = plan.changed.some(item => /<NordbeamLocaleProvider\b/.test(item.after));
    integration = { kind: 'next', filesScanned: plan.filesScanned, filesChanged: plan.changed.length, replacements: plan.replacements,
      skipped: [...plan.skipped.map(item => ({ file: item.file, reason: item.reason, kind: item.kind })),
        ...(clientNeedsProvider && !providerHandled ? [{ reason: 'Client Components require the generated NordbeamLocaleProvider at their nearest locale layout.', kind: 'provider' }] : [])] };
  } else if (options.framework === 'vite-react' && targetReactFormat) {
    const plan = await planReactProject({ root, sourceDir: options.sourceDir, format: targetReactFormat,
      framework: 'vite-react', i18nModule: resolve(root, options.outDir ?? 'src/i18n', 'client.ts'), initialLocaleExpression: options.initialLocaleExpression, messageIds, messageIdBySource: idBySource });
    integrationPlan = plan;
    const replacements = plan.changed.reduce((sum, item) => sum + item.replacements, 0);
    const wrappedRoots = plan.changed.reduce((sum, item) => sum + item.wrappedRoots, 0);
    integration = { kind: 'react', filesScanned: plan.filesScanned, filesChanged: plan.changed.length,
      replacements,
      skipped: [...plan.skipped.map(item => ({ ...(item.file ? { file: item.file } : {}), reason: item.reason, kind: item.kind })),
        ...(replacements && !wrappedRoots ? [{ reason: 'No conventional React root was wrapped; add i18n.Provider above the migrated components.', kind: 'provider' }] : [])] };
  } else if (!options.framework && targetFrameworkFormat) {
    const plan = await planFrameworkProject({ root, sourceDir: options.sourceDir, framework: targetFrameworkFormat, messagesObject: options.messagesObject });
    integrationPlan = plan;
    integration = { kind: 'framework', filesScanned: plan.filesScanned, filesChanged: plan.files.filter(item => item.plan.code !== item.plan.source).length,
      replacements: plan.files.reduce((sum, item) => sum + item.plan.callsRewritten, 0),
      skipped: [...plan.files.flatMap(item => [...item.plan.skips.map(skip => ({ file: item.file, reason: skip.reason, kind: skip.kind })),
        ...item.plan.codemodSkips.map(skip => ({ file: item.file, reason: skip.reason, kind: 'call' }))]),
        ...(plan.files.some(item => item.plan.callsRewritten) ? [{ reason: 'Connect the framework-owned locale lifecycle to a Nordbeam loadLocale result before using the generated m calls.', kind: 'provider' }] : [])] };
  }
  const configFile = options.configFile ? resolve(root, options.configFile) : await discoverConfig(root);
  const existingConfig = await readConfig(configFile);
  if (existingConfig) {
    const configuredCatalogs = resolve(root, existingConfig.catalogs ?? 'messages');
    const configuredOutput = resolve(root, existingConfig.outDir ?? 'src/i18n');
    const requestedOutput = resolve(root, options.outDir ?? 'src/i18n');
    const configuredBase = existingConfig.baseLocale ?? 'en';
    if (configuredCatalogs !== outputDirectory || configuredOutput !== requestedOutput || configuredBase !== baseLocale) {
      throw new Error(`Existing config ${configFile} does not match this migration's catalogs, outDir, or baseLocale. Edit the config first; migrate-project never silently rewrites it.`);
    }
  }
  const residuePaths = await defaultResiduePaths(root, options.sourceDir, options.auditPaths);
  // Read and validate the complete audit selection before any output is
  // written. An invalid sibling path or unreadable source must not leave a
  // half-applied migration behind.
  const plannedContents = new Map<string, string>();
  if (integrationPlan) {
    if ('dryRun' in integrationPlan) for (const item of integrationPlan.changed) plannedContents.set(item.file, item.after);
    else if ('changed' in integrationPlan) for (const item of integrationPlan.changed) plannedContents.set(item.file, item.code);
    else for (const item of integrationPlan.files) plannedContents.set(item.file, item.plan.code);
  }
  const preWriteResidueAudit = await auditProjectResidues({ root, format: options.format, paths: residuePaths, contents: plannedContents });
  if (options.strict) {
    const integrationSkips = integration?.skipped ?? [];
    const diagnostics = [
      // Incumbent imports are audited against the planned bytes below. The
      // codemod preview sees the original bytes and would otherwise reject a
      // Next/React integration whose reviewed plan removes those imports.
      ...codemod.skipped.filter(item => !/incumbent runtime import/.test(item.reason)),
      ...integrationSkips.map(item => ({ ...(item.file ? { file: item.file } : {}), callee: item.kind ?? 'integration', reason: item.reason })),
      ...preWriteResidueAudit.findings.map(item => ({ ...(item.file ? { file: item.file } : {}), callee: item.kind ?? 'residue', reason: item.reason })),
    ];
    if (diagnostics.length) throw new CodemodStrictError(diagnostics);
  }
  // auditPaths is a migration-only input and must not leak into the generated
  // project config. In particular, monorepo sibling roots are not config
  // generation options.
  // The remaining migration-only inputs would otherwise be hashed into the
  // generation options, so `verify` would call the first output stale.
  const {
    auditPaths: _auditPaths, messageIdBySource: _messageIdBySource, messageIdBySourceFile: _messageIdBySourceFile,
    from: _from, format: _format, catalogFormat: _catalogFormat, locale: _locale, framework: _framework, sourceDir: _sourceDir,
    messagesObject: _messagesObject, customCalls: _customCalls, write: _write, configFile: _configFile,
    initialLocaleExpression: _initialLocaleExpression, strict: _strict, ...initOptions
  } = options;
  const initRequest = { ...initOptions, root, baseLocale, catalogs: options.catalogs ?? 'messages-nordbeam' };
  let initPlan: InitPlan = { generated: [], config: [], scaffold: [], packageEdits: [] };
  let residueAudit = preWriteResidueAudit;
  if (!options.write) {
    // The preview reports the same init effects that --write applies, so an
    // agent can review generated, scaffold, config and package.json changes.
    const baseOutput = previews.find(item => item.locale === baseLocale)!.result.output;
    initPlan = await planInitialize(initRequest, catalogs, baseOutput, configFile, existingConfig !== undefined, options.framework);
  } else {
    const transactionPaths = [
      outputDirectory, resolve(root, options.outDir ?? 'src/i18n'), configFile, resolve(root, 'package.json'),
      ...codemod.changed.map(item => item.file),
      ...(integrationPlan
        ? 'dryRun' in integrationPlan ? integrationPlan.changed.map(item => item.file)
          : 'changed' in integrationPlan ? integrationPlan.changed.map(item => item.file)
          : integrationPlan.files.map(item => item.file)
        : []),
      // Framework config files are project-relative, not relative to the process cwd.
      ...(options.framework === 'next' ? ['next.config.mjs', 'next.config.js', 'next.config.ts', 'next.config.mts', 'next.config.cjs', 'next.config.cts', 'proxy.ts', 'middleware.ts', 'src/proxy.ts', 'src/middleware.ts'] : [])
        .map(file => resolve(root, file)),
      ...(options.framework && options.framework !== 'next' ? ['vite.config.ts', 'vite.config.js', 'vite.config.mjs'] : [])
        .map(file => resolve(root, file)),
    ];
    await withMigrationTransaction(transactionPaths, async () => {
      if (integrationPlan) await verifyIntegrationPlan(integrationPlan);
      await writeTransaction(new Map(previews.map(item => [item.destination, item.result.output])));
      const initialized = await initialize(initRequest, configFile, existingConfig !== undefined, options.framework);
      initPlan = {
        generated: initialized.project.changed, config: initialized.created,
        scaffold: initialized.frameworkCreated ?? [], packageEdits: initialized.updated ?? [],
      };
      if (integrationPlan) {
        if ('dryRun' in integrationPlan) await applyNextMigration(integrationPlan);
        else if ('changed' in integrationPlan) await applyReactProject(integrationPlan);
        else await applyFrameworkProject(integrationPlan);
        // Framework plans own their recognized files, but they intentionally
        // skip files outside their integration shape. Apply the source
        // codemod after the reviewed integration plan so those remaining
        // files are not silently omitted; files already transformed by the
        // integration are now no-ops.
        await codemodProject({ root, sourceDir: options.sourceDir, format: options.format, messagesObject: options.messagesObject, customCalls: options.customCalls, messageIds, messageIdBySource: idBySource, write: true, strict: options.strict });
      } else await codemodProject({ root, sourceDir: options.sourceDir, format: options.format, messagesObject: options.messagesObject, customCalls: options.customCalls, messageIds, messageIdBySource: idBySource, write: true, strict: options.strict });
      residueAudit = await auditProjectResidues({ root, format: options.format, paths: residuePaths });
    });
  }
  const manualActions = [
    ...(!integration || integration.skipped.length ? [`Bind or verify the generated messages object as ${options.messagesObject ?? 'm'} at each reported server/client boundary.`] : []),
    ...(residueAudit.findings.length
      ? [`Review ${residueAudit.findings.length} post-migration residue finding(s) before removing anything; each finding includes an actionable reason and no files are deleted automatically.`]
      : []),
    ...(codemod.compatibility.fallbackRequired
      ? [`Keep a lazy legacy compatibility boundary for ${codemod.compatibility.fallbackCalls.length} unresolved translation call(s); direct rewrites are safe only for the ${codemod.compatibility.directRewrites} proven static call(s).`]
      : []),
    ...(codemod.skipped.length ? [`Review ${codemod.skipped.length} skipped dynamic or unsupported translation calls.`] : []),
    ...(integrationPlan && 'manualActions' in integrationPlan ? integrationPlan.manualActions : []),
    ...(options.framework ? [] : ['Add --framework next or --framework vite-react to create the framework adapter.']),
  ];
  const projectPath = (file: string): string => relative(root, file).split(sep).join('/');
  return {
    ok: true, dryRun: !options.write, format: options.format, catalogFormat,
    ...(options.framework ? { framework: options.framework } : {}),
    catalogs: previews.map(item => ({ locale: item.locale, source: item.source, destination: item.destination, messageCount: item.result.messageCount, warnings: item.result.warnings })),
    codemod, ...(integration ? { integration } : {}),
    generatedFiles: initPlan.generated.map(projectPath), scaffoldFiles: initPlan.scaffold.map(projectPath),
    configFiles: initPlan.config.map(projectPath), packageEdits: initPlan.packageEdits.map(projectPath),
    residueAudit, manualActions,
  };
}
