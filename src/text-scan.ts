import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { Worker } from 'node:worker_threads';
import { CompileError } from './diagnostics.js';
import type { GenerateOptions } from './project.js';
import { globPattern } from './scope-modules.js';
import { createAnalyzer, normalizeText, opaqueElement, setVisitorKeys } from './text-scan-core.js';
import type { FileFacts, Node, RunItem, ScanContext, Sink, TextArgument, TextCandidate, TextKind, TextWrap } from './text-scan-core.js';

/** The `text` section of the config: how `hardcoded` and doctor look for text outside the catalog. */
export interface TextScanConfig {
  /** Globs relative to the project root that the scan skips, such as `src/dev/**`. */
  exclude?: readonly string[];
  /** Text that is never reported: exact strings, or `/pattern/flags`. */
  ignore?: readonly string[];
  /** More props and attributes that hold UI text: `tooltip` or `Tooltip.content`. */
  attributes?: readonly string[];
  /** More callees whose first argument is UI text, such as `notify` or `ui.toast`. */
  calls?: readonly string[];
}

export interface TextScanOptions extends GenerateOptions {
  sourceDir?: string;
  text?: TextScanConfig;
  /** Worker threads for large projects. Default: chosen from the file count and CPUs. */
  workers?: number;
}

export type TextConfidence = 'high' | 'medium';

export interface TextFinding {
  file: string;
  line: number;
  column: number;
  start: number;
  end: number;
  /** The text as a catalog message, with `{name}` for each value it shows. */
  text: string;
  kind: TextKind;
  where: string;
  confidence: TextConfidence;
  /** Why the scan reports it. */
  reason: string;
  /** Whether the file already renders messages. */
  context: 'mixed' | 'unlocalized';
  /** A catalog message with the same text. `exact` when it holds this text in the base locale,
   * and every inline translation too, so a fix can reuse it without changing what anyone sees. */
  catalog?: CatalogMatch;
  /** Text per locale when the source picks the language itself: `locale === "en" ? "Hi" : "Hej"`. */
  translations?: Record<string, string>;
  via?: string;
  args?: TextArgument[];
}

export interface TextArea { area: string; findings: number; files: number; localizedFiles: number }

export interface TextScanSummary {
  findings: number;
  high: number;
  medium: number;
  /** Findings whose text is already a catalog message. */
  inCatalog: number;
  /** Files with findings that already render messages, and those that render none. */
  mixedFiles: number;
  unlocalizedFiles: number;
  areas: TextArea[];
}

export interface LearnedSink { sink: string; messages: number; text: number }

export interface TextScanResult {
  root: string;
  sourceFiles: number;
  /** Files whose text the scan could not read: parse errors, a missing Vue or Svelte compiler. */
  incomplete: Array<{ file: string; reason: string }>;
  findings: TextFinding[];
  summary: TextScanSummary;
  /** Strings dropped as not UI text, by reason. */
  ignored: Record<string, number>;
  /** Positions the project shows hold UI text: they receive messages elsewhere. */
  learned: LearnedSink[];
  /** Per-file context the fix planner needs. Not part of the JSON contract. */
  files: Map<string, FileFacts>;
  translators: Map<string, number>;
  /** Wall time, parse time summed over threads, worker threads used, and files read from the cache. */
  timing: { ms: number; parseMs: number; workers: number; cached: number };
}

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const scriptExtensions = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const templateExtensions = new Set(['.vue', '.svelte']);
const ignoredDirectories = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.svelte-kit', '.output', '.vercel', '.turbo', 'coverage', 'target', 'out', '__tests__', '__mocks__', '__fixtures__', 'fixtures', 'mocks', 'e2e', 'cypress', 'playwright', '.storybook', 'stories', 'storybook-static', 'test', 'tests']);
const ignoredFile = /\.(?:test|spec|stories|story|e2e|cy|fixture|fixtures|mock|mocks|bench|d)\.[cm]?[jt]sx?$|\.gen\.[cm]?[jt]sx?$|^(?:routeTree\.gen|vite-env\.d|next-env\.d)\.ts$|(?:^|[-_.])(?:fixtures?|mocks?|mock-?data|seeds?|stubs?|test-?utils|test-setup|setup-?tests)\.[cm]?[jt]sx?$/;
// Calls whose arguments are data whatever the project passes them: never learned as text positions.
const genericCallee = /^(?:encodeURI(?:Component)?|decodeURI(?:Component)?|escape|String|Number|Boolean|BigInt|parseInt|parseFloat|isNaN|JSON\.\w+|Object\.\w+|Array\.\w+|Math\.\w+|console\.\w+|Date|RegExp|URL|URLSearchParams|fetch|require|setTimeout|setInterval|queueMicrotask|Promise\.\w+|Symbol|Reflect\.\w+|structuredClone|btoa|atob|Intl\.\w+|cn|clsx|classNames|cx|cva|twMerge|twJoin|new \w+)$|(?:^|\.)(?:replace|replaceAll|push|unshift|concat|join|split|includes|indexOf|lastIndexOf|startsWith|endsWith|set|get|has|add|delete|append|match|matchAll|test|exec|padStart|padEnd|slice|substring|trim|toLowerCase|toUpperCase|localeCompare|filter|map|find|some|every|reduce|sort|log|warn|debug|info|trace|assert|emit|dispatch|send|write|writeFile|readFile|query|select|insert|update|upsert|from|where|eq|neq|in|order|limit|setItem|getItem|removeItem|setAttribute|getAttribute|querySelector|querySelectorAll|addEventListener|removeEventListener|createElement|navigate|redirect|then|catch|finally|resolve|reject|format|parse|stringify|encode|decode|digest|update|hash|sign|verify)$/;

function fail(code: string, message: string, context: Record<string, unknown> = {}): never {
  throw new CompileError([{ code, message, ...context }]);
}

type Oxc = typeof import('oxc-parser');
let oxcModule: Promise<Oxc> | undefined;

/** oxc-parser is an optional dependency, loaded only when a text scan runs. */
export function loadOxc(): Promise<Oxc> {
  return oxcModule ??= import('oxc-parser').then(module => { setVisitorKeys(module.visitorKeys as Record<string, readonly string[]>); return module; }, error => {
    oxcModule = undefined;
    fail('TEXT_SCANNER_UNAVAILABLE', `The text scan needs the optional dependency oxc-parser, which could not be loaded: ${(error as Error).message}`, { hint: 'Install it with npm install --save-dev oxc-parser, or reinstall without --omit=optional.' });
  });
}

/** Directories the scan reads: --source-dir, or the usual application roots. */
function sourceRoots(root: string, sourceDir?: string): string[] {
  if (sourceDir !== undefined) return [resolve(root, sourceDir)];
  return ['src', 'app', 'pages', 'components', 'lib', 'routes'].map(directory => resolve(root, directory));
}

/** Source files under the roots. Synchronous: a walk of many small directories is several times faster than awaiting each. */
function listFiles(roots: readonly string[], skip: (file: string) => boolean): string[] {
  const files = new Set<string>();
  const walk = (directory: string): void => {
    let entries: Dirent[];
    try { entries = readdirSync(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return; throw error; }
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) { if (!ignoredDirectories.has(entry.name) && !entry.name.startsWith('.') && !skip(path + sep)) walk(path); }
      else if (entry.isFile()) {
        const extension = extname(entry.name);
        if ((scriptExtensions.has(extension) || templateExtensions.has(extension)) && !ignoredFile.test(entry.name) && !skip(path)) files.add(path);
      }
    }
  };
  for (const root of roots) walk(root);
  return [...files].sort(compare);
}

interface Catalogs { base: string; locales: string[]; texts: Map<string, Map<string, string>> }

function flatten(node: unknown, prefix: string, out: Map<string, string>): void {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;
  for (const [key, value] of Object.entries(node)) {
    const id = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(id, value); else flatten(value, id, out);
  }
}

/** Every locale's messages by ID. A catalog that fails to parse is skipped; check reports it. */
async function readCatalogs(root: string, options: GenerateOptions): Promise<Catalogs> {
  const directory = resolve(root, options.catalogs ?? 'messages');
  const texts = new Map<string, Map<string, string>>();
  let names: string[] = [];
  try { names = (await readdir(directory)).filter(name => name.endsWith('.json')).sort(compare); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await Promise.all(names.map(async name => {
    const messages = new Map<string, string>();
    try { flatten(JSON.parse(await readFile(resolve(directory, name), 'utf8')), '', messages); } catch { return; }
    texts.set(name.slice(0, -5), messages);
  }));
  return { base: options.baseLocale, locales: [...texts.keys()].sort(compare), texts };
}

/** Parse `/pattern/flags` entries; others match the whole text exactly. */
function ignoreMatcher(entries: readonly string[] = []): (text: string) => boolean {
  const exact = new Set<string>(), patterns: RegExp[] = [];
  for (const entry of entries) {
    const match = /^\/(.+)\/([a-z]*)$/s.exec(entry);
    if (match) { try { patterns.push(new RegExp(match[1]!, match[2])); continue; } catch { /* validated in config */ } }
    exact.add(normalizeText(entry));
  }
  return text => exact.has(text) || patterns.some(pattern => pattern.test(text));
}

// Template adapters ------------------------------------------------------------

type ParseFile = (file: string, code: string) => { program: Node; comments: Array<{ value: string; start: number; end: number }>; errors: Array<{ message: string; labels?: Array<{ start: number }> }> };

function emptyFacts(): FileFacts {
  return { localized: 0, dynamic: {}, translators: {}, plainCalls: {}, evidence: [], candidates: [], scopes: [[-1, []]], imports: [], messages: [], style: { dotted: 0, bracket: 0 }, ignored: {} };
}

function shift(node: unknown, delta: number): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const item of node) shift(item, delta); return; }
  const record = node as Record<string, unknown>;
  if (typeof record.start === 'number' && typeof record.end === 'number') { record.start += delta; record.end = (record.end as number) + delta; }
  for (const key in record) if (key !== 'start' && key !== 'end' && key !== 'range' && key !== 'loc') { const value = record[key]; if (value && typeof value === 'object') shift(value, delta); }
}

/** HTML comments carry ignore markers in templates; JS comments come from the parser. */
function htmlComments(code: string): Array<{ value: string; start: number; end: number }> {
  const comments: Array<{ value: string; start: number; end: number }> = [];
  for (const match of code.matchAll(/<!--([\s\S]*?)-->/g)) comments.push({ value: match[1]!, start: match.index!, end: match.index! + match[0].length });
  return comments;
}

const camel = (name: string): string => name.startsWith('aria-') || name.startsWith('data-') ? name : name.replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase());
const templateText: Sink = { key: 'child', where: 'template text', kind: 'template-text', base: 2, position: 'child', wrap: 'jsx' };
const templateExpression: Sink = { key: 'child', where: 'template text', kind: 'jsx-expression', base: 2, position: 'child', wrap: 'expression' };

function analyzeVue(file: string, code: string, context: ScanContext, parseScript: ParseFile, sfc: { parse: (code: string, options: object) => { descriptor: any; errors: unknown[] } }): FileFacts {
  const { descriptor, errors } = sfc.parse(code, { filename: file, sourceMap: false });
  if (errors.length && !descriptor.template) throw new Error(String((errors[0] as Error).message ?? errors[0]));
  const facts = emptyFacts();
  // One program from both script blocks, the rest blanked so offsets stay those of the file.
  const blocks = [descriptor.script, descriptor.scriptSetup].filter(Boolean) as Array<{ content: string; loc: { start: { offset: number } }; lang?: string }>;
  let masked = code.replace(/[^\n]/g, ' ');
  let lang = 'js';
  for (const block of blocks) {
    const start = block.loc.start.offset;
    masked = masked.slice(0, start) + block.content + masked.slice(start + block.content.length);
    if (block.lang) lang = block.lang;
  }
  const script = blocks.length ? parseScript(`${file}.${/^(?:ts|tsx|js|jsx)$/.test(lang) ? lang : 'js'}`, masked) : undefined;
  const analyzer = createAnalyzer(facts, code, context, [...(script?.comments ?? []), ...htmlComments(code)]);
  if (script) analyzer.program(script.program);
  const expression = (source: string, offset: number, statements = false): Node | undefined => {
    const parsed = parseScript('expression.ts', statements ? source : `(${source})`);
    if (parsed.errors.length) return statements ? undefined : expression(source, offset, true);
    shift(parsed.program, statements ? offset : offset - 1);
    return statements ? parsed.program : parsed.program.body[0]?.expression;
  };
  const ast = descriptor.template?.ast;
  if (ast) {
    const first = ast.children.find((node: any) => node.loc);
    const delta = first && code.slice(first.loc.start.offset, first.loc.end.offset) !== first.loc.source ? descriptor.template.loc.start.offset : 0;
    const offset = (location: { offset: number }): number => location.offset + delta;
    const walk = (nodes: any[]): void => {
      const items: RunItem[] = [];
      for (const node of nodes) {
        if (node.type === 2) {
          const raw: string = node.loc.source, text = node.content.replace(/\s+/g, ' ');
          if (!text.trim() && !items.length) continue;
          const lead = raw.length - raw.trimStart().length, trail = raw.length - raw.trimEnd().length;
          items.push(raw.trim() ? { text, start: offset(node.loc.start) + lead, end: offset(node.loc.end) - trail } : { text, start: offset(node.loc.start), end: offset(node.loc.end) });
        } else if (node.type === 5) {
          const parsed = expression(node.content.content, offset(node.content.loc.start));
          if (parsed) items.push({ expression: parsed, start: offset(node.loc.start), end: offset(node.loc.end) });
        } else if (node.type === 1) items.push({ other: () => element(node) });
      }
      analyzer.run(items, { ...templateText, wrap: 'mustache' }, templateExpression);
    };
    const element = (node: any): void => {
      const name: string = node.tag, intrinsic = node.tagType === 0;
      const attribute = (key: string): string | undefined => node.props.find((prop: any) => prop.type === 6 && prop.name === key)?.value?.content;
      const skip = opaqueElement(name) || attribute('translate') === 'no' || /\bnotranslate\b/.test(attribute('class') ?? '') || node.props.some((prop: any) => prop.type === 6 && prop.name === 'data-nordbeam-locale-ignore' || prop.type === 7 && prop.name === 'pre');
      analyzer.cover(offset(node.loc.start), offset(node.loc.end));
      if (skip) analyzer.opaque(1);
      const type = attribute('type');
      for (const prop of node.props) {
        if (prop.type === 6) {
          if (!prop.value) continue;
          const sink = analyzer.attributeSink(name, camel(prop.name), intrinsic, type);
          if (sink) analyzer.text(prop.value.content, offset(prop.loc.start), offset(prop.loc.end), { ...sink, where: `<${name} ${prop.name}>`, wrap: `bind:${prop.name}` });
        } else if (prop.type === 7 && prop.exp && prop.name !== 'for' && prop.name !== 'slot' && prop.name !== 'html') {
          const parsed = expression(prop.exp.content, offset(prop.exp.loc.start));
          if (!parsed) continue;
          const sink = prop.name === 'bind' && prop.arg?.isStatic ? analyzer.attributeSink(name, camel(prop.arg.content), intrinsic, type) : prop.name === 'text' ? templateExpression : undefined;
          if (sink) analyzer.value(parsed, { ...sink, wrap: 'expression' }); else analyzer.visit(parsed);
        }
      }
      if (!/^(?:script|style)$/.test(name)) walk(node.children);
      if (skip) analyzer.opaque(-1);
    };
    walk(ast.children);
  }
  analyzer.finish();
  if (script?.errors.length) facts.parseErrors = script.errors.map(error => ({ message: error.message, offset: error.labels?.[0]?.start ?? 0 }));
  return facts;
}

function analyzeSvelte(file: string, code: string, context: ScanContext, svelte: { parse: (code: string, options: object) => any }): FileFacts {
  const ast = svelte.parse(code, { modern: true, filename: file });
  const facts = emptyFacts();
  const comments = [...((ast.comments ?? []) as Array<{ value: string; start: number; end: number }>), ...htmlComments(code)];
  const analyzer = createAnalyzer(facts, code, context, comments);
  if (ast.module?.content) analyzer.program(ast.module.content);
  if (ast.instance?.content) analyzer.program(ast.instance.content);
  const fragment = (nodes: any[]): void => {
    const items: RunItem[] = [];
    for (const node of nodes) {
      switch (node.type) {
        case 'Text': {
          const raw: string = node.raw, text = node.data.replace(/\s+/g, ' ');
          if (!text.trim() && !items.length) continue;
          const lead = raw.length - raw.trimStart().length, trail = raw.length - raw.trimEnd().length;
          items.push(raw.trim() ? { text, start: node.start + lead, end: node.end - trail } : { text, start: node.start, end: node.end });
          break;
        }
        case 'ExpressionTag': items.push({ expression: node.expression, start: node.start, end: node.end }); break;
        case 'Comment': break;
        default: items.push({ other: () => block(node) });
      }
    }
    analyzer.run(items, templateText, templateExpression);
  };
  const block = (node: any): void => {
    switch (node.type) {
      case 'IfBlock': analyzer.visit(node.test); fragment(node.consequent.nodes); if (node.alternate) fragment(node.alternate.nodes); return;
      case 'EachBlock': analyzer.visit(node.expression); fragment(node.body.nodes); if (node.fallback) fragment(node.fallback.nodes); return;
      case 'AwaitBlock': analyzer.visit(node.expression); for (const part of [node.pending, node.then, node.catch]) if (part) fragment(part.nodes); return;
      case 'KeyBlock': analyzer.visit(node.expression); fragment(node.fragment.nodes); return;
      case 'SnippetBlock': fragment(node.body.nodes); return;
      case 'RenderTag': case 'HtmlTag': analyzer.visit(node.expression); return;
      case 'ConstTag': analyzer.visit(node.declaration); return;
      case 'DebugTag': return;
    }
    if (!Array.isArray(node.attributes)) return;
    const name: string = node.name, intrinsic = node.type === 'RegularElement' || node.type === 'TitleElement';
    const attribute = (key: string): string | undefined => {
      const value = node.attributes.find((item: any) => item.type === 'Attribute' && item.name === key)?.value;
      return Array.isArray(value) && value.length === 1 && value[0].type === 'Text' ? value[0].data : undefined;
    };
    const skip = opaqueElement(name) || attribute('translate') === 'no' || /\bnotranslate\b/.test(attribute('class') ?? '') || node.attributes.some((item: any) => item.type === 'Attribute' && item.name === 'data-nordbeam-locale-ignore');
    analyzer.cover(node.start, node.end);
    if (skip) analyzer.opaque(1);
    const type = attribute('type');
    for (const item of node.attributes) {
      if (item.type !== 'Attribute') { if (item.expression) analyzer.visit(item.expression); continue; }
      const sink = analyzer.attributeSink(name, item.name, intrinsic, type);
      const value = item.value;
      if (value === true) continue;
      const parts = Array.isArray(value) ? value : [value];
      if (!sink) { for (const part of parts) if (part.type === 'ExpressionTag') analyzer.visit(part.expression); continue; }
      if (parts.length === 1 && parts[0].type === 'ExpressionTag') { analyzer.value(parts[0].expression, { ...sink, wrap: 'expression' }); continue; }
      analyzer.run(parts.map((part: any) => part.type === 'Text' ? { text: part.data, start: part.start, end: part.end } : { expression: part.expression, start: part.start, end: part.end }), { ...sink, wrap: 'jsx' }, { ...sink, wrap: 'expression' });
    }
    if (node.fragment && !/^(?:script|style)$/.test(name)) fragment(node.fragment.nodes);
    if (skip) analyzer.opaque(-1);
  };
  fragment(ast.fragment.nodes);
  analyzer.finish();
  return facts;
}

// File analysis, shared by the main thread and workers -------------------------

export interface FileTask { file: string; code?: string }
export interface FileResult { file: string; facts?: FileFacts; error?: string; parseMs: number }
export type FileAnalyzer = (task: FileTask) => FileResult | Promise<FileResult>;

/** Analyze one file at a time with the parsers loaded from `root`. Used on the main thread and in workers. */
export async function fileAnalyzer(context: ScanContext, root: string): Promise<FileAnalyzer> {
  const oxc = await loadOxc();
  // The JavaScript shape of the tree leaves out type annotations, which the analysis never reads: a quarter fewer objects.
  const scriptOptions = { preserveParens: false, astType: 'js', ...(oxc.rawTransferSupported() ? { experimentalRawTransfer: true } : {}) } as object;
  const parseScript: ParseFile = (file, code) => oxc.parseSync(file, code, scriptOptions) as any;
  const parseExpression: ParseFile = (file, code) => oxc.parseSync(file, code, { preserveParens: false }) as any;
  let vue: Promise<any> | undefined, svelte: Promise<any> | undefined;
  const template = async (file: string, code: string, kind: 'vue' | 'svelte'): Promise<FileResult> => {
    const compiler = await (kind === 'vue' ? vue ??= templateCompiler(root, ['vue/compiler-sfc', '@vue/compiler-sfc']) : svelte ??= templateCompiler(root, ['svelte/compiler']));
    if (!compiler) return { file, error: `Install ${kind} to scan .${kind} templates.`, parseMs: 0 };
    const started = performance.now();
    try { return { file, facts: kind === 'vue' ? analyzeVue(file, code, context, parseExpression, compiler) : analyzeSvelte(file, code, context, compiler), parseMs: performance.now() - started }; }
    catch (error) { return { file, error: (error as Error).message.split('\n')[0]!, parseMs: performance.now() - started }; }
  };
  return ({ file, code: given }) => {
    let code: string;
    // A synchronous read: for one small file, awaiting costs more than reading.
    try { code = given ?? readFileSync(file, 'utf8'); }
    catch (error) { return { file, error: (error as Error).message, parseMs: 0 }; }
    if (code.includes('nordbeam-locale-ignore-file')) return { file, facts: { ...emptyFacts(), skipped: true }, parseMs: 0 };
    const extension = extname(file);
    if (extension === '.vue' || extension === '.svelte') return template(file, code, extension.slice(1) as 'vue' | 'svelte');
    const started = performance.now();
    try {
      const parsed = parseScript(file, code);
      const facts = emptyFacts();
      const analyzer = createAnalyzer(facts, code, context, parsed.comments);
      analyzer.program(parsed.program);
      analyzer.finish();
      if (parsed.errors.length) facts.parseErrors = parsed.errors.map(error => ({ message: error.message, offset: error.labels?.[0]?.start ?? 0 }));
      return { file, facts, parseMs: performance.now() - started };
    } catch (error) {
      return { file, error: (error as Error).message.split('\n')[0]!, parseMs: performance.now() - started };
    }
  };
}

/** Analyze files on this thread. */
export async function analyzeFiles(files: Iterable<FileTask>, context: ScanContext, root: string): Promise<FileResult[]> {
  const analyze = await fileAnalyzer(context, root);
  const results: FileResult[] = [];
  for (const task of files) { const result = analyze(task); results.push(result instanceof Promise ? await result : result); }
  return results;
}

/** The project's own Vue or Svelte compiler, so templates parse the way the app builds them. */
async function templateCompiler(root: string, specifiers: readonly string[]): Promise<any> {
  const requires = [createRequire(resolve(root, 'package.json')), createRequire(import.meta.url)];
  for (const require of requires) for (const specifier of specifiers) {
    try {
      // A CommonJS build (svelte/compiler under require conditions) arrives as the default export.
      const module = await import(require.resolve(specifier));
      return module.parse ? module : module.default ?? module;
    } catch { /* try the next */ }
  }
  return undefined;
}

interface TextCache { version: number; context: string; files: Record<string, [stamp: string, facts: FileFacts]> }

/** What a cache entry depends on besides its file: the catalog IDs, configuration, locales and the scanner build. */
async function contextDigest(context: ScanContext): Promise<string> {
  const hash = createHash('sha256');
  hash.update(JSON.stringify([[...context.ids].sort(), [...context.attributes].sort(), [...context.calls].sort(), context.locales, context.base]));
  for (const module of ['./text-scan-core.js', './text-noise.js', './text-scan.js']) {
    try { const info = await stat(new URL(module, import.meta.url)); hash.update(`${module}:${info.size}:${info.mtimeMs}`); } catch { hash.update(module); }
  }
  return hash.digest('hex');
}

async function fileStamp(file: string): Promise<string | undefined> {
  try { const info = await stat(file, { bigint: true }); return `${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.ino}`; } catch { return undefined; }
}

/** The text scan's entry in the persistent cache directory: per-file facts, invalid as a whole when the context changes. */
async function openCache(root: string, setting: string | true, context: ScanContext, files: readonly string[]) {
  const path = resolve(root, typeof setting === 'string' ? setting : 'node_modules/.cache/nordbeam-locale', 'text-scan.json');
  const digest = await contextDigest(context);
  let stored: TextCache | undefined;
  try { stored = JSON.parse(await readFile(path, 'utf8')) as TextCache; } catch { /* no cache yet, or unreadable: start over */ }
  const entries = stored?.version === 1 && stored.context === digest ? stored.files : {};
  // Stamps are taken before the files are read, so a file that changes meanwhile is read again next time.
  const stamps = new Map(await Promise.all(files.map(async file => [file, await fileStamp(file)] as const)));
  const hits = new Map<string, FileResult>();
  for (const file of files) {
    const entry = entries[relative(root, file)], stamp = stamps.get(file);
    if (entry && stamp && entry[0] === stamp) hits.set(file, { file, facts: entry[1], parseMs: 0 });
  }
  return {
    hits,
    async save(fresh: readonly FileResult[]): Promise<void> {
      const listed = new Set(files.map(file => relative(root, file)));
      const stale = Object.keys(entries).some(key => !listed.has(key));
      if (!fresh.length && !stale) return;
      const next: TextCache = { version: 1, context: digest, files: {} };
      for (const [file, result] of hits) next.files[relative(root, file)] = [stamps.get(file)!, result.facts!];
      for (const result of fresh) { const stamp = stamps.get(result.file); if (result.facts && stamp) next.files[relative(root, result.file)] = [stamp, result.facts]; }
      try {
        await mkdir(dirname(path), { recursive: true });
        const temporary = `${path}.${process.pid}.tmp`;
        await writeFile(temporary, JSON.stringify(next));
        await rename(temporary, path);
      } catch { /* A cache that cannot be written only costs speed. */ }
    },
  };
}

/**
 * Threads for a scan of these files, or 1 when one thread is as fast.
 * Workers boot while the main thread reads the catalogs, so they pay off from a
 * few dozen files, or fewer large ones. Each also pays for its own JIT warm-up,
 * which makes the best count grow with the square root of the work: 2 for 40
 * files, 4 for 200, 8 for 1,000.
 */
function workerCount(files: readonly string[], requested?: number): number {
  if (requested !== undefined) return requested;
  const count = files.length;
  if (count < 8 || count < 32 && files.reduce((bytes, file) => { try { return bytes + statSync(file).size; } catch { return bytes; } }, 0) < 256 * 1024) return 1;
  return Math.min(8, Math.max(1, availableParallelism() - 1), Math.max(2, Math.round(Math.sqrt(count) / 4)));
}

interface WorkerReply { results?: FileResult[]; done?: boolean; error?: string; diagnostics?: ConstructorParameters<typeof CompileError>[0] }

/**
 * Worker threads for a large scan. They start as soon as the file count is
 * known and load the parser while the catalogs are read; then each takes the
 * next file from a shared counter, largest first, so they finish together.
 */
function workerPool(count: number, root: string) {
  // Workers inherit the process's flags, but --input-type (from `node --input-type=module -e`) stops them loading
  // their file. They need none of the flags, and a list given explicitly must hold only flags a worker accepts.
  const execArgv = process.execArgv.some(flag => flag.startsWith('--input-type')) ? [] : undefined;
  const workers = Array.from({ length: count }, () => new Worker(new URL('./text-scan-worker.js', import.meta.url), { workerData: { root }, ...(execArgv ? { execArgv } : {}) }));
  const close = (): void => { for (const worker of workers) void worker.terminate(); };
  return {
    size: count,
    close,
    async run(files: readonly string[], context: ScanContext, onResult: (result: FileResult) => void): Promise<FileResult[]> {
      const counter = new SharedArrayBuffer(4), results: FileResult[] = [];
      try {
        await Promise.all(workers.map(worker => new Promise<void>((done, reject) => {
          worker.on('message', (reply: WorkerReply) => {
            if (reply.error) { reject(reply.diagnostics ? new CompileError(reply.diagnostics) : new Error(reply.error)); return; }
            for (const result of reply.results!) { results.push(result); onResult(result); }
            if (reply.done) done();
          });
          worker.once('error', reject);
          worker.once('exit', code => reject(new Error(`A text scan worker stopped early with exit code ${code}.`)));
          worker.postMessage({ files, context, counter });
        })));
      } finally { close(); }
      return results;
    },
  };
}

/** Files ordered largest first, so the last files taken are small ones. */
async function largestFirst(files: readonly string[]): Promise<string[]> {
  const sizes = await Promise.all(files.map(file => stat(file).then(info => info.size, () => 0)));
  return files.map((file, index) => ({ file, size: sizes[index]! })).sort((a, b) => b.size - a.size).map(item => item.file);
}

export function scanContext(ids: Iterable<string>, config: TextScanConfig = {}, locales: readonly string[] = [], base = locales[0] ?? 'en', intlLocales?: Readonly<Record<string, string>>): ScanContext {
  const set = new Set(ids), namespaces = new Set<string>();
  for (const id of set) for (let i = id.indexOf('.'); i !== -1; i = id.indexOf('.', i + 1)) namespaces.add(id.slice(0, i));
  // "en", "english" and "en" itself name English; "sv", "swedish" and "svenska" name Swedish.
  const localeNames = new Map<string, string[]>();
  for (const locale of locales) {
    // A code that intlLocales maps (se for Swedish) is named by its tag's language: sv, swedish, svenska.
    const tag = intlLocales && Object.hasOwn(intlLocales, locale) ? intlLocales[locale]! : locale;
    const language = tag.split('-')[0]!.toLowerCase(), names = new Set([locale.toLowerCase().replace(/[^a-z]/g, ''), language]);
    for (const display of [tag, 'en']) {
      try { const name = new Intl.DisplayNames([display], { type: 'language' }).of(language); if (name) names.add(name.normalize('NFD').replace(/[^A-Za-z]/g, '').toLowerCase()); } catch { /* unknown locale */ }
    }
    localeNames.set(locale, [...names]);
  }
  return { ids: set, namespaces, attributes: new Set(config.attributes ?? []), calls: new Set(config.calls ?? []), locales, base, localeNames };
}

// The project pass -------------------------------------------------------------

/** Text identical in every locale, and capitalized words every locale uses: product and brand names. */
function invariants(catalogs: Catalogs): { texts: Set<string>; words: Set<string> } {
  const texts = new Set<string>(), words = new Set<string>();
  const maps = [...catalogs.texts.values()];
  if (maps.length < 2) return { texts, words };
  const [first, ...rest] = maps;
  for (const [id, text] of first!) if (rest.every(map => map.get(id) === text)) texts.add(normalizeText(text));
  const counts = maps.map(map => { const counted = new Map<string, number>(); for (const text of map.values()) for (const word of text.match(/[\p{Lu}\d][\p{L}\d&+.-]*[\p{L}\d]|\b\p{Lu}{2,}\b/gu) ?? []) counted.set(word, (counted.get(word) ?? 0) + 1); return counted; });
  // A name appears about as often in every locale: "Fortnox" does, but "Open" in one Swedish "Open Banking" does not.
  for (const [word, count] of counts[0]!) {
    const all = counts.map(counted => counted.get(word) ?? 0);
    if (Math.min(...all) >= Math.max(...all) * 0.5) words.add(word);
  }
  return { texts, words };
}

/** Catalog text by normalized shape, `{}` for each simple argument. Plurals, selects and tags never match. */
function catalogIndex(catalogs: Catalogs): Map<string, Array<{ id: string; locale: string; names: string[] }>> {
  const index = new Map<string, Array<{ id: string; locale: string; names: string[] }>>();
  const locales = [catalogs.base, ...catalogs.locales.filter(locale => locale !== catalogs.base)];
  for (const locale of locales) {
    for (const [id, text] of catalogs.texts.get(locale) ?? []) {
      if (/[<]|\{[^{}]*,/.test(text)) continue;
      const names: string[] = [];
      const shape = normalizeText(text.replace(/\{\s*([\w$]+)\s*\}/g, (_, name: string) => { names.push(name); return '{}'; }));
      let entries = index.get(shape);
      if (!entries) index.set(shape, entries = []);
      entries.push({ id, locale, names });
    }
  }
  return index;
}
const shapeOf = (text: string): string => normalizeText(text.replace(/\{[\w$]+\}/g, '{}'));

export interface CatalogMatch {
  id: string;
  /** The locale whose text matched. */
  locale: string;
  /** The message renders the same text in the base locale (and in every locale the source spells out). */
  exact: boolean;
  /** Other messages that match as exactly, when there are several. */
  alternatives?: string[];
}

/** The catalog message with this text. Inline translations prefer an ID whose locales match theirs. */
function catalogMatch(index: ReturnType<typeof catalogIndex>, candidate: TextCandidate, argumentCount: number, base: string): CatalogMatch | undefined {
  const fits = (text: string, locale?: string) => (index.get(shapeOf(text)) ?? []).filter(entry => entry.names.length === argumentCount && (!locale || entry.locale === locale));
  const exact = (ids: string[], locale: string): CatalogMatch => ({ id: ids[0]!, locale, exact: true, ...(ids.length > 1 ? { alternatives: ids.slice(1, 20) } : {}) });
  if (candidate.translations) {
    const [first, ...rest] = Object.entries(candidate.translations);
    const agreed = fits(first![1], first![0]).filter(entry => rest.every(([locale, text]) => fits(text, locale).some(other => other.id === entry.id)));
    if (agreed.length) return exact(agreed.map(entry => entry.id), agreed[0]!.locale);
    for (const [locale, text] of Object.entries(candidate.translations)) { const entry = fits(text, locale)[0]; if (entry) return { id: entry.id, locale: entry.locale, exact: false }; }
    return undefined;
  }
  const entries = fits(candidate.text), based = entries.filter(item => item.locale === base);
  if (based.length) return exact(based.map(entry => entry.id), base);
  return entries[0] && { id: entries[0].id, locale: entries[0].locale, exact: false };
}

/** The folder a finding is counted under: up to three levels below the root. */
export function textArea(root: string, file: string): string {
  const parts = relative(root, dirname(file)).split(sep).filter(Boolean);
  return parts.slice(0, Math.min(parts.length, 3)).join('/') || '.';
}

const sinkLabel = (sink: string): string => {
  if (sink.startsWith('key:')) return `${sink.slice(4)}:`;
  if (sink.startsWith('call:')) { const [name, index] = sink.slice(5).split('#'); return `${name}() argument ${Number(index) + 1}`; }
  if (sink.startsWith('elem:')) { const [element, prop] = sink.slice(5).split('#'); return `<${element} ${prop}>`; }
  if (sink.startsWith('attr:')) return `${sink.slice(5)} props`;
  if (sink.startsWith('set:')) return `.${sink.slice(4)} =`;
  return sink;
};

/** What a candidate's verdict needs from the catalogs and the configuration alone. */
interface Prepared { shape: string; drop?: 'config' | 'same in every locale'; match?: CatalogMatch }

function catalogVerdicts(catalogs: Catalogs, config: TextScanConfig) {
  const ignore = ignoreMatcher(config.ignore), invariant = invariants(catalogs), index = catalogIndex(catalogs);
  const prepare = (candidate: TextCandidate): Prepared => {
    const shape = shapeOf(candidate.text), normalized = normalizeText(candidate.text);
    if (ignore(normalized) || ignore(candidate.text)) return { shape, drop: 'config' };
    const words = normalized.match(/[\p{L}\d][\p{L}\d&+.'-]*/gu) ?? [];
    if (invariant.texts.has(normalized) || words.length && words.length <= 4 && words.every(word => invariant.words.has(word))) return { shape, drop: 'same in every locale' };
    const match = catalogMatch(index, candidate, candidate.args?.length ?? 0, catalogs.base);
    return match ? { shape, match } : { shape };
  };
  return { index, prepare };
}

/** Scan the project's source for UI text that is not a catalog message. */
export async function scanText(options: TextScanOptions): Promise<TextScanResult> {
  const started = performance.now();
  const root = resolve(options.root ?? '.');
  const config = options.text ?? {};
  const excluded = [options.catalogs ?? 'messages', options.outDir ?? 'src/i18n'].map(path => resolve(root, path));
  const globs = (config.exclude ?? []).map(glob => globPattern(glob.replace(/\\/g, '/').replace(/^\.\//, '')));
  const skip = (path: string): boolean => {
    if (excluded.some(directory => path === directory + sep || path.startsWith(directory + sep))) return true;
    if (!globs.length) return false;
    const relativePath = relative(root, path).split(sep).join('/');
    return globs.some(glob => glob.test(relativePath) || glob.test(relativePath.replace(/\/$/, '')));
  };
  const reading = readCatalogs(root, options);
  const files = listFiles(sourceRoots(root, options.sourceDir), skip);
  // Without a cache every file is parsed: start the workers now, so they boot while the catalogs load.
  const early = options.persistentCache ? 1 : workerCount(files, options.workers);
  let pool = early > 1 ? workerPool(early, root) : undefined;
  let fresh: FileResult[], cache: Awaited<ReturnType<typeof openCache>> | undefined, catalogs: Catalogs;
  let verdicts: ReturnType<typeof catalogVerdicts> | undefined;
  // Each file's catalog verdicts are worked out as its facts arrive, while other files are still being analyzed.
  const prepared = new Map<string, Prepared[]>();
  const onResult = (result: FileResult): void => { if (verdicts && result.facts) prepared.set(result.file, result.facts.candidates.map(verdicts.prepare)); };
  try {
    const ordering = pool ? largestFirst(files) : undefined;
    catalogs = await reading;
    const context = scanContext((catalogs.texts.get(catalogs.base) ?? new Map<string, string>()).keys(), config, catalogs.locales, catalogs.base, options.intlLocales);
    // With persistentCache, a file whose stamp and scan context are unchanged reuses its facts.
    cache = options.persistentCache ? await openCache(root, options.persistentCache, context, files) : undefined;
    const pending = cache ? files.filter(file => !cache!.hits.has(file)) : files;
    if (cache) { const count = workerCount(pending, options.workers); if (count > 1) pool = workerPool(count, root); }
    const analyzing = !pending.length ? Promise.resolve([]) : pool ? pool.run(await (ordering ?? largestFirst(pending)), context, onResult) : analyzeFiles(pending.map(file => ({ file })), context, root);
    // While the files are analyzed: what scoring needs from the catalogs alone.
    verdicts = catalogVerdicts(catalogs, config);
    fresh = await analyzing;
  } finally { pool?.close(); }
  const workers = pool?.size ?? 1;
  const freshByFile = new Map(fresh.map(result => [result.file, result] as const));
  // In file order whatever order the threads finished in, so the result is the same every run.
  const results = files.map(file => cache?.hits.get(file) ?? freshByFile.get(file)!);
  if (cache) await cache.save(fresh);

  // Learn: which callees translate, which positions receive messages.
  const facts = new Map<string, FileFacts>();
  const incomplete: Array<{ file: string; reason: string }> = [];
  const idCalls = new Map<string, [number, number]>(), plainCalls = new Map<string, number>();
  let parseMs = 0;
  for (const result of results) {
    parseMs += result.parseMs;
    if (result.error || !result.facts) { incomplete.push({ file: result.file, reason: result.error ?? 'unreadable' }); continue; }
    if (result.facts.skipped) continue;
    facts.set(result.file, result.facts);
    if (result.facts.parseErrors?.length) incomplete.push({ file: result.file, reason: result.facts.parseErrors[0]!.message });
    for (const [name, [index, calls]] of Object.entries(result.facts.translators)) { const seen = idCalls.get(name); idCalls.set(name, [seen?.[0] ?? index, (seen?.[1] ?? 0) + calls]); }
    for (const [name, calls] of Object.entries(result.facts.plainCalls)) plainCalls.set(name, (plainCalls.get(name) ?? 0) + calls);
  }
  // A translator takes IDs far more often than other strings: `t("checkout.pay")`, not `run("checkout.pay")` once.
  const translators = new Map<string, number>();
  for (const [name, [index, calls]] of idCalls) if ((calls >= 2 || /^(?:t|translate|\$t)$/.test(name)) && (plainCalls.get(name) ?? 0) <= calls / 2) translators.set(name, index);
  const evidence = new Map<string, number>(), textCounts = new Map<string, number>();
  const localizedFiles = new Set<string>();
  for (const [file, item] of facts) {
    let localized = item.localized;
    for (const [name, calls] of Object.entries(item.dynamic)) if (translators.has(name)) localized += calls;
    if (localized) localizedFiles.add(file);
    for (const [sink, via] of item.evidence) if (!via || translators.has(via)) evidence.set(sink, (evidence.get(sink) ?? 0) + 1);
    for (const candidate of item.candidates) {
      textCounts.set(candidate.sink, (textCounts.get(candidate.sink) ?? 0) + 1);
      if (candidate.family) textCounts.set(candidate.family, (textCounts.get(candidate.family) ?? 0) + 1);
    }
  }
  const learned = new Map<string, LearnedSink>();
  for (const [sink, messages] of evidence) {
    const text = textCounts.get(sink) ?? 0;
    if (sink.startsWith('call:') && genericCallee.test(sink.slice(5, sink.lastIndexOf('#')))) continue;
    if (sink !== 'child' && messages >= 3 && messages >= text * 0.25) learned.set(sink, { sink, messages, text });
  }

  // Decide, then match against the catalogs.
  const { index, prepare } = verdicts!;
  const ignored: Record<string, number> = {};
  const count = (reason: string, by = 1): void => { ignored[reason] = (ignored[reason] ?? 0) + by; };
  const findings: TextFinding[] = [];
  for (const [file, item] of facts) {
    for (const [reason, by] of Object.entries(item.ignored)) count(reason, by);
    const ready = prepared.get(file);
    const scored: Array<{ candidate: TextCandidate; score: number; teach?: LearnedSink; verdict: Prepared }> = [];
    item.candidates.forEach((candidate, position) => {
      const teach = learned.get(candidate.sink) ?? (candidate.family ? learned.get(candidate.family) : undefined);
      const score = candidate.base + (teach ? 1 : 0) + (candidate.local ? 1 : 0) + (candidate.siblings && (candidate.base || teach) ? 1 : 0);
      if (score >= 1) scored.push({ candidate, score, ...(teach ? { teach } : {}), verdict: ready?.[position] ?? prepare(candidate) });
    });
    // A file whose text is mostly catalog text is a copy of the catalog, such as a legacy en.ts.
    if (scored.length >= 20 && scored.filter(entry => index.has(entry.verdict.shape)).length >= scored.length * 0.6) { count('catalog copy', scored.length); continue; }
    for (const { candidate, score, teach, verdict } of scored) {
      if (verdict.drop) { count(verdict.drop); continue; }
      const match = verdict.match;
      const reasons: string[] = [];
      if (candidate.base === 2) reasons.push(candidate.kind === 'attribute' ? `${candidate.where} shows text` : 'rendered text');
      else if (candidate.hint === 'sentence') reasons.push('reads as a sentence');
      else if (candidate.hint === 'labels') reasons.push('a map of display labels');
      else if (candidate.base === 1) reasons.push(`${candidate.where} usually holds text`);
      if (teach) reasons.push(`${sinkLabel(teach.sink)} receives messages in ${teach.messages} other place${teach.messages === 1 ? '' : 's'}`);
      if (candidate.translations) reasons.push(`translated inline for ${Object.keys(candidate.translations).join(' and ')}`);
      if (candidate.local) reasons.push('the other branch or return is a message');
      if (candidate.siblings && (candidate.base || teach)) reasons.push('a neighbouring value is a message');
      if (candidate.via) reasons.push(`shown through ${candidate.via}`);
      findings.push({
        file, line: candidate.line, column: candidate.column, start: candidate.start, end: candidate.end, text: candidate.text, kind: candidate.kind, where: candidate.where,
        confidence: score >= 2 ? 'high' : 'medium', reason: reasons.join('; '), context: localizedFiles.has(file) ? 'mixed' : 'unlocalized',
        ...(match ? { catalog: match } : {}),
        ...(candidate.via ? { via: candidate.via } : {}), ...(candidate.args ? { args: candidate.args } : {}), ...(candidate.translations ? { translations: candidate.translations } : {}),
      });
    }
  }
  // Mixed files first: text missed next to messages is the likeliest oversight.
  findings.sort((a, b) => (a.context === b.context ? 0 : a.context === 'mixed' ? -1 : 1) || compare(a.file, b.file) || a.start - b.start);

  const areas = new Map<string, { findings: number; files: Set<string>; localized: Set<string> }>(), areaOf = new Map<string, string>();
  for (const finding of findings) {
    let key = areaOf.get(finding.file);
    if (key === undefined) areaOf.set(finding.file, key = textArea(root, finding.file));
    let entry = areas.get(key);
    if (!entry) areas.set(key, entry = { findings: 0, files: new Set(), localized: new Set() });
    entry.findings++; entry.files.add(finding.file);
    if (finding.context === 'mixed') entry.localized.add(finding.file);
  }
  const filesWith = (context: 'mixed' | 'unlocalized'): number => new Set(findings.filter(finding => finding.context === context).map(finding => finding.file)).size;
  return {
    root,
    sourceFiles: files.length,
    incomplete: incomplete.sort((a, b) => compare(a.file, b.file)),
    findings,
    summary: {
      findings: findings.length,
      high: findings.filter(finding => finding.confidence === 'high').length,
      medium: findings.filter(finding => finding.confidence === 'medium').length,
      inCatalog: findings.filter(finding => finding.catalog).length,
      mixedFiles: filesWith('mixed'),
      unlocalizedFiles: filesWith('unlocalized'),
      areas: [...areas].map(([name, entry]) => ({ area: name, findings: entry.findings, files: entry.files.size, localizedFiles: entry.localized.size })).sort((a, b) => b.findings - a.findings || compare(a.area, b.area)),
    },
    ignored,
    learned: [...learned.values()].sort((a, b) => b.messages - a.messages || compare(a.sink, b.sink)),
    files: facts,
    translators,
    timing: { ms: Math.round(performance.now() - started), parseMs: Math.round(parseMs), workers, cached: cache?.hits.size ?? 0 },
  };
}

// Fixes ------------------------------------------------------------------------

export interface TextEdit {
  file: string;
  line: number;
  start: number;
  end: number;
  before: string;
  after: string;
  /** The message the edit calls; empty for an edit that adds a binding such as `const t = useT();`. */
  id: string;
  /** The message is new and the fix adds it to the base catalog. */
  added: boolean;
}

export interface TextFixPlan {
  edits: TextEdit[];
  /** New base-catalog messages: ID, ICU text, and the other locales' text when the source held it. */
  messages: Array<{ id: string; text: string; file: string; line: number; translations?: Record<string, string> }>;
  /** Findings the plan leaves alone, and why. */
  skipped: Array<{ file: string; line: number; text: string; kind: TextSkip; reason: string }>;
}

interface Binding { kind: 'messages' | 'translator'; name: string }

/** Why a fix leaves a finding alone. */
export type TextSkip = 'no-binding' | 'other-locale' | 'other-feature' | 'defined-elsewhere' | 'overlap';
export const textSkipReasons: Readonly<Record<TextSkip, string>> = {
  'no-binding': 'no message binding in scope: add one (const m = useMessages(), const t = useT()) or move the text into a component',
  'other-locale': 'the text matches a catalog message only in another locale; reusing it would change what base-locale users see',
  'other-feature': 'the same text is a message of another feature; reuse it by hand if it fits, or run --extract to add one for this file',
  'defined-elsewhere': 'the text is defined in a constant or helper away from where it renders; move it, or fix it by hand',
  overlap: 'overlaps another fix in the same place',
};

/**
 * A component that can get a translator: the hook other files confirm (`t<-useT`)
 * is imported here, the function is a component or hook, and nothing in it
 * already uses the name. The fix then adds `const t = useT();` as its first statement.
 */
function componentBinding(facts: FileFacts, scope: number, code: string, [name, from]: [string, string]): [number, Binding, string] | undefined {
  for (let current = scope; current > 0; current = facts.scopes[current]?.[0] ?? -1) {
    const [, names, fn] = facts.scopes[current]!;
    if (names.some(([declared]) => declared === name)) return undefined;
    if (!fn || !/^(?:[A-Z]|use[A-Z])/.test(fn[0])) continue;
    const [, at, start, end] = fn;
    if (new RegExp(`(?<![\\w$.'’])${name}(?![\\w$'’])`).test(code.slice(start, end))) return undefined;
    const line = code.lastIndexOf('\n', at - 1) + 1, indent = code.slice(line, at);
    return [current, { kind: 'translator', name }, `const ${name} = ${from}();${/^\s*$/.test(indent) ? `\n${indent}` : ' '}`];
  }
  return undefined;
}

/** Messages whose namespace is meant for the whole app. */
const sharedNamespace = /^(?:common|shared|global|general|generic|ui|app|core|actions?|buttons?|labels?|forms?|errors?|status(?:es)?|navigation|nav|misc)$/i;

/**
 * The catalog message a fix should call for this text: one from a namespace the
 * file already uses, then one from the same feature, then a shared one. A
 * message that belongs to an unrelated feature is not reused; its translators
 * may change it for that context.
 */
function chooseId(match: CatalogMatch, prefixes: Record<string, number>, features: ReadonlySet<string>): string | undefined {
  let best: string | undefined, bestScore = 0;
  for (const id of [match.id, ...match.alternatives ?? []]) {
    const dot = id.lastIndexOf('.'), prefix = id.slice(0, Math.max(dot, 0)), feature = id.split('.')[0]!;
    const score = dot === -1 ? 1 : prefixes[prefix] ? 4 + prefixes[prefix]! / 1000 : features.has(feature) ? 3 : sharedNamespace.test(feature) ? 2 : 0;
    if (score > bestScore) { best = id; bestScore = score; }
  }
  return best;
}

/** Top-level namespaces a file's path names: `components/billing/…` → billing. Nearest folder first. */
function pathFeatures(root: string, file: string, features: ReadonlyMap<string, string>): string[] {
  const found: string[] = [];
  for (const word of relative(root, file).split(/[\\/.$_-]+/).reverse()) {
    const feature = features.get(word.toLowerCase());
    if (feature && !found.includes(feature)) found.push(feature);
  }
  return found;
}

/** Where a translator hook comes from, as an import specifier for `file`. */
function importSpecifier(file: string, source: string): string {
  if (!isAbsolute(source)) return source;
  const path = relative(dirname(file), source).split(sep).join('/');
  return path.startsWith('.') ? path : `./${path}`;
}

/** The edit that imports `name` from `specifier`: into an existing import of it, or as a new line after the imports. */
function importEdit(file: string, code: string, facts: FileFacts, name: string, specifier: string, quote: string): TextEdit {
  const edit = (at: number, after: string): TextEdit => ({ file, line: lineOf(code, at), start: at, end: at, before: '', after, id: '', added: false });
  const same = facts.imports.find(([source, , , named, typeOnly]) => !typeOnly && named !== -1 && importSpecifier(file, source.startsWith('.') ? resolve(dirname(file), source) : source) === specifier);
  if (same) return edit(same[3], `${name}, `);
  const line = `import { ${name} } from ${quote}${specifier}${quote};`;
  const last = facts.imports.reduce((end, item) => Math.max(end, item[2]), -1);
  if (last !== -1) return edit(last, `\n${line}`);
  const prologue = /^(?:\s*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/))*\s*(["'])use (?:client|strict)\1;?/.exec(code);
  return prologue ? edit(prologue[0].length, `\n${line}`) : edit(0, `${line}\n`);
}

/** The message binding visible at a finding: a messages object or a translator such as `t`. */
function bindingAt(facts: FileFacts, scope: number, translators: ReadonlyMap<string, number>, sources: ReadonlySet<string>): Binding | undefined {
  const messages = new Set(facts.messages);
  for (let current = scope; current !== -1; current = facts.scopes[current]?.[0] ?? -1) {
    const names = facts.scopes[current]?.[1] ?? [];
    for (let i = names.length - 1; i >= 0; i--) {
      const [name, from] = names[i]!;
      if (messages.has(name)) return { kind: 'messages', name };
      if (facts.translators[name]?.[0] === 0 && translators.get(name) === 0 || translators.get(name) === 0 && sources.has(`${name}<-${from}`)) return { kind: 'translator', name };
    }
  }
  return undefined;
}

const identifier = /^[A-Za-z_$][\w$]*$/;

function callFor(binding: Binding, id: string, args: string, style: FileFacts['style'], quote: string): string {
  const literal = quote === "'" ? `'${id.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : JSON.stringify(id);
  if (binding.kind === 'translator') return `${binding.name}(${literal}${args ? `, ${args}` : ''})`;
  const dotted = style.bracket <= style.dotted && id.split('.').every(part => identifier.test(part));
  return `${binding.name}${dotted ? `.${id}` : `[${literal}]`}(${args})`;
}

function wrapCall(call: string, wrap: TextWrap): string {
  if (wrap === 'jsx') return `{${call}}`;
  if (wrap === 'mustache') return `{{ ${call} }}`;
  if (wrap.startsWith('bind:')) return `:${wrap.slice(5)}="${call}"`;
  if (wrap.startsWith('attr:')) return `${wrap.slice(5)}={${call}}`;
  return call;
}

const ascii = (text: string): string => text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[øØ]/g, 'o').replace(/[æÆ]/g, 'ae').replace(/ß/g, 'ss');

const genericFile = /^(?:index|page|layout|route|routes|main|default|template|view|views|screen|ui|shared|component|components|content|copy|client|server|utils?|helpers?|lib|app)$/i;

/**
 * The namespace for new messages: the one the file uses most when it is the
 * file's own (used three times, or under a feature its path names), else a name
 * from the file under that feature: `ut-tools/mileage-calculator.tsx` → ut.mileageCalculator.
 */
function prefixFor(file: string, prefixes: Record<string, number>, features: readonly string[]): string {
  // A shared namespace (common.*) is for reuse; new text from one file does not belong there.
  const used = Object.entries(prefixes).sort((a, b) => b[1] - a[1] || compare(a[0], b[0]))
    .find(([prefix, count]) => !sharedNamespace.test(prefix.split('.')[0]!) && (count >= 3 || features.includes(prefix.split('.')[0]!)))?.[0];
  if (used) return used;
  // Route files: drop parameters ($id, [id], :id) and words that only say what kind of file it is.
  const name = basename(file, extname(file)).replace(/[$:][\w-]+|\[[^\]]*\]|^[-+_(]+|[)]/g, ' ');
  const wordsOf = (text: string): string[] => ascii(text).split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean);
  const feature = features[0]?.toLowerCase();
  // Words that only repeat the feature say nothing under it: blog/blog-kontera.tsx → blog.kontera.
  const meaningful = (text: string): string[] => wordsOf(text).filter(word => !genericFile.test(word) && word.toLowerCase() !== feature);
  let words = meaningful(name);
  if (!words.length) words = meaningful(basename(dirname(file)));
  if (!words.length && !feature) words = wordsOf(name).length ? wordsOf(name) : ['app'];
  let key = words.slice(0, 4).map((word, i) => i === 0 ? word.toLowerCase() : word[0]!.toUpperCase() + word.slice(1).toLowerCase()).join('');
  if (key && !/^[A-Za-z]/.test(key)) key = `app${key}`;
  return features[0] ? key ? `${features[0]}.${key}` : features[0] : key;
}

/** A key from the first words of the text: "No invoices yet" → noInvoicesYet. */
function keyFor(text: string): string {
  const words = ascii(text.replace(/\{[\w$]+\}/g, ' ').replace(/'[{}<]'/g, ' ')).toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const key = words.slice(0, 4).map((word, i) => i === 0 ? word : word[0]!.toUpperCase() + word.slice(1)).join('').slice(0, 40) || 'text';
  return /^[a-z]/.test(key) ? key : `text${key}`;
}

/**
 * Plan source edits for findings. `fix` reuses catalog messages with the same
 * text; `extract` also adds new messages for the rest. A finding needs a
 * message binding in scope (`const t = useT()`, `const m = useMessages()` or a
 * messages import); without one the plan reports it instead of guessing.
 */
export async function planTextFixes(result: TextScanResult, options: TextScanOptions & { extract?: boolean; confidence?: TextConfidence }): Promise<TextFixPlan> {
  const root = result.root;
  const catalogs = await readCatalogs(root, options);
  const baseIds = new Set(catalogs.texts.get(catalogs.base)?.keys() ?? []);
  const namespaces = new Set<string>();
  for (const id of baseIds) for (let i = id.indexOf('.'); i !== -1; i = id.indexOf('.', i + 1)) namespaces.add(id.slice(0, i));
  const features = new Map([...namespaces].filter(namespace => !namespace.includes('.')).map(namespace => [namespace.toLowerCase(), namespace] as const));
  // Translators confirmed elsewhere, by the call that created them: `t<-useT`.
  const sources = new Set<string>(), hookUses = new Map<string, number>();
  for (const facts of result.files.values()) for (const [, names] of facts.scopes) for (const [name, from] of names) {
    if (facts.translators[name]?.[0] !== 0) continue;
    sources.add(`${name}<-${from}`);
    // Hooks called without arguments, the ones a fix can add to a component: `t<-useT`.
    if (/^use[A-Z][\w$]*$/.test(from) && identifier.test(name)) hookUses.set(`${name}<-${from}`, (hookUses.get(`${name}<-${from}`) ?? 0) + 1);
  }
  const hooks = [...hookUses].filter(([source]) => result.translators.get(source.split('<-')[0]!) === 0).sort((a, b) => b[1] - a[1] || compare(a[0], b[0])).map(([source]) => source.split('<-') as [string, string]);
  // Where each hook is imported from, most common first: `useT` → `@/lib/i18n` or an absolute path.
  const hookSources = new Map<string, Map<string, number>>();
  for (const [file, facts] of result.files) for (const [local, from] of facts.scopes[0]?.[1] ?? []) {
    if (!from.startsWith('import:') || !hooks.some(([, hook]) => hook === local)) continue;
    const hash = from.lastIndexOf('#'), source = from.slice(7, hash);
    if (from.slice(hash + 1) !== local) continue;
    const key = source.startsWith('.') ? resolve(dirname(file), source) : source;
    let counts = hookSources.get(local);
    if (!counts) hookSources.set(local, counts = new Map());
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const hookSource = (hook: string): string | undefined => [...hookSources.get(hook) ?? []].sort((a, b) => b[1] - a[1] || compare(a[0], b[0]))[0]?.[0];
  const plan: TextFixPlan = { edits: [], messages: [], skipped: [] };
  // New IDs, and the ID each new text got in each namespace, so repeated text shares one message.
  const proposed = new Set<string>(), byText = new Map<string, string>();
  const leafAt = (prefix: string): boolean => {
    for (let i = prefix.indexOf('.'); ; i = prefix.indexOf('.', i + 1)) {
      if (baseIds.has(i === -1 ? prefix : prefix.slice(0, i))) return true;
      if (i === -1) return false;
    }
  };
  const taken = (id: string): boolean => {
    if (baseIds.has(id) || namespaces.has(id) || proposed.has(id)) return true;
    for (let i = id.indexOf('.'); i !== -1; i = id.indexOf('.', i + 1)) if (baseIds.has(id.slice(0, i)) || proposed.has(id.slice(0, i))) return true;
    for (const other of proposed) if (other.startsWith(`${id}.`)) return true;
    return false;
  };
  const byFile = new Map<string, TextFinding[]>();
  for (const finding of result.findings) {
    if (options.confidence === 'high' && finding.confidence !== 'high') continue;
    let list = byFile.get(finding.file);
    if (!list) byFile.set(finding.file, list = []);
    list.push(finding);
  }
  for (const [file, findings] of byFile) {
    const facts = result.files.get(file);
    if (!facts) continue;
    const code = await readFile(file, 'utf8');
    const quote = /\bfrom\s+'/.test(code) || file.endsWith('.vue') ? "'" : '"';
    const candidates = new Map(facts.candidates.map(candidate => [`${candidate.start}:${candidate.end}`, candidate] as const));
    const prefixes = idPrefixes(code, baseIds), named = pathFeatures(root, file, features);
    const own = new Set([...named, ...Object.keys(prefixes).map(prefix => prefix.split('.')[0]!)]);
    // The translator hook a component here can call: one the file imports, or
    // one it can import when it already calls hooks (so it is not a server component).
    let hook: [string, string] | undefined, needsImport: TextEdit | undefined;
    if (!/\.(?:vue|svelte)$/.test(file)) {
      const imported = new Set(facts.scopes[0]?.[1].filter(([, from]) => from.startsWith('import:')).map(([name]) => name));
      hook = hooks.find(([, from]) => imported.has(from));
      if (!hook && /\buse[A-Z][\w$]*\s*\(/.test(code)) {
        hook = hooks.find(([, from]) => hookSource(from) && !new RegExp(`(?<![\\w$])${from.replace(/\$/g, '\\$')}(?![\\w$])`).test(code));
        if (hook) needsImport = importEdit(file, code, facts, hook[1], importSpecifier(file, hookSource(hook[1])!), quote);
      }
    }
    // Component scopes this plan gives a translator, and the edits that add them.
    const added = new Map<number, Binding>();
    const edits: TextEdit[] = [];
    let lastEnd = -1;
    for (const finding of findings) {
      const skip = (kind: TextSkip, detail = ''): void => { plan.skipped.push({ file, line: finding.line, text: finding.text, kind, reason: textSkipReasons[kind] + detail }); };
      const candidate = candidates.get(`${finding.start}:${finding.end}`);
      if (!candidate) continue;
      if (finding.start < lastEnd) { skip('overlap'); continue; }
      if (!finding.catalog && !options.extract) continue;
      if (finding.catalog && !finding.catalog.exact) {
        if (!options.extract) { skip('other-locale', ` (${finding.catalog.locale}: ${finding.catalog.id})`); continue; }
      }
      if (finding.via) { skip('defined-elsewhere', ` (${finding.via})`); continue; }
      let binding = bindingAt(facts, candidate.scope, result.translators, sources);
      const reuse = finding.catalog?.exact ? chooseId(finding.catalog, prefixes, own) : undefined;
      if (finding.catalog?.exact && !reuse && !options.extract) { skip('other-feature', ` (${finding.catalog.id})`); continue; }
      const component = !binding && hook ? componentBinding(facts, candidate.scope, code, hook) : undefined;
      if (component) {
        const [scope, made, text] = component;
        binding = added.get(scope);
        if (!binding) {
          const at = facts.scopes[scope]![2]![1];
          edits.push({ file, line: lineOf(code, at), start: at, end: at, before: '', after: text, id: '', added: false });
          added.set(scope, binding = made);
          if (needsImport) { edits.push(needsImport); needsImport = undefined; }
        }
      }
      if (!binding) { skip('no-binding'); continue; }
      let id: string, isNew = false, names: string[];
      if (reuse) {
        id = reuse;
        names = catalogNames(catalogs, id) ?? candidate.args?.map(arg => arg.name) ?? [];
      } else {
        let prefix = prefixFor(file, prefixes, named);
        // A prefix that is itself a message (or under one) cannot hold more.
        while (leafAt(prefix)) prefix = `${prefix}Text`;
        const key = `${prefix}\u0000${finding.text}`;
        isNew = true;
        const existing = byText.get(key);
        if (existing) id = existing;
        else {
          const base = `${prefix}.${keyFor(finding.text)}`;
          id = base;
          for (let n = 2; taken(id); n++) id = `${base}${n}`;
          proposed.add(id); byText.set(key, id);
          // Other locales' text: what the source spells out, else the matched message's own.
          const known = finding.translations ?? (finding.catalog?.exact ? otherTexts(catalogs, finding.catalog.id) : finding.catalog ? { [finding.catalog.locale]: finding.text } : undefined);
          const translations = known && Object.fromEntries(Object.entries(known).filter(([locale]) => locale !== catalogs.base));
          plan.messages.push({ id, text: finding.translations?.[catalogs.base] ?? finding.text, file, line: finding.line, ...(translations && Object.keys(translations).length ? { translations } : {}) });
        }
        names = candidate.args?.map(arg => arg.name) ?? [];
      }
      const values = (candidate.args ?? []).map((arg, i) => {
        const name = names[i] ?? arg.name;
        return arg.code === name ? name : `${identifier.test(name) ? name : JSON.stringify(name)}: ${arg.code}`;
      });
      const call = callFor(binding, id, values.length ? `{ ${values.join(', ')} }` : '', facts.style, quote);
      edits.push({ file, line: finding.line, start: finding.start, end: finding.end, before: code.slice(finding.start, finding.end), after: wrapCall(call, candidate.wrap), id, added: isNew });
      lastEnd = finding.end;
    }
    plan.edits.push(...edits.sort((a, b) => a.start - b.start || a.end - b.end));
  }
  return plan;
}

function lineOf(code: string, offset: number): number {
  let line = 1;
  for (let i = code.indexOf('\n'); i !== -1 && i < offset; i = code.indexOf('\n', i + 1)) line++;
  return line;
}

/** Namespaces of the IDs a file already references, most used first. */
function idPrefixes(code: string, ids: ReadonlySet<string>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const match of code.matchAll(/["'`]([\w$-]+(?:\.[\w$-]+)+)["'`]|\b(?:m|messages)\.([\w$]+(?:\.[\w$]+)+)/g)) {
    const id = match[1] ?? match[2]!;
    if (!ids.has(id)) continue;
    const prefix = id.slice(0, id.lastIndexOf('.'));
    counts[prefix] = (counts[prefix] ?? 0) + 1;
  }
  return counts;
}

function otherTexts(catalogs: Catalogs, id: string): Record<string, string> {
  const texts: Record<string, string> = {};
  for (const locale of catalogs.locales) { const text = catalogs.texts.get(locale)?.get(id); if (locale !== catalogs.base && text !== undefined) texts[locale] = text; }
  return texts;
}

function catalogNames(catalogs: Catalogs, id: string): string[] | undefined {
  for (const locale of [catalogs.base, ...catalogs.locales]) {
    const text = catalogs.texts.get(locale)?.get(id);
    if (text !== undefined) return [...text.matchAll(/\{\s*([\w$]+)\s*\}/g)].map(match => match[1]!);
  }
  return undefined;
}
