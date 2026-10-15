import { dirname, resolve } from 'node:path';
import { Selections } from './selection.js';
import { generate as generateOnce, createGenerator } from './project.js';
import { configName, readConfig } from './config.js';
import { CompileError, diagnosticSummary } from './diagnostics.js';
/** Generate real modules/types so imports also work in editors, tests and SSR. */
export function fasti18n(options) {
    let root;
    let input;
    let development = false;
    let tail = Promise.resolve();
    let project;
    let generate;
    let built = false;
    const selections = new Selections(() => project);
    const failedEnvironments = new WeakSet();
    const updates = new Map();
    function run(read) {
        const job = tail.then(async () => {
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
            return { result: project, virtual: selections.update() };
        });
        // A bad catalog must not poison the queue after the user fixes it.
        tail = job.catch(() => undefined);
        return job;
    }
    return {
        name: 'fasti18n',
        // Run after TypeScript/JSX transforms so static selection analysis sees JS.
        enforce: 'post',
        resolveId(id) { return selections.resolve(id); },
        load(id) { return selections.load(id); },
        async transform(code, id) {
            return selections.transform(code, id, source => this.parse(source), async (source) => (await this.resolve(source, id, { skipSelf: true }))?.id, message => this.warn(message));
        },
        async configResolved(config) {
            root = config.root;
            development = config.command === 'serve';
            const configFile = resolve(root, configName);
            const loaded = options ?? await readConfig(configFile) ?? {};
            if (!options)
                config.configFileDependencies.push(configFile.split('\\').join('/'));
            const configured = { ...loaded, root, baseLocale: loaded.baseLocale ?? 'en', development: loaded.development ?? development };
            input = resolve(root, configured.catalogs ?? 'messages');
            generate = development || config.build.watch ? createGenerator(configured) : read => generateOnce(configured, read);
            await run();
        },
        async buildStart() {
            // configResolved already generated the first build's modules/types.
            // A later watch rebuild must still reread the catalogs.
            const result = built ? (await run()).result : project;
            built = true;
            this.addWatchFile(input);
            for (const file of result.catalogFiles)
                this.addWatchFile(file);
        },
        async hotUpdate(ctx) {
            if (dirname(ctx.file) !== input || !ctx.file.endsWith('.json'))
                return;
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
