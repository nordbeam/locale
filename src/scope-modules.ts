import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CompileError } from './diagnostics.js';

/**
 * A scope computed from code: the messages its modules can reach. The crawl starts at
 * the files that `modules` matches and follows their imports, static and dynamic,
 * through the app's own source (relative paths and tsconfig `paths`), never into
 * node_modules. Each file contributes the message IDs it names in string literals,
 * template literals (`\`plan.${id}.name\`` matches every ID of that shape), and
 * property chains (`m.checkout.title`). `messages` adds IDs or `prefix.*` patterns
 * that the code does not name, such as IDs built at run time.
 */
export interface ModuleScope {
  /** Globs relative to the project root, such as `src/routes/pricing.tsx` or `src/routes/blog.*.tsx`. */
  readonly modules: readonly string[];
  /** Globs of files the crawl neither reads nor follows, such as a generated route tree that imports every route. */
  readonly exclude?: readonly string[];
  readonly messages?: readonly string[];
}
export type ScopeConfig = readonly string[] | ModuleScope;

export function isModuleScope(scope: ScopeConfig | undefined): scope is ModuleScope {
  return !!scope && !Array.isArray(scope) && typeof scope === 'object';
}

/** The scopes the compiler can check without reading code: pattern scopes, and the `messages` of module scopes. */
export function staticScopes(scopes: Readonly<Record<string, ScopeConfig>> | undefined): Record<string, readonly string[]> | undefined {
  if (!scopes) return;
  const result: Record<string, readonly string[]> = {};
  for (const [name, scope] of Object.entries(scopes)) {
    if (!isModuleScope(scope)) result[name] = scope;
    else if (scope.messages?.length) result[name] = scope.messages;
  }
  return result;
}

const sourceExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte'];
const readable = /\.(?:[cm]?[jt]sx?|vue|svelte|json)$/;

/** A glob over project-relative paths: `*` and `?` within a segment, `**` across segments, `{a,b}` alternatives. */
export function globPattern(glob: string): RegExp {
  let source = '';
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]!;
    if (char === '*' && glob[index + 1] === '*') {
      index++;
      if (glob[index + 1] === '/') { index++; source += '(?:[^/]*/)*'; } else source += '.*';
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else if (char === '{') {
      const end = glob.indexOf('}', index);
      if (end < 0) { source += '\\{'; continue; }
      source += `(?:${glob.slice(index + 1, end).split(',').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`;
      index = end;
    } else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

async function walk(directory: string, skip: (path: string) => boolean, files: string[]): Promise<void> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.name === 'node_modules' || entry.name.startsWith('.') || skip(path)) continue;
    if (entry.isDirectory()) await walk(path, skip, files);
    else if (entry.isFile()) files.push(path);
  }
}

/** Files under root that a glob matches, sorted. The walk starts below the glob's literal directories. */
async function globFiles(root: string, glob: string, skip: (path: string) => boolean): Promise<string[]> {
  const normalized = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  const segments = normalized.split('/');
  const fixed: string[] = [];
  for (const segment of segments.slice(0, -1)) { if (/[*?{]/.test(segment)) break; fixed.push(segment); }
  const pattern = globPattern(normalized);
  const files: string[] = [];
  await walk(join(root, ...fixed), skip, files);
  return files.filter(file => pattern.test(relative(root, file).split(sep).join('/'))).sort();
}

/** JSON with comments and trailing commas, as tsconfig files allow. */
function parseJsonc(text: string): unknown {
  let out = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === '"') {
      const start = index;
      for (index++; index < text.length && text[index] !== '"'; index++) if (text[index] === '\\') index++;
      out += text.slice(start, index + 1);
    } else if (char === '/' && text[index + 1] === '/') { while (index < text.length && text[index] !== '\n') index++; out += '\n'; }
    else if (char === '/' && text[index + 1] === '*') { index = text.indexOf('*/', index + 2); if (index < 0) break; index++; }
    else out += char;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

type Alias = { prefix: string; suffix: string; wildcard: boolean; targets: string[] };

/** tsconfig `paths`, following relative `extends`. Targets are absolute. */
async function tsconfigAliases(root: string): Promise<Alias[]> {
  const seen = new Set<string>();
  async function load(file: string): Promise<{ paths?: Record<string, string[]>; base?: string }> {
    if (seen.has(file)) return {};
    seen.add(file);
    let config: { extends?: string | string[]; compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
    try { config = parseJsonc(await readFile(file, 'utf8')) as typeof config; } catch { return {}; }
    let inherited: { paths?: Record<string, string[]>; base?: string } = {};
    for (const parent of [config.extends ?? []].flat()) {
      if (!parent.startsWith('.')) continue;
      const path = resolve(dirname(file), parent);
      inherited = await load(path.endsWith('.json') ? path : `${path}.json`);
    }
    const options = config.compilerOptions ?? {};
    const base = options.baseUrl !== undefined ? resolve(dirname(file), options.baseUrl) : inherited.base;
    if (!options.paths) return { paths: inherited.paths, base: base ?? inherited.base };
    // Paths resolve against baseUrl, or the declaring file's directory without one.
    const from = base ?? dirname(file);
    return { paths: Object.fromEntries(Object.entries(options.paths).map(([key, targets]) => [key, targets.map(target => resolve(from, target))])), base };
  }
  const { paths } = await load(join(root, 'tsconfig.json'));
  return Object.entries(paths ?? {}).map(([key, targets]) => {
    const star = key.indexOf('*');
    return { prefix: star < 0 ? key : key.slice(0, star), suffix: star < 0 ? '' : key.slice(star + 1), wildcard: star >= 0, targets };
  }).sort((a, b) => b.prefix.length - a.prefix.length);
}

async function isFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

async function resolveFile(base: string): Promise<string | undefined> {
  if (readable.test(base) && await isFile(base)) return base;
  // TypeScript ESM imports name the emitted .js file.
  const typed = base.match(/^(.*)\.([cm]?)js(x?)$/);
  if (typed) for (const extension of [`.${typed[2]}ts${typed[3]}`, `.${typed[2]}tsx`]) if (await isFile(typed[1] + extension)) return typed[1] + extension;
  for (const extension of sourceExtensions) if (await isFile(base + extension)) return base + extension;
  for (const extension of sourceExtensions) if (await isFile(join(base, `index${extension}`))) return join(base, `index${extension}`);
}

const importPattern = /(?:\bimport\s*(?:[\w*{}\s,$]+\s*from\s*)?|\bexport\s*(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)(["'])([^"'\n]+)\1/g;

/** The message IDs a module names. Patterns from template literals are matched against every ID. */
function namedIds(code: string, ids: ReadonlySet<string>, all: readonly string[], found: Set<string>): void {
  for (const match of code.matchAll(/(["'])((?:(?!\1)[^\\\n]|\\.)+)\1/g)) if (ids.has(match[2]!)) found.add(match[2]!);
  // An apostrophe in JSX text or a comment shifts the pairing above. Every quote that
  // opens a token without spaces is also tried, so `Don't … t('home.title')` still counts.
  for (const match of code.matchAll(/(?=(["'`])([^"'`\s\\]{1,256})\1)/g)) if (ids.has(match[2]!)) found.add(match[2]!);
  for (const match of code.matchAll(/`((?:[^`\\]|\\.)*)`/g)) {
    const text = match[1]!;
    if (!text.includes('${')) { if (ids.has(text)) found.add(text); continue; }
    const parts = text.split(/\$\{[^}]*\}/);
    // `checkout.${step}.title`: the literal start must already name a message ID prefix.
    if (!/^[A-Za-z_$][\w$-]*\./.test(parts[0]!)) continue;
    const pattern = new RegExp(`^${parts.map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+')}$`);
    for (const id of all) if (pattern.test(id)) found.add(id);
  }
  // m.checkout.title: every run of segments names a candidate ID. The first segment is
  // usually the messages variable, but a destructured namespace (`checkout.title`) starts there.
  for (const match of code.matchAll(/(?<![\w$.])[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)+/g)) {
    const segments = match[0].replace(/\?\./g, '.').split('.');
    for (let start = 0; start < segments.length; start++) {
      for (let end = start + 1; end <= segments.length; end++) {
        const id = segments.slice(start, end).join('.');
        if (ids.has(id)) found.add(id);
      }
    }
  }
}

export interface ScopeModulesResult {
  readonly ids: string[];
  /** Every source file read, for watchers. */
  readonly files: string[];
}

/** The message IDs that a module names, found the way module scopes find them. */
export function sourceMessageIds(code: string, ids: readonly string[], known: ReadonlySet<string> = new Set(ids)): Set<string> {
  const found = new Set<string>();
  namedIds(code, known, ids, found);
  return found;
}

/** The base catalog IDs that the files matched by `modules`, and the files they import, name. */
export async function moduleScopeIds(options: { root: string; scope: string; modules: readonly string[]; exclude?: readonly string[]; ids: readonly string[]; outDir: string }): Promise<ScopeModulesResult> {
  const root = resolve(options.root);
  const outDir = resolve(root, options.outDir);
  const excluded = (options.exclude ?? []).map(glob => globPattern(glob.replace(/\\/g, '/').replace(/^\.\//, '')));
  const generated = (path: string) => path === outDir || path.startsWith(outDir + sep)
    || excluded.some(pattern => pattern.test(relative(root, path).split(sep).join('/')));
  const ids = new Set(options.ids);
  const aliases = await tsconfigAliases(root);
  const queue: string[] = [];
  for (const glob of options.modules) {
    const matched = await globFiles(root, glob, generated);
    if (!matched.length) {
      throw new CompileError([{ code: 'SCOPE_MODULE_NOT_FOUND', message: `Scope "${options.scope}" module pattern "${glob}" matches no files.` }]);
    }
    queue.push(...matched);
  }
  const reached = new Set<string>();
  const found = new Set<string>();
  async function target(specifier: string, from: string): Promise<string | undefined> {
    const bare = specifier.split(/[?#]/)[0]!;
    if (!bare || bare.startsWith('node:') || bare.startsWith('virtual:') || bare.startsWith('\0')) return;
    if (bare.startsWith('./') || bare.startsWith('../')) return resolveFile(resolve(dirname(from), bare));
    // Vite reads /src/... from the project root.
    if (bare.startsWith('/')) return await resolveFile(join(root, bare)) ?? (isAbsolute(bare) ? resolveFile(bare) : undefined);
    for (const alias of aliases) {
      if (!bare.startsWith(alias.prefix) || !bare.endsWith(alias.suffix) || (!alias.wildcard && bare !== alias.prefix)) continue;
      const middle = alias.wildcard ? bare.slice(alias.prefix.length, bare.length - alias.suffix.length) : '';
      for (const path of alias.targets) {
        const file = await resolveFile(path.replace('*', middle));
        if (file) return file;
      }
    }
  }
  while (queue.length) {
    const file = queue.shift()!;
    if (reached.has(file) || generated(file) || file.split(sep).includes('node_modules')) continue;
    reached.add(file);
    let code: string;
    try { code = await readFile(file, 'utf8'); } catch { continue; }
    namedIds(code, ids, options.ids, found);
    if (file.endsWith('.json')) continue;
    for (const match of code.matchAll(importPattern)) {
      const next = await target(match[2]!, file);
      if (next && !reached.has(next)) queue.push(next);
    }
  }
  return { ids: options.ids.filter(id => found.has(id)).sort(), files: [...reached].sort() };
}

/** Resolve module scopes to the message IDs their code names, plus their `messages` patterns. */
export async function resolveModuleScopes(options: { root?: string; outDir?: string; scopes?: Readonly<Record<string, ScopeConfig>> },
  baseIds: readonly string[] | undefined): Promise<{ scopes?: Record<string, readonly string[]>; files: string[]; computed: string[] }> {
  if (!options.scopes || !Object.values(options.scopes).some(isModuleScope)) return { scopes: options.scopes as Record<string, readonly string[]> | undefined, files: [], computed: [] };
  const scopes: Record<string, readonly string[]> = {};
  const files = new Set<string>();
  const errors = [];
  for (const [name, scope] of Object.entries(options.scopes)) {
    if (!isModuleScope(scope)) { scopes[name] = scope; continue; }
    if (!baseIds) { if (scope.messages?.length) scopes[name] = scope.messages; continue; }
    try {
      const result = await moduleScopeIds({ root: options.root ?? '.', scope: name, modules: scope.modules, exclude: scope.exclude, ids: baseIds, outDir: options.outDir ?? 'src/i18n' });
      for (const file of result.files) files.add(file);
      const patterns = [...(scope.messages ?? []), ...result.ids];
      if (!patterns.length) {
        errors.push({ code: 'EMPTY_SCOPE', message: `The modules of scope "${name}" name no messages. Check its module patterns, or list messages for it.` });
        continue;
      }
      scopes[name] = patterns;
    } catch (error) {
      if (!(error instanceof CompileError)) throw error;
      errors.push(...error.diagnostics);
    }
  }
  if (errors.length) throw new CompileError(errors);
  const computed = Object.keys(scopes).filter(name => isModuleScope(options.scopes![name]));
  return { scopes, files: [...files].sort(), computed };
}
