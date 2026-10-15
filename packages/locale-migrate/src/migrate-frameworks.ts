/**
 * Conservative framework migration helpers.
 *
 * This module deliberately does not scaffold an adapter.  Nordbeam's runtime
 * is framework independent, while Vue/Svelte/Angular providers, DI and
 * template compilers are framework boundaries that need an application owner.
 * We can safely rewrite the same static message calls as `codemodSource`, and
 * remove the now-unused local binding/import.  Provider and bootstrap code is
 * reported, never rewritten.
 */
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { codemodSource, type CodemodSkip } from './codemods.js';

export type FrameworkMigration = 'vue-i18n' | 'svelte-i18n' | 'transloco' | 'ngx-translate' | 'typesafe-i18n';

export interface FrameworkMigrationOptions {
  readonly framework: FrameworkMigration;
  readonly messagesObject?: string;
  readonly filename?: string;
  /** Calls are rewritten by default. Set false for an import/binding-only plan. */
  readonly rewriteCalls?: boolean;
}

export type FrameworkSkipKind = 'provider' | 'bootstrap' | 'template' | 'dynamic' | 'unsupported';

export interface FrameworkMigrationSkip {
  readonly kind: FrameworkSkipKind;
  readonly code: string;
  readonly reason: string;
  readonly offset?: number;
}

export interface FrameworkMigrationChange {
  readonly kind: 'call' | 'binding' | 'import';
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly description: string;
}

export interface FrameworkMigrationPlan {
  readonly framework: FrameworkMigration;
  readonly source: string;
  readonly code: string;
  readonly changes: readonly FrameworkMigrationChange[];
  readonly skips: readonly FrameworkMigrationSkip[];
  readonly codemodSkips: readonly CodemodSkip[];
  readonly callsRewritten: number;
  readonly importsRemoved: number;
  readonly bindingsRemoved: number;
}

export interface FrameworkMigrationResult extends FrameworkMigrationPlan {
  readonly applied: boolean;
}

const formats: Record<FrameworkMigration, FrameworkMigration> = {
  'vue-i18n': 'vue-i18n', 'svelte-i18n': 'svelte-i18n', transloco: 'transloco',
  'ngx-translate': 'ngx-translate', 'typesafe-i18n': 'typesafe-i18n',
};
const extensions = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.vue', '.svelte', '.html']);

function codeMask(source: string): Uint8Array {
  const mask = new Uint8Array(source.length);
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';
  for (let i = 0; i < source.length; i++) {
    const c = source[i], next = source[i + 1];
    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'line'; i++; continue; }
      if (c === '/' && next === '*') { state = 'block'; i++; continue; }
      if (c === "'") { state = 'single'; continue; }
      if (c === '"') { state = 'double'; continue; }
      if (c === '`') { state = 'template'; continue; }
      mask[i] = 1; continue;
    }
    if (state === 'line') { if (c === '\n' || c === '\r') state = 'code'; continue; }
    if (state === 'block') { if (c === '*' && next === '/') { state = 'code'; i++; } continue; }
    if (c === '\\') { i++; continue; }
    if ((state === 'single' && c === "'") || (state === 'double' && c === '"') || (state === 'template' && c === '`')) state = 'code';
  }
  return mask;
}

function codeMatches(source: string, pattern: RegExp): RegExpExecArray[] {
  const mask = codeMask(source);
  return [...source.matchAll(pattern)].filter(match => match.index !== undefined && mask[match.index] === 1);
}

function frameworkModules(framework: FrameworkMigration): readonly string[] {
  switch (framework) {
    case 'vue-i18n': return ['vue-i18n'];
    case 'svelte-i18n': return ['svelte-i18n'];
    case 'transloco': return ['@jsverse/transloco', '@ngneat/transloco'];
    case 'ngx-translate': return ['@ngx-translate/core', '@ngx-translate/http-loader'];
    case 'typesafe-i18n': return ['typesafe-i18n'];
  }
}

function escaped(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function importStatements(source: string): RegExpExecArray[] {
  return codeMatches(source, /\bimport\s+(?!\()([\s\S]*?)\s+from\s+(['"])([^'"\n]+)\2\s*;?/g);
}

function importsFor(source: string, framework: FrameworkMigration): RegExpExecArray[] {
  const modules = new Set(frameworkModules(framework));
  return importStatements(source).filter(item => modules.has(item[3]!));
}

function importLocals(statement: string): Array<{ local: string; specifier: string; start: number; end: number }> {
  const from = /\s+from\s+['"][^'"]+['"]\s*;?\s*$/.exec(statement);
  if (!from) return [];
  const clause = statement.slice(0, from.index).replace(/^\s*import\s+/, '');
  const result: Array<{ local: string; specifier: string; start: number; end: number }> = [];
  const add = (specifier: string, local: string, start: number) => result.push({ local, specifier, start, end: start + specifier.length });
  // `import type { ... }` has no default binding named `type`; normalize only
  // for parsing while retaining offsets in the original statement.
  const namedClause = clause.startsWith('type {') ? clause.slice(5) : clause;
  if (namedClause.startsWith('{')) {
    const open = statement.indexOf('{'), close = statement.lastIndexOf('}');
    if (open < 0 || close <= open) return result;
    for (const match of namedClause.slice(1, -1).matchAll(/(?:^|,)\s*([^,]+?)(?=\s*(?:,|$))/g)) {
      const specifier = match[1]!.trim();
      const imported = /^(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(specifier);
      if (!imported) continue;
      const local = imported[2] ?? imported[1]!;
      const relative = open + 1 + (match.index ?? 0) + match[0].indexOf(specifier);
      add(specifier, local, relative);
    }
  } else {
    const defaultMatch = /^([\w$]+)/.exec(clause);
    if (defaultMatch) add(defaultMatch[1]!, defaultMatch[1]!, statement.indexOf(defaultMatch[1]!));
    const namespace = /\*\s+as\s+([\w$]+)/.exec(clause);
    if (namespace) add(namespace[0], namespace[1]!, statement.indexOf(namespace[0]));
    const open = statement.indexOf('{'), close = statement.lastIndexOf('}');
    if (open >= 0 && close > open) for (const match of statement.slice(open + 1, close).matchAll(/(?:^|,)\s*([^,]+?)(?=\s*(?:,|$))/g)) {
      const specifier = match[1]!.trim(), imported = /^(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(specifier);
      if (imported) add(specifier, imported[2] ?? imported[1]!, open + 1 + (match.index ?? 0) + match[0].indexOf(specifier));
    }
  }
  return result;
}

function identifierUsed(source: string, local: string, omit: readonly [number, number][] = []): boolean {
  const mask = codeMask(source), pattern = new RegExp(`\\b${escaped(local)}\\b`, 'g');
  for (const match of source.matchAll(pattern)) {
    const at = match.index!;
    if (!mask[at]) continue;
    if (omit.some(([start, end]) => at >= start && at < end)) continue;
    return true;
  }
  return false;
}

function removeNamedSpecifier(statement: string, specifier: { start: number; end: number }): string {
  let start = specifier.start, end = specifier.end;
  while (start > 0 && /\s/.test(statement[start - 1]!)) start--;
  if (statement[end] === ',') end++;
  else if (start > 0 && statement[start - 1] === ',') start--;
  return statement.slice(0, start) + statement.slice(end);
}

function boundarySkips(source: string, framework: FrameworkMigration): FrameworkMigrationSkip[] {
  const patterns: Array<[FrameworkSkipKind, string, RegExp, string]> = [];
  if (framework === 'vue-i18n') patterns.push(
    ['provider', 'VUE_I18N_PLUGIN', /(?:createI18n\s*\(|\.use\s*\(\s*i18n\b|vueApp\.use\s*\(\s*i18n\b)/g, 'Vue I18n createI18n/app.use bootstrap must be replaced manually with createVueI18n from @nordbeam/locale/vue and app.use(i18n).'],
    ['bootstrap', 'VUE_NUXT_PLUGIN', /defineNuxtPlugin|useNuxtApp\s*\(\)[\s\S]{0,120}\.vueApp\.use/g, 'Nuxt Vue-I18n plugin/bootstrap integration is framework-owned and remains a manual action.'],
    ['template', 'VUE_TEMPLATE_API', /(?:\$t|\$tc|\$d|\$n)\s*\(/g, 'Vue template global translation helpers are outside the TypeScript call codemod; migrate the template explicitly.'],
  );
  if (framework === 'svelte-i18n') patterns.push(
    ['bootstrap', 'SVELTE_I18N_SETUP', /(?:^|[^\w])(?:init|addMessages|register|setupI18n)\s*\(|\blocale\.set\s*\(/g, 'svelte-i18n initialization, dictionary registration and locale switching are framework/bootstrap integration; wire a Nordbeam locale loader manually.'],
    ['bootstrap', 'SVELTEKIT_HOOK', /(?:export\s+)?(?:const\s+)?handle\s*=|hooks\.server|setLocale\s*\(/g, 'SvelteKit hooks/locale switching are application boundaries and are not rewritten.'],
    // `$t(...)`/`$_(...)` in Svelte markup are expression calls, not a
    // provider boundary. codemodSource rewrites static IDs to `m.key(...)`;
    // dynamic IDs remain in codemodSkips with their exact source location.
  );
  if (framework === 'transloco') patterns.push(
    ['provider', 'TRANSLOCO_PROVIDER', /provideTransloco\s*\(|TranslocoModule|TRANSLOCO_(?:CONFIG|SCOPE|LOADER)/g, 'Transloco providers/modules/loaders are Angular DI integration; configure a Nordbeam loader manually.'],
    ['bootstrap', 'ANGULAR_BOOTSTRAP', /bootstrapApplication\s*\(|platformBrowserDynamic\s*\(/g, 'Angular bootstrap providers are framework-owned and are intentionally not rewritten.'],
    ['template', 'TRANSLOCO_TEMPLATE', /\|\s*transloco|transloco\s*:/g, 'Transloco pipes/directives in Angular templates require an explicit template migration.'],
  );
  if (framework === 'ngx-translate') patterns.push(
    ['provider', 'NGX_TRANSLATE_PROVIDER', /provideTranslate(?:Service|Loader|Compiler|Parser)\s*\(|TranslateModule(?:\.for(?:Root|Child))?|TranslateLoader|TranslateHttpLoader/g, 'ngx-translate providers/modules/loaders are Angular DI integration; configure a Nordbeam loader manually.'],
    ['bootstrap', 'ANGULAR_BOOTSTRAP', /bootstrapApplication\s*\(|platformBrowserDynamic\s*\(/g, 'Angular bootstrap providers are framework-owned and are intentionally not rewritten.'],
    ['template', 'NGX_TRANSLATE_TEMPLATE', /\|\s*translate|translate\s*:/g, 'ngx-translate pipes/directives in Angular templates require an explicit template migration.'],
  );
  if (framework === 'typesafe-i18n') patterns.push(
    ['provider', 'TYPESAFE_I18N_ADAPTER', /(?:new\s+)?TypesafeI18n\s*\(|I18n(?:Provider|Context)|createI18n\s*\(|i18nObject\s*\(/g, 'typesafe-i18n generated adapter/context setup is framework-owned; Nordbeam does not inject a React or other framework API.'],
    ['bootstrap', 'TYPESAFE_I18N_LOADER', /loadedLocales|loadFormatters|i18nDictionary|dictionary\s*:/g, 'typesafe-i18n locale dictionary/formatter loading must be connected to the Nordbeam loader manually.'],
  );
  const result: FrameworkMigrationSkip[] = [];
  const seen = new Set<string>();
  for (const [kind, code, pattern, reason] of patterns) for (const match of codeMatches(source, pattern)) {
    const key = `${code}:${match.index}`;
    if (!seen.has(key)) { seen.add(key); result.push({ kind, code, reason, offset: match.index }); }
  }
  return result.sort((left, right) => (left.offset ?? 0) - (right.offset ?? 0));
}

function declarationChanges(source: string, framework: FrameworkMigration): FrameworkMigrationChange[] {
  const changes: FrameworkMigrationChange[] = [];
  const patterns: RegExp[] = [];
  if (framework === 'vue-i18n') patterns.push(/\b(?:const|let)\s+\{([^}]*)\}\s*=\s*useI18n\s*\([^;\n]*\)\s*;?/g);
  if (framework === 'typesafe-i18n') patterns.push(/\b(?:const|let)\s+\{([^}]*)\}\s*=\s*useI18nContext\s*\([^;\n]*\)\s*;?/g);
  if (framework === 'transloco') patterns.push(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*inject\s*\(\s*TranslocoService\s*\)\s*;?/g);
  if (framework === 'ngx-translate') patterns.push(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*inject\s*\(\s*TranslateService\s*\)\s*;?/g);
  for (const pattern of patterns) for (const match of codeMatches(source, pattern)) {
    let names: string[];
    let safeToRemove = true;
    if (framework === 'vue-i18n' || framework === 'typesafe-i18n') {
      const property = framework === 'vue-i18n' ? 't' : 'LL';
      const fields = match[1]!.split(',').map(field => field.trim()).filter(Boolean);
      const aliases = fields.map(field => new RegExp(`^${property}(?:\\s*:\\s*([A-Za-z_$][\\w$]*))?$`).exec(field));
      safeToRemove = fields.length > 0 && aliases.every(Boolean);
      names = aliases.filter((item): item is RegExpExecArray => !!item).map(item => item[1] ?? property);
    } else names = [match[1]!];
    if (safeToRemove && names.length && names.every(name => !identifierUsed(source, name, [[match.index!, match.index! + match[0]!.length]]))) {
      changes.push({ kind: 'binding', start: match.index!, end: match.index! + match[0]!.length, text: '', description: `Remove unused ${framework} translation binding ${names.join(', ')}.` });
    } else {
      changes.push({ kind: 'binding', start: match.index!, end: match.index! + match[0]!.length, text: match[0]!, description: `Retain ${framework} binding because it still has a non-static or framework-owned use.` });
    }
  }
  return changes.filter(change => change.text === '');
}

/** Build a dry-run plan. The returned `code` is always the preview; call
 * `applyFrameworkMigration` to opt into changing a file. */
export function planFrameworkMigration(source: string, options: FrameworkMigrationOptions): FrameworkMigrationPlan {
  if (!formats[options.framework]) throw new TypeError(`Unsupported framework migration: ${String(options.framework)}`);
  const callResult = options.rewriteCalls === false
    ? { code: source, replacements: 0, skipped: [] as CodemodSkip[] }
    : codemodSource(source, formats[options.framework], { messagesObject: options.messagesObject, filename: options.filename, cleanup: false });
  const bindingChanges = declarationChanges(callResult.code, options.framework);
  let preview = callResult.code;
  const changes: FrameworkMigrationChange[] = [];
  for (const change of [...bindingChanges].sort((a, b) => b.start - a.start)) {
    preview = preview.slice(0, change.start) + change.text + preview.slice(change.end);
    changes.push(change);
  }
  let importsRemoved = 0;
  // Apply from the end so removing one import cannot invalidate offsets for a
  // later import in the same source revision.
  for (const statement of importsFor(preview, options.framework).sort((a, b) => b.index! - a.index!)) {
    const text = statement[0]!, start = statement.index!, locals = importLocals(text);
    const removable = locals.filter(item => !identifierUsed(preview, item.local, [[start, start + text.length]]));
    if (!removable.length) continue;
    let replacement = text;
    for (const local of [...removable].sort((a, b) => b.start - a.start)) replacement = removeNamedSpecifier(replacement, { start: local.start, end: local.end });
    // A named import with no specifiers, or a default/namespace import that
    // is unused, can be removed as a whole. Side-effect imports are retained.
    const residual = replacement.replace(/^\s*import\s+(?:type\s+)?/, '').replace(/\s+from\s+['"][^'"]+['"]\s*;?\s*$/, '').trim();
    if (!residual || /^\{\s*\}$/.test(residual)) replacement = '';
    else if (/^\w+$/.test(residual) || /^\*\s+as\s+\w+$/.test(residual)) replacement = '';
    if (replacement === text) continue;
    preview = preview.slice(0, start) + replacement + preview.slice(start + text.length);
    changes.push({ kind: 'import', start, end: start + text.length, text: replacement, description: `Remove unused ${options.framework} import bindings.` });
    importsRemoved += removable.length;
  }
  const skips = boundarySkips(preview, options.framework);
  return { framework: options.framework, source, code: preview, changes: changes.sort((a, b) => a.start - b.start), skips,
    codemodSkips: callResult.skipped, callsRewritten: callResult.replacements, importsRemoved,
    bindingsRemoved: bindingChanges.length };
}

/** Apply a previously generated plan. Plans are source-bound to avoid
 * accidentally applying offsets to a different revision. The one-argument
 * form is convenient for callers that retain the original plan; the
 * two-argument form can additionally assert the source revision. */
export function applyFrameworkMigration(plan: FrameworkMigrationPlan): FrameworkMigrationResult;
export function applyFrameworkMigration(source: string, plan: FrameworkMigrationPlan): FrameworkMigrationResult;
export function applyFrameworkMigration(sourceOrPlan: string | FrameworkMigrationPlan, suppliedPlan?: FrameworkMigrationPlan): FrameworkMigrationResult {
  const plan = typeof sourceOrPlan === 'string' ? suppliedPlan : sourceOrPlan;
  if (!plan) throw new TypeError('A framework migration plan is required.');
  if (typeof sourceOrPlan === 'string' && sourceOrPlan !== plan.source) throw new Error('Framework migration plan does not match the supplied source. Re-plan before applying.');
  return { ...plan, applied: true };
}

export interface FrameworkProjectOptions extends FrameworkMigrationOptions { readonly root?: string; readonly sourceDir?: string; }
export interface FrameworkProjectPlan { readonly framework: FrameworkMigration; readonly filesScanned: number; readonly files: readonly { file: string; plan: FrameworkMigrationPlan }[]; readonly skips: readonly (FrameworkMigrationSkip & { file: string })[]; }

async function projectFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(current: string): Promise<void> {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && !new Set(['node_modules', '.git', 'dist', 'build', '.next']).has(entry.name)) await visit(resolve(current, entry.name));
      else if (entry.isFile() && extensions.has(extname(entry.name))) files.push(resolve(current, entry.name));
    }
  }
  await visit(directory); return files;
}

export async function planFrameworkProject(options: FrameworkProjectOptions): Promise<FrameworkProjectPlan> {
  const root = resolve(options.root ?? '.'), files: { file: string; plan: FrameworkMigrationPlan }[] = [];
  const scanned = await projectFiles(resolve(root, options.sourceDir ?? 'src'));
  for (const file of scanned) {
    const plan = planFrameworkMigration(await readFile(file, 'utf8'), { ...options, filename: file });
    if (plan.code !== plan.source || plan.skips.length || plan.codemodSkips.length) files.push({ file, plan });
  }
  return { framework: options.framework, filesScanned: scanned.length, files, skips: files.flatMap(item => item.plan.skips.map(skip => ({ ...skip, file: item.file }))) };
}

async function atomicWriteFiles(files: readonly { file: string; code: string }[]): Promise<void> {
  const staged: Array<{ file: string; temporary: string }> = [];
  try {
    for (const item of files) {
      await mkdir(dirname(item.file), { recursive: true });
      const temporary = `${item.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, item.code, { flag: 'wx' });
      staged.push({ file: item.file, temporary });
    }
    for (const item of staged) await rename(item.temporary, item.file);
  } finally {
    for (const item of staged) await unlink(item.temporary).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
}

export async function applyFrameworkProject(plan: FrameworkProjectPlan): Promise<FrameworkProjectPlan> {
  const changed = plan.files.filter(item => item.plan.code !== item.plan.source);
  // Re-read all targets before staging any output. This makes a plan safe to
  // apply after an editor/build has touched one of the files and guarantees a
  // stale target cannot result in a partial project migration.
  for (const item of changed) {
    const current = await readFile(item.file, 'utf8');
    if (current !== item.plan.source) throw new Error(`Framework migration plan is stale for ${item.file}; re-plan before applying.`);
  }
  await atomicWriteFiles(changed.map(item => ({ file: item.file, code: item.plan.code })));
  return plan;
}
