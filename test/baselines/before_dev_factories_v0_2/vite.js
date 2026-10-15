import { dirname, resolve } from 'node:path';
import { Selections } from './selection.js';
import { Sharing } from './sharing.js';
import { CatalogWatch } from './build-watch.js';
import { DevSelections } from './dev-selections.js';
import { generate as generateOnce, createGenerator } from './project.js';
import { configName, readConfig } from './config.js';
import { CompileError, diagnosticSummary } from './diagnostics.js';
/** Generate real modules/types so imports also work in editors, tests and SSR. */
export function fasti18n(options) {
    let root;
    let input;
    let development = false;
    let shareMessages = true;
    let workerOrLibrary = false;
    let tail = Promise.resolve();
    let project;
    let generate;
    let built = false;
    const developmentSelections = new Selections(() => project);
    let devSelections;
    const buildSelections = new WeakMap();
    const selectionsFor = (environment) => buildSelections.get(environment) ?? developmentSelections;
    const sharing = new WeakMap();
    const catalogWatches = new WeakMap();
    const failedEnvironments = new WeakSet();
    const updates = new Map();
    function run(read) {
        const job = tail.then(async () => {
            devSelections?.sweep();
            try {
                project = await generate(read);
            }
            catch (error) {
                if (!(error instanceof CompileError))
                    throw error;
                const diagnostic = error.diagnostics.find(item => item.file);
                if (!diagnostic)
                    throw error;
                throw Object.assign(new Error(error.diagnostics.map(diagnosticSummary).join('\n\n'), { cause: error }), {
                    name: error.name, plugin: 'fasti18n', id: diagnostic.file, frame: diagnostic.frame,
                    // The overlay passes this position verbatim to its editor link.
                    loc: diagnostic.location ? { file: diagnostic.file, line: diagnostic.location.line, column: diagnostic.location.column } : undefined,
                });
            }
            return { result: project, virtual: development ? developmentSelections.update() : [] };
        });
        // A bad catalog must not poison the queue after the user fixes it.
        tail = job.catch(() => undefined);
        return job;
    }
    return {
        name: 'fasti18n',
        // Run after TypeScript/JSX transforms so static selection analysis sees JS.
        enforce: 'post',
        resolveId(id) { return sharing.get(this.environment)?.resolve(id) ?? selectionsFor(this.environment).resolve(id); },
        load(id) {
            const shared = sharing.get(this.environment);
            if (development && developmentSelections.modules.has(id))
                devSelections?.schedule();
            return shared?.handles(id) ? shared.load(id, this) : selectionsFor(this.environment).load(id);
        },
        moduleParsed(info) { sharing.get(this.environment)?.parsed(info); },
        buildEnd(error) {
            if (!error)
                buildSelections.get(this.environment)?.retain(this.getModuleIds());
            sharing.get(this.environment)?.finish();
        },
        closeBundle() {
            if (development) {
                devSelections?.close();
                updates.clear();
            }
            if (!development && !this.environment.config.build.watch) {
                buildSelections.delete(this.environment);
                sharing.delete(this.environment);
            }
        },
        async closeWatcher() {
            const pending = catalogWatches.get(this.environment);
            catalogWatches.delete(this.environment);
            await (await pending)?.close();
            buildSelections.delete(this.environment);
            sharing.delete(this.environment);
        },
        async transform(code, id) {
            const selected = development ? [] : undefined;
            const result = await selectionsFor(this.environment).transform(code, id, source => this.parse(source), async (source) => (await this.resolve(source, id, { skipSelf: true }))?.id, message => this.warn(message), selected);
            if (selected)
                devSelections?.record(this.environment, id, selected);
            return result;
        },
        configureServer(server) { devSelections = new DevSelections(developmentSelections, () => Object.values(server.environments)); },
        async configResolved(config) {
            root = config.root;
            development = config.command === 'serve';
            workerOrLibrary = config.isWorker || !!config.build.lib;
            const configFile = resolve(root, configName);
            const loaded = options ?? await readConfig(configFile) ?? {};
            if (loaded.shareMessages !== undefined && typeof loaded.shareMessages !== 'boolean')
                throw new Error('fasti18n: shareMessages must be a boolean');
            shareMessages = loaded.shareMessages !== false;
            if (!options)
                config.configFileDependencies.push(configFile.split('\\').join('/'));
            const { shareMessages: _sharing, ...catalogOptions } = loaded;
            const configured = { ...catalogOptions, root, baseLocale: loaded.baseLocale ?? 'en', development: loaded.development ?? development };
            input = resolve(root, configured.catalogs ?? 'messages');
            generate = development || config.build.watch ? createGenerator(configured) : read => generateOnce(configured, read);
            await run();
        },
        async buildStart(options) {
            let catalogWatch;
            if (!development && this.environment.config.build.watch) {
                let pending = catalogWatches.get(this.environment);
                if (!pending) {
                    pending = CatalogWatch.create(input, error => this.warn(`fasti18n: catalog watcher: ${String(error)}`));
                    catalogWatches.set(this.environment, pending);
                }
                catalogWatch = await pending;
                this.addWatchFile(catalogWatch.marker);
            }
            this.addWatchFile(input);
            // Register the last successful inputs before compilation so a failed
            // catalog edit can still trigger its repair build.
            for (const file of project.catalogFiles)
                this.addWatchFile(file);
            // configResolved already generated the first build's modules/types.
            // A later watch rebuild must still reread the catalogs.
            const result = built ? (await run()).result : project;
            built = true;
            let selections = buildSelections.get(this.environment);
            if (!development && !selections) {
                selections = new Selections(() => project);
                buildSelections.set(this.environment, selections);
            }
            const build = this.environment.config.build;
            const server = this.environment.config.consumer === 'server';
            if (!development && shareMessages && (server || (!workerOrLibrary && build.modulePreload !== false && !build.modulePreload.resolveDependencies))) {
                const inputs = typeof options.input === 'string' ? [options.input] : Object.values(options.input ?? {});
                sharing.set(this.environment, new Sharing(selections, inputs));
            }
            else
                sharing.delete(this.environment);
            for (const file of result.catalogFiles)
                this.addWatchFile(file);
            catalogWatch?.refresh(result.catalogFiles);
        },
        async hotUpdate(ctx) {
            if (ctx.type === 'delete')
                devSelections?.removeFile(this.environment, ctx.file);
            if (dirname(ctx.file) !== input || !ctx.file.endsWith('.json')) {
                devSelections?.schedule();
                return;
            }
            const key = `${ctx.file}:${ctx.timestamp}:${ctx.type}`;
            let job = updates.get(key);
            if (!job) {
                // Vite's read() waits for editors that temporarily truncate files.
                job = run(ctx.type === 'delete' ? undefined : async (file) => file === ctx.file ? ctx.read() : import('node:fs/promises').then(fs => fs.readFile(file, 'utf8')))
                    .then(({ result, virtual }) => ({ changed: result.changed, virtual }));
                updates.set(key, job);
                if (updates.size > 8)
                    updates.delete(updates.keys().next().value);
            }
            let result;
            try {
                result = await job;
            }
            catch (error) {
                failedEnvironments.add(this.environment);
                throw error;
            }
            const graph = this.environment.moduleGraph;
            const active = devSelections?.active(this.environment);
            const affected = new Set(ctx.modules);
            for (const file of result.changed) {
                if (!file.endsWith('.js'))
                    continue;
                for (const module of graph.getModulesByFile(file) ?? []) {
                    graph.invalidateModule(module, new Set(), ctx.timestamp, true);
                    affected.add(module);
                }
            }
            for (const id of result.virtual) {
                const module = graph.getModuleById(id);
                if (module) {
                    graph.invalidateModule(module, new Set(), ctx.timestamp, true);
                    const family = developmentSelections.modules.get(id)?.selection.id;
                    // Detached virtual modules still need fresh code on a later request,
                    // but including them in HMR propagation would force unrelated reloads.
                    if (!family || !active || active.has(family))
                        affected.add(module);
                }
            }
            // Undoing invalid ICU can restore identical output. Vite still needs a
            // success event to dismiss its error overlay (or perform its first-update
            // recovery reload), even when no generated module changed.
            if (failedEnvironments.delete(this.environment))
                this.environment.hot.send({ type: 'update', updates: [] });
            return [...affected];
        },
    };
}
export default fasti18n;
