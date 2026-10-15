import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import MagicString from 'magic-string';
import { quote } from './codegen.js';
import { Projection } from './projection.js';
import { inferSelections } from './infer-selections.js';
import { indexBindings } from './bindings.js';
const prefix = 'virtual:fasti18n/selection/';
/** Replace proven static selections with locale split points and named imports. */
export class Selections {
    project;
    modules = new Map();
    snapshot;
    localeKey = '';
    groups = new Map();
    projections = new Map();
    loaded = new Map();
    constructor(project) {
        this.project = project;
    }
    prepare() {
        const project = this.project();
        if (project !== this.snapshot) {
            this.snapshot = project;
            this.localeKey = JSON.stringify(project.locales);
            for (const [entry, ids] of Object.entries(project.groups)) {
                const previous = this.groups.get(entry);
                if (!previous || ids.length !== previous.ids.length || ids.some((id, i) => id !== previous.ids[i])) {
                    this.groups.set(entry, { ids, names: new Map(ids.map((id, i) => [id, i])) });
                }
            }
            for (const entry of this.groups.keys())
                if (!Object.hasOwn(project.groups, entry))
                    this.groups.delete(entry);
            for (const [file, projection] of this.projections)
                if (project.files[file] !== projection.source)
                    this.projections.delete(file);
        }
        return project;
    }
    resolve(id) {
        const internal = '\0' + id;
        return this.modules.has(internal) ? internal : undefined;
    }
    load(id) {
        const result = this.evaluate(id);
        if (result?.error)
            throw result.error;
        return result?.code;
    }
    /** Retain descriptors so old development URLs can be compiled on demand. */
    dropCached(ids) { for (const id of ids)
        this.loaded.delete(id); }
    clear() {
        this.modules.clear();
        this.loaded.clear();
        this.projections.clear();
        this.groups.clear();
        this.snapshot = undefined;
        this.localeKey = '';
    }
    /** Keep build caches tied to the current graph, including cached modules
     * whose transform/load hooks did not run again. Called after successful builds.
     */
    retain(ids) {
        const active = new Set(), selections = new Set();
        for (const id of ids) {
            const module = this.modules.get(id);
            if (module) {
                active.add(id);
                selections.add(module.selection.id);
            }
        }
        // A retained loader can refer to a locale currently handled as external by
        // another plugin. Keep its current descriptors, but not old locale entries.
        const locales = new Set(this.project().locales);
        for (const [id, module] of this.modules) {
            if (!selections.has(module.selection.id) || (module.locale !== undefined && !locales.has(module.locale)))
                this.modules.delete(id);
        }
        for (const id of this.loaded.keys())
            if (!active.has(id))
                this.loaded.delete(id);
        const entries = new Set([...this.modules.values()].map(module => module.selection.entry));
        for (const file of this.projections.keys()) {
            const boundary = file.lastIndexOf('locales/');
            if (!entries.has(file.slice(0, boundary) + 'index.js'))
                this.projections.delete(file);
        }
    }
    /** Reuse locale indexes when several route selections share a partition. */
    compile(entry, locale, keys) {
        const project = this.prepare();
        const names = this.groups.get(entry)?.names;
        if (!names)
            throw new Error(`fasti18n: unknown selected catalog ${entry}`);
        const file = entry.slice(0, -'index.js'.length) + `locales/${locale}.js`;
        const source = project.files[file];
        if (source === undefined)
            throw new Error(`fasti18n: removed locale ${locale}`);
        let projection = this.projections.get(file);
        if (!projection || projection.source !== source || projection.names !== names) {
            projection = new Projection(source, names);
            this.projections.set(file, projection);
        }
        return projection.compile(keys);
    }
    /** Compare only modules that have been loaded, sharing indexes across routes.
     * Error states are retained so restoring a removed key/locale also updates.
     */
    update() {
        if (!this.loaded.size)
            return [];
        this.prepare();
        const changed = [];
        for (const [id, previous] of this.loaded) {
            const next = this.evaluate(id);
            if (next.code !== previous.code || next.error?.message !== previous.error?.message)
                changed.push(id);
        }
        return changed;
    }
    evaluate(id) {
        const module = this.modules.get(id);
        if (!module)
            return;
        const project = this.prepare();
        const { selection, locale } = module;
        const names = this.groups.get(selection.entry)?.names;
        const file = selection.entry.slice(0, -'index.js'.length) + `locales/${locale}.js`;
        const source = locale === undefined ? this.localeKey : project.files[file];
        const previous = this.loaded.get(id);
        if (previous && previous.source === source && previous.names === names)
            return previous;
        const result = { source, names };
        try {
            for (const key of selection.keys)
                if (!names?.has(key))
                    throw new Error(`fasti18n: unknown selected message ${quote(key)} in ${selection.entry}`);
            if (locale !== undefined) {
                result.code = this.compile(selection.entry, locale, selection.keys);
            }
            else {
                const loaders = project.locales.map(locale => {
                    const child = `${selection.id}/${locale}`;
                    this.modules.set('\0' + child, { selection, locale });
                    return `[${quote(locale)}]:()=>import(${quote(child)})`;
                });
                result.code = `const loaders={__proto__:null,${loaders.join(',')}};export default async function(locale){const load=loaders[locale];if(!load)throw new RangeError("Unsupported locale: "+String(locale));return {locale,messages:(await load()).default};}\n`;
            }
        }
        catch (error) {
            result.error = error instanceof Error ? error : new Error(String(error));
        }
        this.loaded.set(id, result);
        return result;
    }
    async transform(code, id, parse, resolveImport, warn, selectedIds) {
        const project = this.project();
        if (!/\.[cm]?[jt]sx?(?:$|\?)/.test(id) || id.includes('/node_modules/') || id.startsWith(project.outDir + '/') || (!code.includes('selectMessages') && !code.includes('loadLocale')))
            return;
        this.prepare();
        const ast = parse(code);
        const imports = new Map();
        const loaders = new Set();
        const imported = new Map();
        const importNodes = [];
        for (const node of ast.body) {
            if (node.type !== 'ImportDeclaration')
                continue;
            const selectors = node.specifiers.filter(specifier => specifier.type === 'ImportSpecifier'
                && ['selectMessages', 'loadLocale'].includes(specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value));
            if (!selectors.length)
                continue;
            const resolved = await resolveImport(node.source.value);
            if (!resolved)
                continue;
            const entry = relative(project.outDir, resolved).replaceAll('\\', '/');
            if (!Object.hasOwn(project.groups, entry))
                continue;
            importNodes.push(node);
            for (const specifier of selectors) {
                imports.set(specifier.local.name, entry);
                if (specifier.type === 'ImportSpecifier' && (specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value) === 'loadLocale')
                    loaders.add(specifier.local.name);
                imported.set(specifier.local.name, specifier.local);
            }
        }
        if (!imports.size)
            return;
        const index = indexBindings(ast, loaders.size > 0);
        // Direct eval can name bindings that are absent from the visible reference
        // graph, including an import that would otherwise be removed.
        if (index.dynamic)
            return;
        const inferred = inferSelections(ast, loaders, index);
        const importsByBinding = new Map();
        for (const [name, identifier] of imported)
            importsByBinding.set(index.bindings.get(identifier), name);
        const { names: identifiers, calls } = index;
        const replaced = new Set();
        const output = new MagicString(code);
        let transformed = 0;
        for (const call of calls) {
            if (call.callee.type !== 'Identifier')
                continue;
            const binding = index.bindings.get(call.callee);
            if (!binding || !importsByBinding.has(binding))
                continue;
            const automatic = loaders.has(call.callee.name);
            if (automatic && !inferred.has(call))
                continue;
            if (!automatic && (!call.arguments.length || call.arguments.some(arg => arg.type !== 'Literal' || typeof arg.value !== 'string'))) {
                warn('fasti18n: selectMessages could not be statically narrowed (dynamic keys). The full catalog remains available. Use literal keys for smaller chunks.');
                continue;
            }
            const keys = automatic ? inferred.get(call) : [...new Set(call.arguments.map(arg => arg.value))];
            const entry = imports.get(call.callee.name);
            // Inferred unknown properties retain their original JS behavior, including
            // optional calls. Explicit selections continue to report unknown keys.
            if (automatic && keys.some(key => !this.groups.get(entry).names.has(key)))
                continue;
            for (const key of keys)
                if (!this.groups.get(entry).names.has(key))
                    throw new Error(`fasti18n: unknown selected message ${quote(key)} in ${entry}`);
            const hash = createHash('sha256').update(JSON.stringify([project.outDir, entry, keys])).digest('hex');
            const selection = { id: prefix + hash, entry, keys };
            this.modules.set('\0' + selection.id, { selection });
            selectedIds?.push(selection.id);
            let local = `$fasti18n${transformed++}`;
            while (identifiers.has(local))
                local += '_';
            identifiers.add(local);
            output.prepend(`import ${local} from ${quote(selection.id)};\n`);
            output.overwrite(automatic ? call.callee.start : call.start, automatic ? call.callee.end : call.end, local);
            replaced.add(call.callee);
        }
        if (!transformed)
            return;
        // A retained, now-unused selector import connects every narrowed route to
        // the full loader in development. Remove only bindings whose uses were all
        // replaced; dynamic calls, aliases, exports and other references retain it.
        for (const node of importNodes) {
            const kept = node.specifiers.filter(specifier => !imports.has(specifier.local.name)
                || [...index.bindings.get(specifier.local).references].some(reference => !replaced.has(reference)));
            if (kept.length === node.specifiers.length)
                continue;
            if (!kept.length)
                output.remove(node.start, node.end);
            else {
                const parts = kept.filter(specifier => specifier.type !== 'ImportSpecifier').map(specifier => code.slice(specifier.start, specifier.end));
                const named = kept.filter(specifier => specifier.type === 'ImportSpecifier').map(specifier => code.slice(specifier.start, specifier.end));
                if (named.length)
                    parts.push(`{${named.join(',')}}`);
                output.overwrite(node.start, node.end, `import ${parts.join(',')} from ${code.slice(node.source.start, node.source.end)}${code.slice(node.source.end, node.end)}`);
            }
        }
        return { code: output.toString(), map: output.generateMap({ source: id, includeContent: true, hires: true }) };
    }
}
