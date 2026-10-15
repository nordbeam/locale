import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import MagicString from 'magic-string';
import { quote } from './codegen.js';
import { Projection } from './projection.js';
const prefix = 'virtual:fasti18n/selection/';
function walk(node, visit) {
    visit(node);
    for (const child of Object.values(node)) {
        if (Array.isArray(child)) {
            for (const item of child)
                if (item && typeof item === 'object' && typeof item.type === 'string')
                    walk(item, visit);
        }
        else if (child && typeof child === 'object' && 'type' in child && typeof child.type === 'string')
            walk(child, visit);
    }
}
function bindings(pattern, names) {
    if (!pattern)
        return;
    if (pattern.type === 'Identifier')
        names.add(pattern.name);
    else if (pattern.type === 'RestElement')
        bindings(pattern.argument, names);
    else if (pattern.type === 'AssignmentPattern')
        bindings(pattern.left, names);
    else if (pattern.type === 'ArrayPattern')
        for (const item of pattern.elements)
            bindings(item, names);
    else if (pattern.type === 'ObjectPattern')
        for (const item of pattern.properties)
            bindings(item.type === 'RestElement' ? item.argument : item.value, names);
}
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
                if (source === undefined)
                    throw new Error(`fasti18n: removed locale ${locale}`);
                let projection = this.projections.get(file);
                if (!projection || projection.source !== source || projection.names !== names) {
                    projection = new Projection(source, names);
                    this.projections.set(file, projection);
                }
                result.code = projection.compile(selection.keys);
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
    async transform(code, id, parse, resolveImport, warn) {
        const project = this.project();
        if (!/\.[cm]?[jt]sx?(?:$|\?)/.test(id) || id.includes('/node_modules/') || id.startsWith(project.outDir + '/') || !code.includes('selectMessages'))
            return;
        this.prepare();
        const ast = parse(code);
        const imports = new Map();
        const importBindings = new Set();
        const importNodes = [];
        for (const node of ast.body) {
            if (node.type !== 'ImportDeclaration')
                continue;
            const selectors = node.specifiers.filter(specifier => specifier.type === 'ImportSpecifier'
                && (specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value) === 'selectMessages');
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
                importBindings.add(specifier.local);
                if (specifier.type === 'ImportSpecifier')
                    importBindings.add(specifier.imported);
            }
        }
        if (!imports.size)
            return;
        const shadowed = new Set();
        const calls = [];
        const identifiers = new Set();
        const references = new Map();
        const replaced = new Set();
        walk(ast, node => {
            if (node.type === 'Identifier') {
                identifiers.add(node.name);
                if (imports.has(node.name) && !importBindings.has(node)) {
                    let uses = references.get(node.name);
                    if (!uses)
                        references.set(node.name, uses = new Set());
                    uses.add(node);
                }
            }
            if (node.type === 'VariableDeclarator' || node.type === 'ClassDeclaration' || node.type === 'ClassExpression')
                bindings(node.id, shadowed);
            if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
                if (node.type !== 'ArrowFunctionExpression')
                    bindings(node.id, shadowed);
                for (const parameter of node.params)
                    bindings(parameter, shadowed);
            }
            if (node.type === 'CatchClause')
                bindings(node.param, shadowed);
            if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && imports.has(node.callee.name))
                calls.push(node);
        });
        const output = new MagicString(code);
        let transformed = 0;
        for (const call of calls) {
            if (call.callee.type !== 'Identifier')
                continue;
            if (shadowed.has(call.callee.name) || !call.arguments.length || call.arguments.some(arg => arg.type !== 'Literal' || typeof arg.value !== 'string')) {
                warn('fasti18n: selectMessages could not be statically narrowed (dynamic keys or a shadowed import). The full catalog remains available. Use literal keys and an unshadowed named import for smaller chunks.');
                continue;
            }
            const keys = [...new Set(call.arguments.map(arg => arg.value))];
            const entry = imports.get(call.callee.name);
            for (const key of keys)
                if (!this.groups.get(entry).names.has(key))
                    throw new Error(`fasti18n: unknown selected message ${quote(key)} in ${entry}`);
            const hash = createHash('sha256').update(JSON.stringify([project.outDir, entry, keys])).digest('hex');
            const selection = { id: prefix + hash, entry, keys };
            this.modules.set('\0' + selection.id, { selection });
            let local = `$fasti18n${transformed++}`;
            while (identifiers.has(local))
                local += '_';
            identifiers.add(local);
            output.prepend(`import ${local} from ${quote(selection.id)};\n`);
            output.overwrite(call.start, call.end, local);
            replaced.add(call.callee);
        }
        if (!transformed)
            return;
        // A retained, now-unused selector import connects every narrowed route to
        // the full loader in development. Remove only bindings whose uses were all
        // replaced; dynamic calls, aliases, exports and other references retain it.
        for (const node of importNodes) {
            const kept = node.specifiers.filter(specifier => !imports.has(specifier.local.name)
                || [...references.get(specifier.local.name) ?? []].some(reference => !replaced.has(reference)));
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
