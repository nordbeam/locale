import { watch, type FSWatcher } from 'node:fs';
import { mkdtemp, writeFile, appendFile, rm, realpath, readdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Bridge new catalog files into the bundler's file watcher. Existing catalogs
 * are watched directly. Some native watchers accept a directory dependency but
 * do not rebuild when a previously unknown child appears.
 */
export class CatalogWatch {
  private known = new Map<string, string | undefined>();
  private events = new Map<string | null, { revision: number }>();
  private eventRevision = 0;
  private epoch = 0;
  private building = false;
  private observed: { fingerprints: Map<string, string | undefined>; revision: number } | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<unknown> = Promise.resolve();
  private revision = 0;
  private closed = false;
  private watcher: FSWatcher | undefined;
  private constructor(readonly marker: string, private readonly directory: string, private readonly input: string, private readonly warn: (error: unknown) => void) {}

  static async create(input: string, warn: (error: unknown) => void): Promise<CatalogWatch> {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'nordbeam-locale-vite-watch-')));
    const bridge = new CatalogWatch(join(directory, 'catalogs'), directory, input, warn);
    try {
      await writeFile(bridge.marker, '0');
      bridge.watcher = watch(input, { persistent: false }, (event, name) => bridge.changed(event, name));
      bridge.watcher.on('error', warn);
      return bridge;
    } catch (error) { await bridge.close(); throw error; }
  }

  /** Register this attempt's inputs before compiling, even if they are invalid.
   * Events arriving during the attempt remain pending for another build.
   */
  async start(): Promise<string[]> {
    this.building = true;
    this.epoch++;
    clearTimeout(this.timer);
    this.timer = undefined;
    const revision = this.eventRevision;
    try {
      const names = await this.names();
      const fingerprints = await this.snapshot(names);
      const files = names.map(name => join(this.input, name));
      this.observed = { fingerprints, revision };
      return files;
    } catch (error) {
      this.building = false;
      this.schedule();
      throw error;
    }
  }

  finish(): void {
    if (!this.observed) return;
    this.known = this.observed.fingerprints;
    for (const [name, event] of this.events) if (event.revision <= this.observed.revision) this.events.delete(name);
    this.observed = undefined;
    this.building = false;
    this.schedule();
  }

  private async names(): Promise<string[]> {
    return (await readdir(this.input, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => entry.name);
  }

  private async snapshot(names: string[]): Promise<Map<string, string | undefined>> {
    const result = new Map<string, string | undefined>();
    for (let offset = 0; offset < names.length; offset += 16) {
      const batch = names.slice(offset, offset + 16);
      const states = await Promise.allSettled(batch.map(async name => {
        try {
          const stat = await lstat(join(this.input, name), { bigint: true });
          return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
        } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      }));
      for (let index = 0; index < batch.length; index++) {
        const state = states[index]!;
        if (state.status === 'rejected') throw state.reason;
        result.set(batch[index]!, state.value);
      }
    }
    return result;
  }

  private changed(_event: string, name: string | null): void {
    if (this.closed || (name !== null && !name.endsWith('.json'))) return;
    this.events.set(name, { revision: ++this.eventRevision });
    this.schedule();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.closed || this.building || !this.events.size) return;
    // Coalesce editor writes and stay beyond the native watcher's event throttle.
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pending = this.pending.then(async () => {
        if (this.closed || this.building || !this.events.size) return;
        const epoch = this.epoch, events = new Map(this.events);
        const names = await this.names();
        const membershipChanged = names.length !== this.known.size || names.some(name => !this.known.has(name));
        let changed = membershipChanged;
        // The bundler may start watching a known file after it was read. A
        // delayed rename/change still needs a rebuild if that attempt saw an
        // older file. Comparing metadata also suppresses already-handled edits.
        if (!changed) {
          const current = await this.snapshot(events.has(null) ? names : [...events.keys()].filter((name): name is string => name !== null && this.known.has(name)));
          changed = [...current].some(([name, state]) => state !== this.known.get(name));
        }
        // A native-triggered build may have consumed these events during I/O.
        if (this.closed || this.building || this.epoch !== epoch) return;
        for (const [name, event] of events) if (this.events.get(name) === event) this.events.delete(name);
        // Append rather than truncate-and-write: a truncating write is two native
        // change events, and each one would make the bundler rebuild.
        if (changed) await appendFile(this.marker, `${++this.revision}\n`);
      }).catch(this.warn);
    }, 75);
    this.timer.unref();
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    this.watcher?.close();
    await this.pending;
    await rm(this.directory, { recursive: true, force: true });
  }
}
