import { quote } from './codegen.js';
const prefix = 'virtual:fasti18n/shared/';
/** One build/environment's graph. Locale boundaries stay unloaded until all
 * reachable application selections are known. Development keeps its own HMR
 * projections; watch builds construct a new graph on each buildStart.
 */
export class Sharing {
    selections;
    inputs;
    discovery;
    plans;
    parsedModules = new Map();
    waiting = new Map();
    modules = new Map();
    constructor(selections, inputs) {
        this.selections = selections;
        this.inputs = inputs;
    }
    parsed(info) {
        if (this.plans)
            return;
        // Keep only edges; do not retain every application's transformed source.
        this.parsedModules.set(info.id, { importedIds: info.importedIds, dynamicallyImportedIds: info.dynamicallyImportedIds });
        this.waiting.get(info.id)?.();
        this.waiting.delete(info.id);
    }
    finish() { this.parsedModules.clear(); }
    resolve(id) {
        const internal = '\0' + id;
        return this.modules.has(internal) ? internal : undefined;
    }
    handles(id) {
        return this.modules.has(id) || this.selections.modules.get(id)?.locale !== undefined;
    }
    async load(id, context) {
        const shared = this.modules.get(id);
        if (shared)
            return this.selections.compile(shared.partition.entry, shared.locale, shared.partition.keys);
        const descriptor = this.selections.modules.get(id);
        if (!descriptor || descriptor.locale === undefined)
            return;
        this.discovery ??= this.discover(context);
        await this.discovery;
        const { selection, locale } = descriptor;
        const owners = this.plans.get(selection.id);
        // Another plugin can emit entries after discovery. Their existing isolated
        // projection remains correct and cannot change an already emitted group.
        if (!owners)
            return this.selections.load(id);
        const selected = new Map();
        for (const key of selection.keys) {
            const partition = owners.get(key);
            if (!selected.has(partition))
                selected.set(partition, `p${selected.size}`);
        }
        const imports = [];
        let offset = 0, inOrder = true;
        for (const [partition, name] of selected) {
            const specifier = `${prefix}${partition.id}/${locale}`;
            this.modules.set('\0' + specifier, { partition, locale });
            if (selected.size === 1 && equalKeys(selection.keys, partition.keys))
                return `export {default} from ${quote(specifier)};\n`;
            imports.push(`import ${name} from ${quote(specifier)};`);
            for (const key of partition.keys)
                if (selection.keys[offset++] !== key)
                    inOrder = false;
        }
        const properties = inOrder && offset === selection.keys.length ? [...selected.values()].map(name => `...${name}`)
            : selection.keys.map(key => `[${quote(key)}]:${selected.get(owners.get(key))}[${quote(key)}]`);
        return imports.join('\n') + `\nexport default {__proto__:null,${properties.join(',')}};\n`;
    }
    async discover(context) {
        const visited = new Set(), selected = new Set();
        const walk = async (resolved) => {
            if (!resolved || resolved.external || visited.has(resolved.id))
                return;
            const id = resolved.id;
            visited.add(id);
            if (this.selections.modules.has(id)) {
                selected.add(id);
                return;
            }
            if (!this.parsedModules.has(id)) {
                const info = await context.load({ ...resolved, resolveDependencies: true });
                if (!info)
                    throw new Error(`fasti18n: could not inspect build module ${id}`);
                // Cached code may be returned before resolution completes. moduleParsed
                // supplies the final edges without waiting on its imported modules.
                if (!this.parsedModules.has(id))
                    await new Promise(resolve => this.waiting.set(id, resolve));
            }
            const ready = this.parsedModules.get(id);
            for (const child of [...ready.importedIds, ...ready.dynamicallyImportedIds]) {
                if (this.selections.modules.has(child)) {
                    selected.add(child);
                    continue;
                }
                // moduleParsed proves this is an internal, already resolved module.
                // Reuse its edges instead of re-entering every plugin's resolver/loader.
                if (this.parsedModules.has(child)) {
                    await walk({ id: child });
                    continue;
                }
                const resolution = await context.resolve(child, id);
                if (resolution)
                    await walk(resolution);
                else if (context.getModuleInfo(child))
                    await walk({ id: child });
            }
        };
        const entries = new Set(this.inputs);
        for (const id of context.getModuleIds())
            if (context.getModuleInfo(id)?.isEntry)
                entries.add(id);
        for (const input of entries)
            await walk(await context.resolve(input, undefined, { isEntry: true }));
        const byEntry = new Map();
        for (const id of [...selected].sort()) {
            const descriptor = this.selections.modules.get(id);
            if (!descriptor || descriptor.locale !== undefined)
                continue;
            const { selection } = descriptor;
            const group = byEntry.get(selection.entry) ?? [];
            group.push(selection);
            byEntry.set(selection.entry, group);
        }
        this.plans = new Map();
        let nextId = 0;
        for (const [entry, group] of byEntry) {
            const memberships = new Map(), groups = new Map(), owners = new Map();
            for (let index = 0; index < group.length; index++)
                for (const key of group[index].keys) {
                    const indices = memberships.get(key) ?? [];
                    indices.push(index);
                    memberships.set(key, indices);
                }
            for (const [key, indices] of memberships) {
                const signature = indices.join(',');
                let partition = groups.get(signature);
                if (!partition) {
                    partition = { id: nextId++, entry, keys: [] };
                    groups.set(signature, partition);
                }
                partition.keys.push(key);
                owners.set(key, partition);
            }
            for (const selection of group)
                this.plans.set(selection.id, owners);
        }
        this.parsedModules.clear();
    }
}
function equalKeys(left, right) {
    return left.length === right.length && left.every((key, index) => key === right[index]);
}
