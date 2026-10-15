import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { lstat, mkdir, open, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { discoverConfig, readConfig } from './config.js';
import { createGenerator, generate as generateProject, readOutputManifest } from './project.js';
import type { GenerateOptions } from './project.js';
import { cacheKey } from './persistent-cache.js';

export type { GenerateOptions } from './project.js';

export type NextConfig = object;
export type NextConfigContext = Record<string, unknown>;
export type NextConfigFactory = (
  phase: string,
  context: NextConfigContext,
) => NextConfig | Promise<NextConfig>;
export type NextConfigInput = NextConfig | NextConfigFactory;
export type NextOptions = Omit<GenerateOptions, 'baseLocale'> & { baseLocale?: string };

type FileStamp = string | undefined;
type GenerationMemo = { promise: Promise<void>; settled: boolean; output?: string };
const generationMemo = new Map<string, GenerationMemo>();
type NextWatcher = { watcher: FSWatcher; timer?: ReturnType<typeof setTimeout>; queue: Promise<unknown> };
const developmentWatchers = new Map<string, NextWatcher>();
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const traceGeneration = (event: string) => {
  if (process.env.NORDBEAM_LOCALE_TRACE_GENERATION === '1' || process.env.NORDBEAM_I18N_TRACE_GENERATION === '1') console.error(`Nordbeam Locale: next generation ${event}`);
};
// Several processes (Next's build workers) can call the wrapper for one outDir.
// The lock serializes them; the stamp lets the later callers skip regeneration.
// Both live in the project cache, not outDir, because outDir is committed output.
const generationCache = 'node_modules/.cache/nordbeam-locale';
const lockStaleMs = 60_000;
const lockTimeoutMs = 300_000;

async function stamp(file: string): Promise<FileStamp> {
  try {
    const stat = await lstat(file, { bigint: true });
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  } catch (error) { if (missing(error)) return; throw error; }
}

async function readOptional(file: string): Promise<string | undefined> {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (missing(error)) return; throw error; }
}

async function inputStamp(input: string, configFile: string): Promise<string> {
  const directory = await stamp(input);
  const files = (await readdir(input, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => resolve(input, entry.name)).sort();
  return JSON.stringify([directory, await Promise.all(files.map(stamp)), await stamp(configFile)]);
}

/** Content identity shared by every process generating this configuration. */
async function generationKey(options: GenerateOptions, root: string, configFile: string): Promise<string | undefined> {
  const input = resolve(root, options.catalogs ?? 'messages');
  const files = (await readdir(input, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => resolve(input, entry.name)).sort();
  const sources = await Promise.all([...files, configFile].map(async file => ({ file, text: await readOptional(file) ?? '' })));
  return cacheKey(options, sources, resolve(root, options.outDir ?? 'src/i18n'));
}

function valueKey(value: unknown, parents = new Set<object>()): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'undefined': return 'undefined';
    case 'string': return JSON.stringify(value);
    case 'number': return `number:${String(value)}`;
    case 'boolean': return String(value);
    case 'object': {
      if (parents.has(value)) throw new TypeError('Next generation options must not contain cycles.');
      parents.add(value);
      const key = Array.isArray(value)
        ? `[${value.map(item => valueKey(item, parents)).join(',')}]`
        : `{${Object.keys(value).sort().map(item => `${JSON.stringify(item)}:${valueKey((value as Record<string, unknown>)[item], parents)}`).join(',')}}`;
      parents.delete(value);
      return key;
    }
    default: throw new TypeError('Next generation options must contain only data.');
  }
}

async function outputStamp(outDir: string): Promise<string | undefined> {
  const found = await readOutputManifest(outDir);
  if (!found) return;
  let files: string[];
  try { files = (JSON.parse(found.text) as { files: string[] }).files; }
  catch { return; }
  const stamps = await Promise.all([stamp(found.file), ...files.map(file => stamp(resolve(outDir, file)))]);
  return stamps.includes(undefined) ? undefined : JSON.stringify(stamps);
}

async function lockIsStale(lock: string): Promise<boolean> {
  let modified: number;
  let text: string;
  try {
    modified = (await stat(lock)).mtimeMs;
    text = await readFile(lock, 'utf8');
  } catch (error) { if (missing(error)) return false; throw error; }
  if (Date.now() - modified > lockStaleMs) return true;
  // A half-written lock has no pid yet; its age decides.
  let pid: unknown;
  try { pid = (JSON.parse(text) as { pid?: unknown }).pid; }
  catch { return false; }
  if (!Number.isInteger(pid)) return false;
  try { process.kill(pid as number, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

function generationFiles(root: string, outDir: string): { stamp: string; lock: string } {
  const name = `next-${createHash('sha256').update(outDir).digest('hex').slice(0, 16)}`;
  const directory = resolve(root, generationCache);
  return { stamp: resolve(directory, `${name}.stamp`), lock: resolve(directory, `${name}.lock`) };
}

async function withGenerationLock(lock: string, run: () => Promise<void>): Promise<void> {
  await mkdir(dirname(lock), { recursive: true });
  const deadline = Date.now() + lockTimeoutMs;
  for (;;) {
    try {
      const handle = await open(lock, 'wx');
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() })); }
      finally { await handle.close(); }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await lockIsStale(lock)) {
        await unlink(lock).catch(ignoreMissing);
        continue;
      }
      if (Date.now() > deadline) throw new Error(`Nordbeam Locale: timed out waiting for generation lock ${lock}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  try { await run(); }
  finally { await unlink(lock).catch(ignoreMissing); }
}

function ignoreMissing(error: unknown): void {
  if (!missing(error)) throw error;
}

async function generateExclusive(options: GenerateOptions, root: string, outDir: string, key: string | undefined): Promise<void> {
  const { stamp: stampFile, lock } = generationFiles(root, outDir);
  await withGenerationLock(lock, async () => {
    if (key !== undefined && await readOptional(stampFile) === key && await outputStamp(outDir) !== undefined) {
      traceGeneration('stamp-hit');
      return;
    }
    await rm(stampFile, { force: true });
    traceGeneration('generate');
    await generateProject(options);
    if (key !== undefined) await writeFile(stampFile, key);
  });
}

async function generateMemoized(options: GenerateOptions, root: string, configFile: string): Promise<void> {
  const input = resolve(root, options.catalogs ?? 'messages');
  const outDir = resolve(root, options.outDir ?? 'src/i18n');
  // This cache deliberately stays process-local. Cross-process reuse goes
  // through the generation stamp and lock, which are verified under the lock.
  // Compute the stamp before looking up an in-flight entry so a concurrent
  // call after a catalog/config edit cannot accidentally reuse old work.
  const key = valueKey([options, await inputStamp(input, configFile)]);
  const digest = await generationKey(options, root, configFile);
  const existing = generationMemo.get(key);
  if (existing) {
    if (!existing.settled) return existing.promise;
    if (existing.output !== undefined && existing.output === await outputStamp(outDir)) { traceGeneration('cache-hit'); return existing.promise; }
    generationMemo.delete(key);
  }
  const entry: GenerationMemo = { promise: Promise.resolve(), settled: false };
  entry.promise = generateExclusive(options, root, outDir, digest).then(async () => {
    // Publish only after output metadata is complete so concurrent config
    // calls share the in-flight promise during this final verification.
    entry.output = await outputStamp(outDir);
    entry.settled = true;
  }).catch(error => {
    generationMemo.delete(key);
    throw error;
  });
  generationMemo.set(key, entry);
  // Keep a bounded history for short-lived Next config reloads without
  // retaining every catalog revision in a long-running process.
  if (generationMemo.size > 16) generationMemo.delete(generationMemo.keys().next().value!);
  return entry.promise;
}

/** Keep Next dev in sync with catalog edits in the same process as next dev.
 * `persistent:false` is intentional: Next owns the process lifecycle and the
 * watcher must never prevent it from exiting. */
function startDevelopmentWatcher(root: string, options: GenerateOptions): void {
  const input = resolve(root, options.catalogs ?? 'messages');
  if (developmentWatchers.has(input)) return;
  let state: NextWatcher;
  const run = createGenerator(options);
  const queue = (file?: string) => {
    if (file && !file.toString().endsWith('.json')) return;
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.queue = state.queue.then(() => run()).catch(error => {
        // Keep the last valid generated output available while Next reports the
        // catalog error. A subsequent edit retries automatically.
        console.error(`Nordbeam Locale: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, 50);
  };
  state = { watcher: watch(input, { persistent: false }, (_event, file) => queue(file?.toString())), queue: Promise.resolve() };
  state.watcher.on('error', error => console.error(`Nordbeam Locale: catalog watcher: ${String(error)}`));
  developmentWatchers.set(input, state);
}

/** Generate Nordbeam Locale's ordinary ESM before Next.js starts compiling. */
export function withNordbeamLocale(
  nextConfig: NextConfigInput = {},
  options: NextOptions = {},
): NextConfigFactory {
  return async (phase, context) => {
    const configuredNext = typeof nextConfig === 'function'
      ? await nextConfig(phase, context)
      : nextConfig;
    if (!configuredNext || typeof configuredNext !== 'object' || Array.isArray(configuredNext)) {
      throw new TypeError('Nordbeam Locale: Next.js configuration must resolve to an object.');
    }

    const root = resolve(options.root ?? '.');
    const configFile = await discoverConfig(root);
    const discovered = await readConfig(configFile) ?? {};
    const development = process.env.NODE_ENV !== 'production';
    const generationOptions: GenerateOptions = {
      ...discovered,
      ...options,
      root,
      baseLocale: options.baseLocale ?? discovered.baseLocale ?? 'en',
      // Validation is an environment concern. In particular, a config file
      // with `development: true` must not make a production Next build ship
      // argument guards (and dev builds must not silently inherit false).
      development,
    };
    await generateMemoized(generationOptions, root, configFile);
    if (development && (process.env.NODE_ENV === 'development' || phase.includes('development'))) {
      startDevelopmentWatcher(root, generationOptions);
    }
    return configuredNext;
  };
}

/** @deprecated Use withNordbeamLocale. */
export const withNordbeamI18n = withNordbeamLocale;
