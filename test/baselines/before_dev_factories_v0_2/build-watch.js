import { watch } from 'node:fs';
import { mkdtemp, writeFile, rm, realpath, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
/** Bridge new catalog files into the bundler's file watcher. Existing catalogs
 * are watched directly. Some native watchers accept a directory dependency but
 * do not rebuild when a previously unknown child appears.
 */
export class CatalogWatch {
    marker;
    directory;
    input;
    warn;
    known = new Set();
    events = new Set();
    timer;
    pending = Promise.resolve();
    revision = 0;
    closed = false;
    watcher;
    constructor(marker, directory, input, warn) {
        this.marker = marker;
        this.directory = directory;
        this.input = input;
        this.warn = warn;
    }
    static async create(input, warn) {
        const directory = await realpath(await mkdtemp(join(tmpdir(), 'fasti18n-vite-watch-')));
        const bridge = new CatalogWatch(join(directory, 'catalogs'), directory, input, warn);
        try {
            await writeFile(bridge.marker, '0');
            bridge.watcher = watch(input, { persistent: false }, (event, name) => bridge.changed(event, name));
            bridge.watcher.on('error', warn);
            return bridge;
        }
        catch (error) {
            await bridge.close();
            throw error;
        }
    }
    refresh(files) { this.known = new Set(files.map(file => basename(file))); }
    changed(event, name) {
        if (this.closed || (name !== null && (!name.endsWith('.json') || (event !== 'rename' && this.known.has(name)))))
            return;
        this.events.add(name);
        clearTimeout(this.timer);
        // Coalesce editor writes and stay beyond the native watcher's event throttle.
        this.timer = setTimeout(() => {
            this.timer = undefined;
            const events = [...this.events];
            this.events.clear();
            this.pending = this.pending.then(async () => {
                if (this.closed)
                    return;
                const names = (await readdir(this.input, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => entry.name);
                const membershipChanged = names.length !== this.known.size || names.some(name => !this.known.has(name));
                if (membershipChanged || events.some(name => name === null || !this.known.has(name))) {
                    await writeFile(this.marker, String(++this.revision));
                }
            }).catch(this.warn);
        }, 75);
        this.timer.unref();
    }
    async close() {
        this.closed = true;
        clearTimeout(this.timer);
        this.watcher?.close();
        await this.pending;
        await rm(this.directory, { recursive: true, force: true });
    }
}
