/** Release abandoned development code without invalidating old URL identities.
 * Owners protect selections while Vite is still resolving a changed module;
 * graph importers protect other consumers and environments that have not updated.
 */
export class DevSelections {
    selections;
    environments;
    owners = new WeakMap();
    timer;
    closed = false;
    constructor(selections, environments) {
        this.selections = selections;
        this.environments = environments;
    }
    record(environment, id, selections) {
        let owners = this.owners.get(environment);
        if (!selections.length && !owners?.has(id))
            return;
        if (!owners) {
            owners = new Map();
            this.owners.set(environment, owners);
        }
        if (selections.length)
            owners.set(id, new Set(selections));
        else
            owners.delete(id);
        this.schedule();
    }
    removeFile(environment, file) {
        const owners = this.owners.get(environment);
        if (owners)
            for (const id of owners.keys())
                if (id.split('?')[0] === file)
                    owners.delete(id);
        this.schedule();
    }
    active(environment) {
        const active = new Set();
        for (const selections of this.owners.get(environment)?.values() ?? [])
            for (const id of selections)
                active.add(id);
        for (const [id, { selection }] of this.selections.modules) {
            if (active.has(selection.id))
                continue;
            const module = environment.moduleGraph.getModuleById(id);
            for (const importer of module?.importers ?? []) {
                if (this.selections.modules.get(importer.id ?? '')?.selection.id !== selection.id) {
                    active.add(selection.id);
                    break;
                }
            }
        }
        return active;
    }
    schedule() {
        if (this.closed)
            return;
        clearTimeout(this.timer);
        // Vite finishes import analysis after our transform. This deferred sweep is
        // opportunistic; catalog updates also sweep synchronously before comparison.
        this.timer = setTimeout(() => { this.timer = undefined; this.sweep(); }, 100);
        this.timer.unref();
    }
    sweep() {
        if (this.closed)
            return;
        const environments = [...this.environments()], active = new Set();
        for (const environment of environments)
            for (const id of this.active(environment))
                active.add(id);
        const abandoned = [];
        for (const [id, { selection }] of this.selections.modules)
            if (!active.has(selection.id))
                abandoned.push(id);
        this.selections.dropCached(abandoned);
        this.invalidate(environments, abandoned);
    }
    invalidate(environments, ids) {
        for (const environment of environments) {
            const graph = environment.moduleGraph, seen = new Set();
            for (const id of ids) {
                const module = graph.getModuleById(id);
                // The public invalidation API clears soft snapshots too. A null
                // transformResult alone does not prove that all cached code is gone.
                if (module)
                    graph.invalidateModule(module, seen);
            }
        }
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        clearTimeout(this.timer);
        this.invalidate([...this.environments()], [...this.selections.modules.keys()]);
        this.selections.clear();
        this.owners = new WeakMap();
    }
}
