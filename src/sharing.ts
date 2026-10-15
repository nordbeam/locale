import type { Rolldown } from 'vite';
import { quote } from './codegen.js';
import { nestedMessageAliases } from './nested-messages.js';
import type { Selections, Selection } from './selection.js';

type Dependencies = { importedIds: readonly string[]; dynamicallyImportedIds: readonly string[] };
type Partition = { id: number; entry: string; keys: string[]; nested: boolean };
type SharedModule = { partition: Partition; locale: string };
const prefix = 'virtual:nordbeam-locale/shared/';
// Rolldown stops scheduling after a module fails, so a parse that will never
// report moduleParsed must not hold the build forever. Real failures reject
// sooner through fail(); this bound only backstops errors no hook observes.
// It measures a stall (no module parsed at all), so slow large builds still finish.
const parseStallTimeout = 30_000;

/** One build/environment's graph. Locale boundaries stay unloaded until all
 * reachable application selections are known. Development keeps its own HMR
 * projections; watch builds construct a new graph on each buildStart.
 */
export class Sharing {
  private discovery: Promise<void> | undefined;
  private plans: Map<string, Map<string, Partition>> | undefined;
  private readonly parsedModules = new Map<string, Dependencies>();
  private readonly waiting = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  private failure: Error | undefined;
  private lastParsed = Date.now();
  private readonly modules = new Map<string, SharedModule>();
  constructor(private readonly selections: Selections, private readonly inputs: readonly string[]) {}

  parsed(info: Rolldown.ModuleInfo): void {
    if (this.plans) return;
    // Keep only edges; do not retain every application's transformed source.
    this.parsedModules.set(info.id, { importedIds: info.importedIds, dynamicallyImportedIds: info.dynamicallyImportedIds });
    this.lastParsed = Date.now();
    this.waiting.get(info.id)?.resolve();
    this.waiting.delete(info.id);
  }

  // Called when a module failed before its moduleParsed event. Pending
  // discovery must then reject instead of waiting for an event that cannot come.
  fail(error: unknown): void {
    this.failure ??= error instanceof Error ? error : new Error(String(error));
    this.reject(this.failure);
  }

  finish(): void {
    this.reject(new Error('Nordbeam Locale: build ended before every shared module was parsed'));
    this.parsedModules.clear();
  }

  private reject(error: Error): void {
    for (const waiter of this.waiting.values()) waiter.reject(error);
    this.waiting.clear();
  }

  resolve(id: string): string | undefined {
    const internal = '\0' + id;
    return this.modules.has(internal) ? internal : undefined;
  }

  handles(id: string): boolean {
    return this.modules.has(id) || this.selections.modules.get(id)?.locale !== undefined;
  }

  async load(id: string, context: Rolldown.PluginContext): Promise<string | undefined> {
    const shared = this.modules.get(id);
    if (shared) return this.selections.compile(shared.partition.entry, shared.locale, shared.partition.keys, shared.partition.nested);
    const descriptor = this.selections.modules.get(id);
    if (!descriptor || descriptor.locale === undefined) return;
    this.discovery ??= this.discover(context);
    await this.discovery;
    const { selection, locale } = descriptor;
    const owners = this.plans!.get(selection.id);
    // Another plugin can emit entries after discovery. Their existing isolated
    // projection remains correct and cannot change an already emitted group.
    if (!owners) return this.selections.load(id);
    const selected = new Map<Partition, string>();
    for (const key of selection.keys) {
      const partition = owners.get(key)!;
      if (!selected.has(partition)) selected.set(partition, `p${selected.size}`);
    }
    const imports: string[] = [];
    let offset = 0, inOrder = true;
    for (const [partition, name] of selected) {
      const specifier = `${prefix}${partition.id}/${locale}`;
      this.modules.set('\0' + specifier, { partition, locale });
      if (selected.size === 1 && equalKeys(selection.keys, partition.keys)) return `export {default} from ${quote(specifier)};\n`;
      imports.push(`import ${name} from ${quote(specifier)};`);
      for (const key of partition.keys) if (selection.keys[offset++] !== key) inOrder = false;
    }
    const properties = inOrder && offset === selection.keys.length ? [...selected.values()].map(name => `...${name}`)
      : selection.keys.map(key => `[${quote(key)}]:${selected.get(owners.get(key)!)}[${quote(key)}]`);
    if (!selection.nested) return imports.join('\n') + `\nexport default {__proto__:null,${properties.join(',')}};\n`;
    const aliases = nestedMessageAliases(selection.keys);
    return imports.join('\n') + `\nconst messages={__proto__:null,${properties.join(',')}};${aliases}export default messages;\n`;
  }

  private awaitParsed(id: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.failure) return reject(this.failure);
      let timer: ReturnType<typeof setTimeout>;
      const check = () => {
        const idle = Date.now() - this.lastParsed;
        if (idle < parseStallTimeout) { timer = setTimeout(check, parseStallTimeout - idle); return; }
        this.waiting.delete(id);
        reject(new Error(`Nordbeam Locale: timed out waiting for build module ${id} to parse (no module parsed for ${parseStallTimeout / 1000} s)`));
      };
      timer = setTimeout(check, parseStallTimeout);
      this.waiting.set(id, {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
    });
  }

  private async discover(context: Rolldown.PluginContext): Promise<void> {
    const visited = new Set<string>(), selected = new Set<string>();
    const walk = async (resolved: Rolldown.ResolvedId | { id: string; external?: boolean } | null): Promise<void> => {
      if (this.failure) throw this.failure;
      if (!resolved || resolved.external || visited.has(resolved.id)) return;
      const id = resolved.id;
      visited.add(id);
      if (this.selections.modules.has(id)) { selected.add(id); return; }
      if (!this.parsedModules.has(id)) {
        const info = await context.load({ ...resolved, resolveDependencies: true });
        if (!info) throw new Error(`Nordbeam Locale: could not inspect build module ${id}`);
        // Cached code may be returned before resolution completes. moduleParsed
        // supplies the final edges without waiting on its imported modules.
        if (!this.parsedModules.has(id)) await this.awaitParsed(id);
      }
      const ready = this.parsedModules.get(id)!;
      for (const child of [...ready.importedIds, ...ready.dynamicallyImportedIds]) {
        if (this.selections.modules.has(child)) { selected.add(child); continue; }
        // moduleParsed proves this is an internal, already resolved module.
        // Reuse its edges instead of re-entering every plugin's resolver/loader.
        if (this.parsedModules.has(child)) { await walk({ id: child }); continue; }
        const resolution = await context.resolve(child, id);
        if (resolution) await walk(resolution);
        else if (context.getModuleInfo(child)) await walk({ id: child });
      }
    };
    const entries = new Set(this.inputs);
    for (const id of context.getModuleIds()) if (context.getModuleInfo(id)?.isEntry) entries.add(id);
    for (const input of entries) await walk(await context.resolve(input, undefined, { isEntry: true }));

    const byEntry = new Map<string, Selection[]>();
    for (const id of [...selected].sort()) {
      const descriptor = this.selections.modules.get(id);
      if (!descriptor || descriptor.locale !== undefined) continue;
      const { selection } = descriptor;
      const group = byEntry.get(selection.entry) ?? [];
      group.push(selection); byEntry.set(selection.entry, group);
    }
    this.plans = new Map();
    let nextId = 0;
    for (const [entry, group] of byEntry) {
      const memberships = new Map<string, number[]>(), groups = new Map<string, Partition>(), owners = new Map<string, Partition>();
      for (let index = 0; index < group.length; index++) for (const key of group[index]!.keys) {
        const indices = memberships.get(key) ?? [];
        indices.push(index); memberships.set(key, indices);
      }
      for (const [key, indices] of memberships) {
        const signature = indices.join(',');
        let partition = groups.get(signature);
        if (!partition) { partition = { id: nextId++, entry, keys: [], nested: false }; groups.set(signature, partition); }
        partition.nested ||= indices.some(index => group[index]!.nested);
        partition.keys.push(key); owners.set(key, partition);
      }
      for (const selection of group) this.plans.set(selection.id, owners);
    }
    this.parsedModules.clear();
  }
}

function equalKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}
