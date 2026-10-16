import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CompileError } from './diagnostics.js';
import type { Diagnostic } from './diagnostics.js';

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
  /** `false` stops the crawl at dynamic imports, for code split off behind a boundary that loads the full catalog. Default `true`. */
  readonly dynamicImports?: boolean;
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

// Group 1 is set for a dynamic `import(…)`. Imported names may be any identifier (`import { Sökförslag } from …`).
const importPattern = /(?:\bimport\s*(?:[\p{ID_Continue}$*{}\s,]+\s*from\s*)?|\bexport\s*(?:type\s+)?(?:\*(?:\s+as\s+[\p{ID_Continue}$]+)?|\{[^}]*\})\s*from\s*|\b(import)\s*\(\s*|\brequire\s*\(\s*)(["'])([^"'\n]+)\2/gu;

// Identifiers as JavaScript reads them, so `m.för()` and `m.Sökförslag()` are chains too.
const name = String.raw`[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*`;
// A computed segment with a string key: `m.video['för']`, `m.video?.["för"]`.
const keyed = String.raw`\[\s*(?:'[^'\\\n]*'|"[^"\\\n]*")\s*\]`;
const chainPattern = new RegExp(String.raw`(?<![\p{ID_Continue}$.\u200c\u200d])${name}(?:\??\.${name}|(?:\?\.)?${keyed})+`, 'gu');
const segmentPattern = new RegExp(String.raw`${name}|\[\s*(?:'([^'\\\n]*)'|"([^"\\\n]*)")\s*\]`, 'gu');
const templatePrefix = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d-]*\./u;

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
    if (!templatePrefix.test(parts[0]!)) continue;
    const pattern = new RegExp(`^${parts.map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+')}$`);
    for (const id of all) if (pattern.test(id)) found.add(id);
  }
  // m.checkout.title: every run of segments names a candidate ID. The first segment is
  // usually the messages variable, but a destructured namespace (`checkout.title`) starts there.
  for (const match of code.matchAll(chainPattern)) {
    const segments = [...match[0].matchAll(segmentPattern)].flatMap(segment => (segment[1] ?? segment[2] ?? segment[0]).split('.'));
    for (let start = 0; start < segments.length; start++) {
      for (let end = start + 1; end <= segments.length; end++) {
        const id = segments.slice(start, end).join('.');
        if (ids.has(id)) found.add(id);
      }
    }
  }
}

/** A read of the messages object with a computed key, such as `m[key]()` or `m.status[state]()`.
 * The crawl cannot tell which message it is, so a scope may lack it. */
export interface DynamicAccess {
  readonly file: string;
  /** One-based line and column, and zero-based UTF-16 offset, of the access in the file. */
  readonly location: { line: number; column: number; offset: number };
  readonly expression: string;
}

const ignoreMarker = 'nordbeam-locale-ignore';

/** Computed reads of the variables that hold messages in `code`. A variable holds messages when one
 * of its static chains names a message (`m` in `m.cart.total()`), or it is a namespace named like
 * one (`checkout` in `checkout.title()`). A string key, and a template whose literal start names
 * an ID prefix, are resolved by `namedIds` and are not reported. */
function dynamicAccesses(code: string, ids: ReadonlySet<string>, file: string): DynamicAccess[] {
  const roots = new Set<string>();
  for (const match of code.matchAll(chainPattern)) {
    const segments = [...match[0].matchAll(segmentPattern)].map(segment => segment[1] ?? segment[2] ?? segment[0]);
    const path = segments.flatMap(segment => segment.split('.'));
    for (let end = 2; end <= path.length; end++) {
      if (ids.has(path.slice(1, end).join('.')) || end > 2 && ids.has(path.slice(0, end).join('.'))) { roots.add(segments[0]!); break; }
    }
  }
  if (!roots.size) return [];
  const escaped = [...roots].map(root => root.replace(/[$]/g, '\\$&')).join('|');
  const access = new RegExp(String.raw`(?<![\p{ID_Continue}$.\u200c\u200d])(?:${escaped})(?:\??\.${name}|(?:\?\.)?${keyed})*\s*(?:\?\.)?\[\s*`, 'gu');
  const found: DynamicAccess[] = [];
  for (const match of code.matchAll(access)) {
    const rest = code.slice(match.index + match[0].length);
    const head = code.slice(match.index, match.index + match[0].length).replace(/\s*(?:\?\.)?\[\s*$/, '');
    if (/^['"]/.test(rest)) continue;
    const template = /^`((?:[^`\\]|\\.)*)`\s*\]/.exec(rest);
    // A template key on the messages object itself is resolved like a template literal.
    if (template && (!template[1]!.includes('${') || !head.includes('.') && !head.includes('[') && templatePrefix.test(template[1]!))) continue;
    // An ignore comment on the line, or on the line above, keeps a reviewed access quiet.
    const lineStart = code.lastIndexOf('\n', match.index) + 1, previous = code.lastIndexOf('\n', lineStart - 2) + 1;
    const lineEnd = code.indexOf('\n', match.index);
    if (code.slice(previous, lineEnd < 0 ? undefined : lineEnd).includes(ignoreMarker)) continue;
    const close = rest.indexOf(']');
    const line = code.slice(0, match.index).split('\n').length;
    found.push({ file, location: { line, column: match.index - lineStart + 1, offset: match.index }, expression: `${head}[${(close < 0 ? rest.slice(0, 40) : rest.slice(0, close)).trim().slice(0, 60)}]` });
  }
  return found;
}

export interface ScopeModulesResult {
  readonly ids: string[];
  /** Every source file read, for watchers. */
  readonly files: string[];
  /** With `trace`: how the crawl reached each file and which file first names each ID. */
  readonly trace?: ScopeTrace;
  /** Computed reads of the messages object in the files read. */
  readonly dynamic: DynamicAccess[];
}

/** Why a scope holds what it holds. Paths are absolute. */
export interface ScopeTrace {
  /** Each file read, with the file that imported it first (absent for a file that `modules` matches). */
  readonly files: ReadonlyMap<string, { readonly from?: string; readonly dynamic: boolean }>;
  /** Each message ID in the scope, with the files that name it, in crawl order. */
  readonly ids: ReadonlyMap<string, readonly string[]>;
}

/** The import chain from a `modules` file to `file`, first file first. */
export function importChain(trace: ScopeTrace, file: string): { file: string; dynamic: boolean }[] {
  const chain: { file: string; dynamic: boolean }[] = [];
  for (let current: string | undefined = file; current !== undefined && chain.length <= trace.files.size;) {
    const entry = trace.files.get(current);
    chain.unshift({ file: current, dynamic: entry?.dynamic ?? false });
    current = entry?.from;
  }
  return chain;
}

/** The message IDs that a module names, found the way module scopes find them. */
export function sourceMessageIds(code: string, ids: readonly string[], known: ReadonlySet<string> = new Set(ids)): Set<string> {
  const found = new Set<string>();
  namedIds(code, known, ids, found);
  return found;
}

/** The base catalog IDs that the files matched by `modules`, and the files they import, name. */
export async function moduleScopeIds(options: { root: string; scope: string; modules: readonly string[]; exclude?: readonly string[]; dynamicImports?: boolean; ids: readonly string[]; outDir: string; trace?: boolean }): Promise<ScopeModulesResult> {
  const root = resolve(options.root);
  const outDir = resolve(root, options.outDir);
  const excluded = (options.exclude ?? []).map(glob => globPattern(glob.replace(/\\/g, '/').replace(/^\.\//, '')));
  const generated = (path: string) => path === outDir || path.startsWith(outDir + sep)
    || excluded.some(pattern => pattern.test(relative(root, path).split(sep).join('/')));
  const ids = new Set(options.ids);
  const aliases = await tsconfigAliases(root);
  const queue: string[] = [];
  const files = new Map<string, { from?: string; dynamic: boolean }>();
  for (const glob of options.modules) {
    const matched = await globFiles(root, glob, generated);
    if (!matched.length) {
      throw new CompileError([{ code: 'SCOPE_MODULE_NOT_FOUND', message: `Scope "${options.scope}" module pattern "${glob}" matches no files.` }]);
    }
    queue.push(...matched);
    for (const file of matched) if (!files.has(file)) files.set(file, { dynamic: false });
  }
  const reached = new Set<string>();
  const found = new Set<string>();
  const namedBy = new Map<string, string[]>();
  const dynamic: DynamicAccess[] = [];
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
    if (options.trace) {
      const own = new Set<string>();
      namedIds(code, ids, options.ids, own);
      for (const id of own) { found.add(id); namedBy.get(id)?.push(file) ?? namedBy.set(id, [file]); }
    } else namedIds(code, ids, options.ids, found);
    if (file.endsWith('.json')) continue;
    dynamic.push(...dynamicAccesses(code, ids, file));
    for (const match of code.matchAll(importPattern)) {
      const dynamic = match[1] !== undefined;
      if (dynamic && options.dynamicImports === false) continue;
      const next = await target(match[3]!, file);
      if (!next || reached.has(next)) continue;
      queue.push(next);
      if (!files.has(next)) files.set(next, { from: file, dynamic });
    }
  }
  const result = { ids: options.ids.filter(id => found.has(id)).sort(), files: [...reached].sort(), dynamic };
  if (!options.trace) return result;
  for (const file of files.keys()) if (!reached.has(file)) files.delete(file);
  return { ...result, trace: { files, ids: new Map(result.ids.map(id => [id, namedBy.get(id) ?? []])) } };
}

/** Resolve module scopes to the message IDs their code names, plus their `messages` patterns. */
export async function resolveModuleScopes(options: { root?: string; outDir?: string; scopes?: Readonly<Record<string, ScopeConfig>> },
  baseIds: readonly string[] | undefined): Promise<{ scopes?: Record<string, readonly string[]>; files: string[]; computed: string[]; warnings: Diagnostic[] }> {
  if (!options.scopes || !Object.values(options.scopes).some(isModuleScope)) return { scopes: options.scopes as Record<string, readonly string[]> | undefined, files: [], computed: [], warnings: [] };
  const scopes: Record<string, readonly string[]> = {};
  const files = new Set<string>();
  const errors = [];
  // One warning per access, naming every scope whose crawl read it.
  const dynamic = new Map<string, { access: DynamicAccess; scopes: string[] }>();
  for (const [name, scope] of Object.entries(options.scopes)) {
    if (!isModuleScope(scope)) { scopes[name] = scope; continue; }
    if (!baseIds) { if (scope.messages?.length) scopes[name] = scope.messages; continue; }
    try {
      const result = await moduleScopeIds({ root: options.root ?? '.', scope: name, modules: scope.modules, exclude: scope.exclude, dynamicImports: scope.dynamicImports, ids: baseIds, outDir: options.outDir ?? 'src/i18n' });
      for (const file of result.files) files.add(file);
      for (const access of result.dynamic) {
        const key = `${access.file}\0${access.location.offset}`;
        dynamic.get(key)?.scopes.push(name) ?? dynamic.set(key, { access, scopes: [name] });
      }
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
  const root = resolve(options.root ?? '.');
  const warnings = [...dynamic.values()].map(({ access, scopes: names }): Diagnostic => ({
    code: 'SCOPE_DYNAMIC_ACCESS',
    message: `${relative(root, access.file).split(sep).join('/')}:${access.location.line} reads ${access.expression}, so the ${names.length > 1 ? 'scopes' : 'scope'} ${names.map(item => JSON.stringify(item)).join(', ')} cannot tell which message it is and may lack it.`,
    hint: `Read it with a literal key or a template such as m[\`status.\${state}\`](), keep a map of message functions such as { open: m.status.open }[state], or add its IDs to the scope's messages. A ${ignoreMarker} comment on the line keeps a reviewed read quiet.`,
    file: access.file,
    location: access.location,
  }));
  return { scopes, files: [...files].sort(), computed, warnings };
}
