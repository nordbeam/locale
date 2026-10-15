import type { DevEnvironment } from 'vite';
import type { Selections } from './selection.js';

/** Release abandoned development code without invalidating old URL identities.
 * Owners protect selections while Vite is still resolving a changed module;
 * graph importers protect other consumers and environments that have not updated.
 */
export class DevSelections {
  private owners = new WeakMap<DevEnvironment, Map<string, ReadonlySet<string>>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  constructor(private readonly selections: Selections, private readonly environments: () => Iterable<DevEnvironment>) {}

  record(environment: DevEnvironment, id: string, selections: readonly string[]): void {
    let owners = this.owners.get(environment);
    if (!selections.length && !owners?.has(id)) return;
    if (!owners) { owners = new Map(); this.owners.set(environment, owners); }
    if (selections.length) owners.set(id, new Set(selections)); else owners.delete(id);
    this.schedule();
  }

  removeFile(environment: DevEnvironment, file: string): void {
    const owners = this.owners.get(environment);
    if (owners) for (const id of owners.keys()) if (id.split('?')[0] === file) owners.delete(id);
    this.schedule();
  }

  active(environment: DevEnvironment): Set<string> {
    const active = new Set<string>();
    for (const selections of this.owners.get(environment)?.values() ?? []) for (const id of selections) active.add(id);
    for (const [id, { selection }] of this.selections.modules) {
      if (active.has(selection.id)) continue;
      const module = environment.moduleGraph.getModuleById(id);
      for (const importer of module?.importers ?? []) {
        if (this.selections.modules.get(importer.id ?? '')?.selection.id !== selection.id) { active.add(selection.id); break; }
      }
    }
    return active;
  }

  schedule(): void {
    if (this.closed) return;
    clearTimeout(this.timer);
    // Vite finishes import analysis after our transform. This deferred sweep is
    // opportunistic; catalog updates also sweep synchronously before comparison.
    this.timer = setTimeout(() => { this.timer = undefined; this.sweep(); }, 100);
    this.timer.unref();
  }

  sweep(): void {
    if (this.closed) return;
    const environments = [...this.environments()], active = new Set<string>();
    for (const environment of environments) for (const id of this.active(environment)) active.add(id);
    const abandoned: string[] = [];
    for (const [id, { selection }] of this.selections.modules) if (!active.has(selection.id)) abandoned.push(id);
    this.selections.dropCached(abandoned);
    this.invalidate(environments, abandoned);
  }

  private invalidate(environments: readonly DevEnvironment[], ids: Iterable<string>): void {
    for (const environment of environments) {
      const graph = environment.moduleGraph, seen = new Set<NonNullable<ReturnType<typeof graph.getModuleById>>>();
      for (const id of ids) {
        const module = graph.getModuleById(id);
        // The public invalidation API clears soft snapshots too. A null
        // transformResult alone does not prove that all cached code is gone.
        if (module) graph.invalidateModule(module, seen);
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.timer);
    this.invalidate([...this.environments()], [...this.selections.modules.keys()]);
    this.selections.clear(); this.owners = new WeakMap();
  }
}
