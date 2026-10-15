import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { appendFile, lstat, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { Plugin, DevEnvironment } from 'vite';
import type { ESTree } from 'vite';
import { Selections } from './selection.js';
import { Sharing } from './sharing.js';
import { CatalogWatch } from './build-watch.js';
import { DevSelections } from './dev-selections.js';
import { generate as generateOnce, createGenerator } from './project.js';
import type { GenerateOptions, GenerateResult } from './project.js';
import { discoverConfig, readConfig } from './config.js';
import { CompileError, diagnosticSummary } from './diagnostics.js';
import { preloadManifest } from './preload-manifest.js';
import type { SelectionFallbackMode } from './selection.js';
export type { SelectionFallbackMode } from './selection.js';
export type { GenerateOptions } from './project.js';
export type { NordbeamLocalePreloadManifest, NordbeamI18nPreloadManifest } from './preload-manifest.js';

type FileStamp = string | undefined;
type GenerationMemo = {
  promise: Promise<GenerateResult>;
  result?: GenerateResult;
  output?: string;
};

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const traceGeneration = (event: string) => {
  if (process.env.NORDBEAM_LOCALE_TRACE_GENERATION === '1' || process.env.NORDBEAM_I18N_TRACE_GENERATION === '1') console.error(`Nordbeam Locale: vite generation ${event}`);
};
async function stamp(file: string): Promise<FileStamp> {
  try {
    const stat = await lstat(file, { bigint: true });
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  } catch (error) { if (missing(error)) return; throw error; }
}

// This key intentionally uses filesystem metadata rather than content hashes:
// generation still owns parsing and diagnostics, while a catalog edit, locale
// add/delete, or config edit always invalidates the in-process memo.
async function inputStamp(input: string, configFile?: string): Promise<string> {
  const directory = await stamp(input);
  const files = (await readdir(input, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => resolve(input, entry.name)).sort();
  return JSON.stringify([directory, await Promise.all(files.map(stamp)), configFile ? await stamp(configFile) : undefined]);
}

function valueKey(value: unknown, parents = new Set<object>()): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'undefined': return 'undefined';
    case 'string': return JSON.stringify(value);
    case 'number': return `number:${String(value)}`;
    case 'boolean': return String(value);
    case 'object': {
      if (parents.has(value)) throw new TypeError('Vite generation options must not contain cycles.');
      parents.add(value);
      const key = Array.isArray(value)
        ? `[${value.map(item => valueKey(item, parents)).join(',')}]`
        : `{${Object.keys(value).sort().map(item => `${JSON.stringify(item)}:${valueKey((value as Record<string, unknown>)[item], parents)}`).join(',')}}`;
      parents.delete(value);
      return key;
    }
    default: throw new TypeError('Vite generation options must contain only data.');
  }
}

async function outputStamp(result: GenerateResult): Promise<string> {
  const files = Object.keys(result.files).sort().map(file => resolve(result.outDir, file));
  // The current manifest name is written by every generate; the legacy name covers outputs not yet rewritten.
  const manifest = await stamp(resolve(result.outDir, '.nordbeam-locale-manifest.json')) ?? await stamp(resolve(result.outDir, '.nordbeam-i18n-manifest.json'));
  return JSON.stringify(await Promise.all([manifest, ...files.map(stamp)]));
}

export type ViteOptions = Omit<GenerateOptions, 'root' | 'baseLocale'> & {
  baseLocale?: string;
  /** Share overlapping selections in eligible builds. Default: true.
   * Client sharing requires Vite's unfiltered dynamic preload support.
   */
  shareMessages?: boolean;
  /** Emit the nordbeam-locale-preload.json asset for server/router modulepreload hints. Client
   * application entries only; disabled by default. Paths are output-relative. */
  preloadManifest?: boolean;
  /** Bind statically narrowed loaders to one locale. The selected messages are
   * imported synchronously into the route chunk. Unproven loader uses warn and
   * remain dynamic; this option does not constrain direct imports or global types. */
  staticLocale?: string;
  /** Control diagnostics when an automatic loadLocale call cannot be safely
   * narrowed. Defaults to "warn"; use "error" in CI or "off" for an
   * intentional full-catalog escape hatch. */
  selectionFallback?: SelectionFallbackMode;
};

/** Generate real modules/types so imports also work in editors, tests and SSR. */
export function nordbeamLocale(options?: ViteOptions): Plugin {
  let root: string;
  let input: string;
  let configFile: string | undefined;
  let development = false;
  let watch = false;
  let closing = false;
  let shareMessages = true;
  let emitPreloadManifest = false;
  let staticLocale: string | undefined;
  let selectionFallback: SelectionFallbackMode = 'warn';
  let workerOrLibrary = false;
  let tail: Promise<unknown> = Promise.resolve();
  let project: GenerateResult;
  let generate: ReturnType<typeof createGenerator>;
  let built = false;
  const generationMemo = new Map<string, GenerationMemo>();
  const developmentSelections = new Selections(() => project, () => staticLocale);
  let devSelections: DevSelections | undefined;
  const buildSelections = new WeakMap<object, Selections>();
  const selectionsFor = (environment: object) => buildSelections.get(environment) ?? developmentSelections;
  const sharing = new WeakMap<object, Sharing>();
  const catalogWatches = new WeakMap<object, Promise<CatalogWatch>>();
  // Watch builds ask for one follow-up build when a module changed after this
  // build began, because a native watcher can drop a write that lands mid-build.
  const buildStarts = new WeakMap<object, number>();
  const rebuildMarkers = new WeakMap<object, { marker: string; directory?: string }>();
  const verifiedModules = new Map<string, number>();
  const failedEnvironments = new WeakSet<DevEnvironment>();
  const updates = new Map<string, Promise<{ changed: string[]; virtual: string[] }>>();
  // Vite's watcher (chokidar) drops a second `change` for one path that lands
  // within 50 ms of the first, so a quick follow-up catalog write would never
  // reach hotUpdate. Each catalog update rechecks its file once that window has
  // passed and replays the change when the content moved on.
  let replayChange: ((file: string) => void) | undefined;
  const trailingChecks = new Map<string, ReturnType<typeof setTimeout>>();
  function recheckCatalog(file: string, compiled: string | undefined): void {
    clearTimeout(trailingChecks.get(file));
    const timer = setTimeout(() => {
      trailingChecks.delete(file);
      if (closing) return;
      // A file that is gone again reports its own unlink; only replay a newer write.
      readFile(file, 'utf8').then(current => { if (!closing && current !== compiled) replayChange?.(file); }, () => undefined);
    }, 75);
    timer.unref?.();
    trailingChecks.set(file, timer);
  }
  async function memoizedGeneration(read?: (file: string) => Promise<string>): Promise<GenerateResult> {
    // Read callbacks are used for hot updates and must always reach the
    // incremental generator. Stateless production builds are the only safe
    // place to share output between Vite environments. This memo is process
    // local; persistent artifact caching remains an explicit project option.
    if (read || development || watch || !generate || !root) return generate(read);
    const key = valueKey([root, input, options ?? null, await inputStamp(input, options ? undefined : configFile)]);
    const existing = generationMemo.get(key);
    if (existing) {
      if (existing.result && existing.output === await outputStamp(existing.result)) { traceGeneration('cache-hit'); return existing.result; }
      if (!existing.result) return existing.promise;
      generationMemo.delete(key);
    }
    const entry: GenerationMemo = { promise: Promise.resolve(undefined as never) };
    traceGeneration('generate');
    entry.promise = generate().then(async result => {
      const output = await outputStamp(result);
      // Publish the completed entry atomically from the memo's perspective:
      // callers arriving while output metadata is being read share the
      // in-flight promise instead of starting a duplicate generation.
      entry.output = output;
      entry.result = result;
      return result;
    }).catch(error => {
      generationMemo.delete(key);
      throw error;
    });
    generationMemo.set(key, entry);
    return entry.promise;
  }
  function run(read?: (file: string) => Promise<string>): Promise<{ result: GenerateResult; virtual: string[] }> {
    const job = tail.then(async () => {
      devSelections?.sweep();
      try { project = await memoizedGeneration(read); }
      catch (error) {
        if (!(error instanceof CompileError)) throw error;
        const diagnostic = error.diagnostics.find(item => item.file);
        if (!diagnostic) throw error;
        throw Object.assign(new Error(error.diagnostics.map(diagnosticSummary).join('\n\n'), { cause: error }), {
          name: error.name, plugin: 'nordbeam-locale', id: diagnostic.file, frame: diagnostic.frame,
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
  async function verifyModules(context: { environment: object; getModuleIds(): Iterable<string> }): Promise<void> {
    const started = buildStarts.get(context.environment), rebuild = rebuildMarkers.get(context.environment);
    if (started === undefined || !rebuild) return;
    // Generated catalogs and dependencies are not source edits; they are skipped.
    const outDir = project.outDir ? resolve(project.outDir) + sep : undefined;
    const files = [...context.getModuleIds()].filter(id => isAbsolute(id) && !id.includes('/node_modules/') && !(outDir && id.startsWith(outDir)));
    let changed = false;
    for (let offset = 0; offset < files.length; offset += 64) {
      const batch = files.slice(offset, offset + 64);
      const times = await Promise.all(batch.map(file => stat(file).then(item => item.mtimeMs, () => undefined)));
      batch.forEach((file, index) => {
        const mtime = times[index];
        // One follow-up per observed mtime: the rebuild it causes cannot retrigger itself.
        if (mtime === undefined || mtime < started || verifiedModules.get(file) === mtime) return;
        verifiedModules.set(file, mtime);
        changed = true;
      });
    }
    if (changed) await appendFile(rebuild.marker, `${Date.now()}\n`);
  }
  return {
    name: 'nordbeam-locale',
    // Run after TypeScript/JSX transforms so static selection analysis sees JS.
    enforce: 'post',
    resolveId(id) { return sharing.get(this.environment)?.resolve(id) ?? selectionsFor(this.environment).resolve(id); },
    load(id) {
      const shared = sharing.get(this.environment);
      if (development && developmentSelections.modules.has(id)) devSelections?.schedule();
      return shared?.handles(id) ? shared.load(id, this) : selectionsFor(this.environment).load(id);
    },
    moduleParsed(info) { sharing.get(this.environment)?.parsed(info); },
    generateBundle(_options, bundle) {
      if (!emitPreloadManifest || development || workerOrLibrary || this.environment.config.consumer === 'server') return;
      if (Object.hasOwn(bundle, 'nordbeam-locale-preload.json')
        || Object.values(bundle).some(item => item.fileName === 'nordbeam-locale-preload.json')) {
        this.error('Nordbeam Locale: cannot emit nordbeam-locale-preload.json because the bundle already owns that filename. Rename the existing asset or disable preloadManifest.');
      }
      const manifest = preloadManifest(root, project, selectionsFor(this.environment), bundle, id => this.getModuleInfo(id));
      this.emitFile({ type: 'asset', fileName: 'nordbeam-locale-preload.json', source: JSON.stringify(manifest, null, 2) + '\n' });
    },
    async buildEnd(error) {
      // Failed catalogs also become watched inputs. Acknowledge only events
      // that preceded their attempt; edits during compilation still wake it.
      const pending = catalogWatches.get(this.environment);
      if (pending) (await pending.catch(() => undefined))?.finish();
      if (!error) buildSelections.get(this.environment)?.retain(this.getModuleIds());
      sharing.get(this.environment)?.finish();
    },
    async closeBundle() {
      // The rebuild request must follow the completed bundle; during buildEnd the
      // bundler has not yet re-armed its watcher, so the write would be dropped.
      if (!development && this.environment.config.build.watch) {
        await verifyModules(this).catch(error => this.warn(`Nordbeam Locale: build verifier: ${String(error)}`));
      }
      if (development) {
        closing = true;
        for (const timer of trailingChecks.values()) clearTimeout(timer);
        trailingChecks.clear();
        await tail;
        devSelections?.close(); updates.clear();
      }
      if (!development && !this.environment.config.build.watch) {
        generationMemo.clear();
        buildSelections.delete(this.environment); sharing.delete(this.environment);
      }
    },
    async closeWatcher() {
      const pending = catalogWatches.get(this.environment);
      catalogWatches.delete(this.environment);
      await (await pending)?.close();
      const owned = rebuildMarkers.get(this.environment)?.directory;
      rebuildMarkers.delete(this.environment);
      if (owned) await rm(owned, { recursive: true, force: true });
      buildSelections.delete(this.environment); sharing.delete(this.environment);
    },
    async transform(code, id) {
      const selected = development ? [] as string[] : undefined;
      const result = await selectionsFor(this.environment).transform(code, id, source => this.parse(source) as unknown as ESTree.Program,
        async source => (await this.resolve(source, id, { skipSelf: true }))?.id,
        (message, node, level = 'warn') => {
          const position = typeof node?.start === 'number' ? node.start : undefined;
          if (position === undefined) {
            if (level === 'error') this.error(message);
            else this.warn(message);
            return;
          }
          const before = code.slice(0, position);
          const line = before.split('\n').length;
          const column = position - (before.lastIndexOf('\n') + 1);
          // Keep the structured location for Vite/Rolldown overlays and add a
          // compact textual location for loggers that discard log metadata.
          const located = `${id}:${line}:${column + 1}: ${message}`;
          const log = { code: 'SELECTION_FALLBACK', message: located, id, loc: { file: id, line, column } };
          if (level === 'error') this.error(log);
          else this.warn(log);
        }, selected, selectionFallback).catch(error => {
        // This module will never report moduleParsed, so shared discovery must fail now.
        sharing.get(this.environment)?.fail(error);
        throw error;
      });
      if (selected) devSelections?.record(this.environment as DevEnvironment, id, selected);
      return result;
    },
    configureServer(server) {
      devSelections = new DevSelections(developmentSelections, () => Object.values(server.environments));
      replayChange = file => { server.watcher.emit('change', file); };
    },
    async configResolved(config) {
      closing = false;
      root = config.root;
      development = config.command === 'serve';
      // A shared plugin may serve several environments; one watched
      // environment disables the stateless memo for the whole instance.
      watch ||= !!config.build.watch;
      workerOrLibrary = config.isWorker || !!config.build.lib;
      configFile = await discoverConfig(root);
      const loaded: ViteOptions = options ?? await readConfig(configFile) ?? {};
      if (loaded.shareMessages !== undefined && typeof loaded.shareMessages !== 'boolean') throw new Error('Nordbeam Locale: shareMessages must be a boolean');
      shareMessages = loaded.shareMessages !== false;
      if (loaded.preloadManifest !== undefined && typeof loaded.preloadManifest !== 'boolean') throw new Error('Nordbeam Locale: preloadManifest must be a boolean');
      emitPreloadManifest = loaded.preloadManifest === true;
      if (loaded.staticLocale !== undefined && (typeof loaded.staticLocale !== 'string' || !loaded.staticLocale)) throw new Error('Nordbeam Locale: staticLocale must be a nonempty string');
      staticLocale = loaded.staticLocale;
      if (loaded.selectionFallback !== undefined && !['warn', 'error', 'off'].includes(loaded.selectionFallback)) {
        throw new Error('Nordbeam Locale: selectionFallback must be "warn", "error", or "off"');
      }
      selectionFallback = loaded.selectionFallback ?? 'warn';
      if (!options) config.configFileDependencies.push(configFile.split('\\').join('/'));
      const { shareMessages: _sharing, preloadManifest: _manifest, staticLocale: _static, selectionFallback: _fallback, ...catalogOptions } = loaded;
      // Vite's command is authoritative. A config-level `development` flag
      // must not make a production build retain argument guards, nor disable
      // them for `vite serve` (the latter is the common missing-argument trap).
      const configured: GenerateOptions = { ...catalogOptions, root, baseLocale: loaded.baseLocale ?? 'en', development };
      input = resolve(root, configured.catalogs ?? 'messages');
      generate = development || config.build.watch ? createGenerator(configured) : read => generateOnce(configured, read);
      await run();
      if (staticLocale !== undefined && !project.locales.includes(staticLocale)) throw new Error(`Nordbeam Locale: staticLocale ${JSON.stringify(staticLocale)} is not a configured locale`);
    },
    async buildStart(options) {
      buildStarts.set(this.environment, Date.now());
      let catalogWatch: CatalogWatch | undefined;
      if (!development && this.environment.config.build.watch) {
        let pending = catalogWatches.get(this.environment);
        if (!pending) {
          pending = CatalogWatch.create(input, error => this.warn(`Nordbeam Locale: catalog watcher: ${String(error)}`));
          catalogWatches.set(this.environment, pending);
        }
        catalogWatch = await pending;
        rebuildMarkers.set(this.environment, { marker: catalogWatch.marker });
        this.addWatchFile(catalogWatch.marker);
        // The bridge is the only trigger for catalog edits. Native per-file or
        // directory watches also fire on each write and rebuild again.
        await catalogWatch.start();
      }
      if (!development && this.environment.config.build.watch && !catalogWatch && !rebuildMarkers.has(this.environment)) {
        const directory = await mkdtemp(join(tmpdir(), 'nordbeam-locale-rebuild-'));
        const marker = join(directory, 'rebuild');
        await writeFile(marker, '0');
        rebuildMarkers.set(this.environment, { marker, directory });
        this.addWatchFile(marker);
      }
      if (!catalogWatch) this.addWatchFile(input);
      // Register the last successful inputs before compilation so a failed
      // catalog edit can still trigger its repair build.
      if (!catalogWatch) for (const file of project.catalogFiles) this.addWatchFile(file);
      // configResolved already generated the first build's modules/types.
      // A later watch rebuild must still reread the catalogs.
      // Watch inputs can change between configResolved and this first attempt.
      // Its incremental generator makes an unchanged reread inexpensive.
      const result = built || catalogWatch ? (await run()).result : project;
      built = true;
      let selections = buildSelections.get(this.environment);
      if (!development && !selections) {
        selections = new Selections(() => project, () => staticLocale);
        buildSelections.set(this.environment, selections);
      }
      const build = this.environment.config.build;
      const server = this.environment.config.consumer === 'server';
      if (!development && shareMessages && (server || (!workerOrLibrary && build.modulePreload !== false && !build.modulePreload.resolveDependencies))) {
        const inputs = typeof options.input === 'string' ? [options.input] : Object.values(options.input ?? {});
        sharing.set(this.environment, new Sharing(selections!, inputs));
      } else sharing.delete(this.environment);
      if (!catalogWatch) for (const file of result.catalogFiles) this.addWatchFile(file);
    },
    async hotUpdate(ctx) {
      if (closing) return [];
      if (ctx.type === 'delete') devSelections?.removeFile(this.environment, ctx.file);
      if (dirname(ctx.file) !== input || !ctx.file.endsWith('.json')) { devSelections?.schedule(); return; }
      const key = `${ctx.file}:${ctx.timestamp}:${ctx.type}`;
      let job = updates.get(key);
      if (!job) {
        let compiled: string | undefined;
        // Vite's read() waits for editors that temporarily truncate files.
        job = run(ctx.type === 'delete' ? undefined : async file => file === ctx.file ? (compiled = await ctx.read()) : readFile(file, 'utf8'))
          .then(({result,virtual}) => ({changed:result.changed,virtual}));
        if (ctx.type !== 'delete') job.then(() => recheckCatalog(ctx.file, compiled), () => recheckCatalog(ctx.file, compiled));
        updates.set(key, job);
        if (updates.size > 8) updates.delete(updates.keys().next().value!);
      }
      let result: Awaited<typeof job>;
      try { result = await job; }
      catch (error) { failedEnvironments.add(this.environment); throw error; }
      const graph = this.environment.moduleGraph;
      const active = devSelections?.active(this.environment);
      const affected = new Set(ctx.modules);
      for (const file of result.changed) {
        if (!file.endsWith('.js')) continue;
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
          if (!family || !active || active.has(family)) affected.add(module);
        }
      }
      // Undoing invalid ICU can restore identical output. Vite still needs a
      // success event to dismiss its error overlay (or perform its first-update
      // recovery reload), even when no generated module changed.
      if (failedEnvironments.delete(this.environment)) this.environment.hot.send({type:'update',updates:[]});
      return [...affected];
    },
  };
}
/** @deprecated Use nordbeamLocale. */
export const nordbeamI18n = nordbeamLocale;
export default nordbeamLocale;
