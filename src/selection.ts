import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import MagicString from 'magic-string';
import type { ESTree } from 'vite';
import { quote } from './codegen.js';
import { Projection } from './projection.js';
import { inferSelectionResults } from './infer-selections.js';
import type { InferenceResult, NestedAccess, SelectionFallbackReason } from './infer-selections.js';
import { indexBindings } from './bindings.js';
import type { Binding, Identifier } from './bindings.js';
import type { GenerateResult } from './project.js';

export type Selection = { id: string; entry: string; keys: string[]; nested: boolean };
type VirtualModule = { selection: Selection; locale?: string };
type Group = { ids: readonly string[]; names: ReadonlyMap<string, number> };
type LoadedModule = { source: string | undefined; names: Group['names'] | undefined; code?: string; error?: Error };
export type SelectionFallbackMode = 'warn' | 'error' | 'off';
type SelectionReporter = (message: string, node?: ESTree.Node, level?: 'warn' | 'error') => void;
const prefix = 'virtual:nordbeam-locale/selection/';
const importClause = /\bimport\s+([^;]*?)\bfrom\s*(['"])(.*?)\2/g;

/** Text prefilter: sources of imports whose clause may bind a selector (or a
 * namespace, when static narrowing is enabled). Undefined means the scan cannot
 * prove the spelling, so the AST decides. Ordinary code never reaches the parser. */
function selectorSources(code: string, namespace: boolean): string[] | undefined {
  const sources = new Set<string>();
  for (const [, clause = '', , source = ''] of code.matchAll(importClause)) {
    if (source.includes('\\')) return;
    if (/selectMessages|loadLocale|\\u/.test(clause) || namespace && /\*\s*as\b/.test(clause)) sources.add(source);
  }
  return [...sources];
}

/** Replace proven static selections with locale split points and named imports. */
export class Selections {
  readonly modules = new Map<string, VirtualModule>();
  private snapshot: GenerateResult | undefined;
  private localeKey = '';
  private readonly groups = new Map<string, Group>();
  private readonly projections = new Map<string, Projection>();
  private readonly loaded = new Map<string, LoadedModule>();
  constructor(private readonly project: () => GenerateResult, private readonly staticLocale: () => string | undefined = () => undefined) {}

  private prepare(): GenerateResult {
    const project = this.project();
    if (project !== this.snapshot) {
      this.snapshot = project;
      this.localeKey = JSON.stringify(project.locales);
      for (const [entry, ids] of Object.entries(project.groups)) {
        const previous = this.groups.get(entry);
        if (!previous || ids.length !== previous.ids.length || ids.some((id, i) => id !== previous.ids[i])) {
          this.groups.set(entry, {ids, names:new Map(ids.map((id, i) => [id, i]))});
        }
      }
      for (const entry of this.groups.keys()) if (!Object.hasOwn(project.groups, entry)) this.groups.delete(entry);
      for (const [file, projection] of this.projections) if (project.files[file] !== projection.source) this.projections.delete(file);
    }
    return project;
  }

  resolve(id: string): string | undefined {
    const internal = '\0' + id;
    return this.modules.has(internal) ? internal : undefined;
  }

  load(id: string): string | undefined {
    const result = this.evaluate(id);
    if (result?.error) throw result.error;
    return result?.code;
  }

  /** Retain descriptors so old development URLs can be compiled on demand. */
  dropCached(ids: Iterable<string>): void { for (const id of ids) this.loaded.delete(id); }

  clear(): void {
    this.modules.clear(); this.loaded.clear(); this.projections.clear(); this.groups.clear();
    this.snapshot = undefined; this.localeKey = '';
  }

  /** Keep build caches tied to the current graph, including cached modules
   * whose transform/load hooks did not run again. Called after successful builds.
   */
  retain(ids: Iterable<string>): void {
    const active = new Set<string>(), selections = new Set<string>();
    for (const id of ids) {
      const module = this.modules.get(id);
      if (module) { active.add(id); selections.add(module.selection.id); }
    }
    // A retained loader can refer to a locale currently handled as external by
    // another plugin. Keep its current descriptors, but not old locale entries.
    const locales = new Set(this.project().locales);
    for (const [id, module] of this.modules) {
      if (!selections.has(module.selection.id) || (module.locale !== undefined && !locales.has(module.locale))) this.modules.delete(id);
    }
    for (const id of this.loaded.keys()) if (!active.has(id)) this.loaded.delete(id);
    const entries = new Set([...this.modules.values()].map(module => module.selection.entry));
    for (const file of this.projections.keys()) {
      const boundary = file.lastIndexOf('locales/');
      if (!entries.has(file.slice(0, boundary) + 'index.js')) this.projections.delete(file);
    }
  }

  /** Reuse locale indexes when several route selections share a partition. */
  compile(entry: string, locale: string, keys: readonly string[], nested = true): string {
    const project = this.prepare();
    const names = this.groups.get(entry)?.names;
    if (!names) throw new Error(`Nordbeam Locale: unknown selected catalog ${entry}`);
    const file = entry.slice(0, -'index.js'.length) + `locales/${locale}.js`;
    const source = project.files[file];
    if (source === undefined) throw new Error(`Nordbeam Locale: removed locale ${locale}`);
    let projection = this.projections.get(file);
    if (!projection || projection.source !== source || projection.names !== names) {
      projection = new Projection(source, names);
      this.projections.set(file, projection);
    }
    return projection.compile(keys, nested);
  }

  /** Compare only modules that have been loaded, sharing indexes across routes.
   * Error states are retained so restoring a removed key/locale also updates.
   */
  update(): string[] {
    if (!this.loaded.size) return [];
    this.prepare();
    const changed: string[] = [];
    for (const [id, previous] of this.loaded) {
      const next = this.evaluate(id)!;
      if (next.code !== previous.code || next.error?.message !== previous.error?.message) changed.push(id);
    }
    return changed;
  }

  private evaluate(id: string): LoadedModule | undefined {
    const module = this.modules.get(id);
    if (!module) return;
    const project = this.prepare();
    const { selection, locale } = module;
    const names = this.groups.get(selection.entry)?.names;
    const file = selection.entry.slice(0, -'index.js'.length) + `locales/${locale}.js`;
    const source = locale === undefined ? this.localeKey : project.files[file];
    const previous = this.loaded.get(id);
    if (previous && previous.source === source && previous.names === names) return previous;
    const result: LoadedModule = {source, names};
    try {
      for (const key of selection.keys) if (!names?.has(key)) throw new Error(`Nordbeam Locale: unknown selected message ${quote(key)} in ${selection.entry}`);
      if (locale !== undefined) {
        result.code = this.compile(selection.entry, locale, selection.keys, selection.nested);
      } else {
        const fixed = this.staticLocale();
        if (fixed !== undefined) {
          if (!project.locales.includes(fixed)) throw new Error(`Nordbeam Locale: staticLocale ${quote(fixed)} is not a configured locale`);
          const child = `${selection.id}/${fixed}`;
          this.modules.set('\0' + child, { selection, locale: fixed });
          result.code = `import messages from ${quote(child)};export default async function(locale){if(locale!==${quote(fixed)})throw new RangeError("Static locale is ${fixed}: "+String(locale));return {locale:${quote(fixed)},messages};}\n`;
          this.loaded.set(id, result);
          return result;
        }
        const loaders = project.locales.map(locale => {
          const child = `${selection.id}/${locale}`;
          this.modules.set('\0' + child, { selection, locale });
          return `[${quote(locale)}]:()=>import(${quote(child)})`;
        });
        result.code = `const loaders={__proto__:null,${loaders.join(',')}};export default async function(locale){const load=loaders[locale];if(!load)throw new RangeError("Unsupported locale: "+String(locale));return {locale,messages:(await load()).default};}\n`;
      }
    } catch (error) {
      result.error = error instanceof Error ? error : new Error(String(error));
    }
    this.loaded.set(id, result);
    return result;
  }

  async transform(code: string, id: string, parse: (code: string) => ESTree.Program,
    resolveImport: (source: string) => Promise<string | undefined>, warn: SelectionReporter,
    selectedIds?: string[], selectionFallback: SelectionFallbackMode = 'warn') {
    const project = this.project();
    // Svelte and Vue script blocks are JS by now: this hook runs after their compilers.
    if (!/\.(?:[cm]?[jt]sx?|svelte|vue)(?:$|\?)/.test(id) || id.includes('/node_modules/') || id.startsWith(project.outDir + '/')) return;
    this.prepare();
    const fixed = this.staticLocale();
    let warnedStatic = false;
    const warnStatic = (reason: string) => {
      if (fixed === undefined || warnedStatic) return;
      warnedStatic = true;
      warn(`Nordbeam Locale: staticLocale ${quote(fixed)} could not specialize ${reason}. This use retains the dynamic loader and may include other locales. Use selectMessages with literal keys or import named messages from the generated locales/${fixed}.js module.`);
    };
    const resolved = new Map<string, string | undefined>();
    const entryFor = async (source: string) => {
      if (!resolved.has(source)) {
        const file = await resolveImport(source);
        const entry = file && relative(project.outDir, file).replaceAll('\\', '/');
        resolved.set(source, entry && Object.hasOwn(project.groups, entry) ? entry : undefined);
      }
      return resolved.get(source);
    };
    const sources = selectorSources(code, fixed !== undefined);
    if (sources) {
      let found = false;
      for (const source of sources) if (await entryFor(source)) { found = true; break; }
      if (!found) return;
    }
    const ast = parse(code);
    const imports = new Map<string, string>();
    const loaders = new Set<string>();
    const imported = new Map<string, Identifier>();
    const importNodes: ESTree.ImportDeclaration[] = [];
    for (const node of ast.body) {
      if (node.type !== 'ImportDeclaration') continue;
      const selectors = node.specifiers.filter(specifier => specifier.type === 'ImportSpecifier'
        && ['selectMessages', 'loadLocale'].includes(specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value));
      const namespace = fixed !== undefined && node.specifiers.some(specifier => specifier.type === 'ImportNamespaceSpecifier');
      if (!selectors.length && !namespace) continue;
      const entry = await entryFor(node.source.value);
      if (!entry) continue;
      if (namespace) warnStatic('a namespace import');
      importNodes.push(node);
      for (const specifier of selectors) {
        imports.set(specifier.local.name, entry);
        if (specifier.type === 'ImportSpecifier' && (specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value) === 'loadLocale') loaders.add(specifier.local.name);
        imported.set(specifier.local.name, specifier.local);
      }
    }
    if (!imports.size) return;
    const index = indexBindings(ast, loaders.size > 0);
    // Direct eval can name bindings that are absent from the visible reference
    // graph, including an import that would otherwise be removed.
    const nestedAccesses = new Map<ESTree.CallExpression, NestedAccess[]>();
    const inferred = inferSelectionResults(ast, loaders, index, nestedAccesses);
    const fallbackMessage = (reason: SelectionFallbackReason, detail?: string) => {
      const explanation: Record<SelectionFallbackReason, string> = {
        'mutable-binding': 'the loadLocale result is bound with let or another mutable declaration',
        'loaded-result-retained': 'the complete loadLocale result is retained instead of being consumed locally',
        'message-object-escapes': 'the messages object or a message function escapes to another call, component, or export',
        'exported-binding': 'the loaded result or messages binding is exported',
        'dynamic-access': 'the messages are accessed through reflection, spread, deletion, or a dynamic property',
        'unsupported-property-use': 'a message property is retained, chained, assigned, or otherwise used outside a direct call',
        'ambiguous-loader-binding': 'the loadLocale binding is shadowed, reassigned, or otherwise ambiguous',
        'direct-eval': 'direct eval may inspect or mutate bindings that static analysis cannot see',
      };
      return `Nordbeam Locale: loadLocale selection fallback (${reason}): ${detail ?? explanation[reason]}. The full catalog remains available. Use direct local message calls or literal selectMessages(...) keys for smaller chunks.`;
    };
    const staticFallbackBindings = new Set<Binding>();
    const reportFallback = (call: ESTree.CallExpression, reason: SelectionFallbackReason, detail?: string) => {
      if (selectionFallback === 'off') return;
      if (fixed !== undefined) {
        const binding = call.callee.type === 'Identifier' ? index.bindings.get(call.callee) : undefined;
        if (binding) staticFallbackBindings.add(binding);
      }
      warn(fallbackMessage(reason, detail), call, selectionFallback);
    };
    if (index.dynamic) {
      for (const [call, outcome] of inferred) if (outcome.kind === 'full') reportFallback(call, outcome.reason);
      if (!staticFallbackBindings.size) warnStatic('code containing direct eval');
      return;
    }
    const importsByBinding = new Map<Binding, string>();
    for (const [name, identifier] of imported) importsByBinding.set(index.bindings.get(identifier)!, name);
    const { names: identifiers, calls } = index;
    const replaced = new Set<Identifier>();
    const output = new MagicString(code);
    let transformed = 0;
    for (const call of calls) {
      if (call.callee.type !== 'Identifier') continue;
      const binding = index.bindings.get(call.callee);
      if (!binding) continue;
      // inferSelectionResults also recognizes direct calls through an alias of
      // loadLocale. The alias itself cannot be rewritten, but it still gets a
      // classified diagnostic instead of silently retaining the full catalog.
      const aliasedOutcome = inferred.get(call);
      if (aliasedOutcome && !importsByBinding.has(binding)) {
        if (aliasedOutcome.kind === 'full') reportFallback(call, aliasedOutcome.reason);
        continue;
      }
      if (!importsByBinding.has(binding)) continue;
      const automatic = loaders.has(call.callee.name);
      const outcome: InferenceResult | undefined = automatic ? inferred.get(call) : undefined;
      if (automatic && !outcome) continue;
      if (automatic && outcome?.kind === 'full') { reportFallback(call, outcome.reason); continue; }
      if (!automatic && (!call.arguments.length || call.arguments.some(arg => arg.type !== 'Literal' || typeof arg.value !== 'string'))) {
        warn('Nordbeam Locale: selectMessages could not be statically narrowed (dynamic keys). The full catalog remains available. Use literal keys for smaller chunks.');
        continue;
      }
      const keys = automatic ? (outcome as Extract<InferenceResult, {kind:'selected'}>).keys : [...new Set(call.arguments.map(arg => (arg as ESTree.StringLiteral).value))];
      if (automatic && fixed !== undefined && call.arguments[0]?.type === 'Literal'
        && typeof call.arguments[0].value === 'string' && call.arguments[0].value !== fixed) {
        throw new Error(`Nordbeam Locale: staticLocale is ${quote(fixed)} but this loadLocale call requests ${quote(call.arguments[0].value)}`);
      }
      const entry = imports.get(call.callee.name)!;
      // Inferred unknown properties retain their original JS behavior, including
      // optional calls. Explicit selections continue to report unknown keys.
      if (automatic && keys.some(key => !this.groups.get(entry)!.names.has(key))) {
        reportFallback(call, 'unsupported-property-use', 'a literal property is not present in the generated catalog');
        continue;
      }
      for (const key of keys) if (!this.groups.get(entry)!.names.has(key)) throw new Error(`Nordbeam Locale: unknown selected message ${quote(key)} in ${entry}`);
      const nested = !automatic;
      const hash = createHash('sha256').update(JSON.stringify([project.outDir, entry, keys, nested])).digest('hex');
      const selection = { id: prefix + hash, entry, keys, nested };
      this.modules.set('\0' + selection.id, { selection });
      selectedIds?.push(selection.id);
      let local = `$nordbeamLocale${transformed++}`;
      while (identifiers.has(local)) local += '_';
      identifiers.add(local);
      output.prepend(`import ${local} from ${quote(selection.id)};\n`);
      output.overwrite(automatic ? call.callee.start : call.start, automatic ? call.callee.end : call.end, local);
      if (automatic) for (const access of nestedAccesses.get(call) ?? []) {
        output.overwrite(access.start, access.end, `${code.slice(access.start, access.baseEnd)}[${quote(access.key)}]`);
      }
      replaced.add(call.callee);
    }
    if (fixed !== undefined) for (const [binding, name] of importsByBinding) {
      if (staticFallbackBindings.has(binding)) continue;
      for (const reference of binding.references) if (!replaced.has(reference)) {
        warnStatic(`an unproven use of ${name}`);
        break;
      }
    }
    if (!transformed) return;
    // A retained, now-unused selector import connects every narrowed route to
    // the full loader in development. Remove only bindings whose uses were all
    // replaced; dynamic calls, aliases, exports and other references retain it.
    for (const node of importNodes) {
      const kept = node.specifiers.filter(specifier => !imports.has(specifier.local.name)
        || [...index.bindings.get(specifier.local)!.references].some(reference => !replaced.has(reference)));
      if (kept.length === node.specifiers.length) continue;
      if (!kept.length) output.remove(node.start, node.end);
      else {
        const parts = kept.filter(specifier => specifier.type !== 'ImportSpecifier').map(specifier => code.slice(specifier.start, specifier.end));
        const named = kept.filter(specifier => specifier.type === 'ImportSpecifier').map(specifier => code.slice(specifier.start, specifier.end));
        if (named.length) parts.push(`{${named.join(',')}}`);
        output.overwrite(node.start, node.end, `import ${parts.join(',')} from ${code.slice(node.source.start,node.source.end)}${code.slice(node.source.end,node.end)}`);
      }
    }
    return { code: output.toString(), map: output.generateMap({ source: id, includeContent: true, hires: true }) };
  }
}
