import { createHash, hash as digestOf } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import type { CompiledProject } from './compiler.js';

const maximumBytes = 64 * 1024 * 1024;
const sha1 = (value: string) => digestOf('sha1', value);
let fingerprint: Promise<string> | undefined;

function safeRelativeFile(file: string): boolean {
  // Cache contents are untrusted input. Keep path checks independent of the
  // host platform so a cache made on Windows cannot introduce a drive path or
  // backslash traversal when restored on POSIX (and vice versa).
  if (!file || file === '.' || file === '..' || file.includes('\\') || file.startsWith('/') || /^[A-Za-z]:/.test(file)) return false;
  const parts = file.split('/');
  return parts.every(part => part !== '' && part !== '.' && part !== '..');
}

function readOptionalSync(file: URL): Buffer {
  try { return readFileSync(file); } catch { return Buffer.alloc(0); }
}

/** Include the emitted implementation, not just a package version which may
 * remain unchanged during development. The fingerprint is scoped to the
 * loaded module: a fresh CLI/build process recomputes it, while one process
 * must not change cache keys midway through a generation session if files are
 * edited underneath its already-loaded compiler. */
async function implementation(): Promise<string> {
  // Synchronous reads: this runs once per process over about 60 small files, and
  // promise-based reads cost several times more CPU than the hashing itself.
  return fingerprint ??= (async () => {
    const directory = new URL('./', import.meta.url);
    const names = readdirSync(directory).filter(name => name.endsWith('.js')).sort();
    const hash = createHash('sha256');
    for (const name of names) hash.update(name).update(readFileSync(new URL(name, directory)));
    const pkg = readFileSync(new URL('../package.json', directory));
    // The compiler imports ICU parsing code from a dependency. A lockfile
    // change can alter emitted code even when this package's own version and
    // dist files are unchanged; published packages may not carry a lockfile.
    const lock = readOptionalSync(new URL('../package-lock.json', directory));
    hash.update(pkg).update(lock).update(JSON.stringify(process.versions)).update(process.platform).update(process.arch);
    return hash.digest('hex');
  })();
}

/** Non-data options bypass caching; preserve the compiler's own validation and
 * getter semantics. Explicit undefined/non-finite numbers must not collide. */
function dataKey(value: unknown, parents = new Set<object>()): string | undefined {
  if (value === null) return 'null';
  if (typeof value === 'undefined') return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return `number:${Object.is(value, -0) ? '-0' : String(value)}`;
  if (typeof value !== 'object' || parents.has(value)) return;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return;
  if (Object.getOwnPropertySymbols(value).length) return;
  parents.add(value);
  const parts: string[] = [];
  // Sorted, so options built in a different key order (CLI, init, Vite, Next) share a key.
  const names = Array.isArray(value) ? Object.keys(value) : Object.keys(value).sort();
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name)!;
    if (!('value' in descriptor)) { parents.delete(value); return; }
    const key = dataKey(descriptor.value, parents);
    if (key === undefined) { parents.delete(value); return; }
    parts.push(`${JSON.stringify(name)}:${key}`);
  }
  parents.delete(value);
  return `${Array.isArray(value) ? `array:${value.length}` : 'object'}{${parts.join(',')}}`;
}

/** What a generation depends on. `digest` covers all parts; the parts let
 * callers explain which input changed. Catalog entries are keyed by name. */
export interface InputDigest {
  readonly digest: string;
  readonly compiler: string;
  readonly options: string;
  readonly catalogs: Readonly<Record<string, string>>;
  readonly ignored: readonly string[];
}

/** Hash the compiler fingerprint, the effective options and each catalog's
 * bytes. Returns undefined when the options cannot be keyed safely. */
export async function inputDigest(options: unknown, sources: Iterable<{ name: string; text: string }>, outDir: string, ignored: readonly string[] = []): Promise<InputDigest | undefined> {
  const config = dataKey(options);
  if (config === undefined) return;
  const compiler = await implementation();
  const optionDigest = sha1(JSON.stringify([config, outDir]));
  const catalogs: Record<string, string> = Object.create(null);
  const whole = createHash('sha1').update(compiler).update('\0').update(optionDigest).update('\0').update(JSON.stringify(ignored));
  for (const { name, text } of sources) {
    const entry = sha1(text);
    catalogs[name] = entry;
    whole.update('\0').update(name).update('\0').update(entry);
  }
  return { digest: whole.digest('hex'), compiler, options: optionDigest, catalogs, ignored: [...ignored] };
}

/** Compatibility key for callers that identify catalogs by absolute file path. */
export async function cacheKey(options: unknown, sources: Iterable<{ file: string; text: string }>, outDir: string): Promise<string | undefined> {
  return (await inputDigest(options, [...sources].map(({ file, text }) => ({ name: file, text })), outDir))?.digest;
}

export function cacheName(input: string, outDir: string): string { return sha1(JSON.stringify([input, outDir])) + '.json'; }

/** Read a cache entry. The envelope is one header line (version, key and payload
 * length) followed by the JSON payload. Checking the key and length is cheap, so
 * a hit never hashes or re-encodes the payload; the parse validates its shape.
 * Restoring does not look at outDir: callers write any missing or modified
 * outputs from the restored project. */
export async function restoreCache(file: string, key: string): Promise<CompiledProject | undefined> {
  try {
    if ((await stat(file)).size > maximumBytes) return;
    const text = await readFile(file, 'utf8');
    const newline = text.indexOf('\n');
    if (newline < 0) return;
    const envelope = JSON.parse(text.slice(0, newline)) as { version?: unknown; key?: unknown; length?: unknown };
    const payload = text.slice(newline + 1);
    if (envelope.version !== 4 || envelope.key !== key || envelope.length !== payload.length) return;
    const project = JSON.parse(payload) as CompiledProject;
    if (!project || !project.files || typeof project.files !== 'object' || Array.isArray(project.files)
      || Object.keys(project.files).some(file => !safeRelativeFile(file))
      || Object.values(project.files).some(value => typeof value !== 'string')
      || !Array.isArray(project.locales) || project.locales.some(value => typeof value !== 'string')
      || !project.groups || typeof project.groups !== 'object' || Array.isArray(project.groups)
      || Object.values(project.groups).some(value => !Array.isArray(value) || value.some(id => typeof id !== 'string'))
      || !Array.isArray(project.warnings) || project.warnings.some(value => !value || typeof value.code !== 'string' || typeof value.message !== 'string')) return;
    project.files = Object.assign(Object.create(null), project.files);
    project.groups = Object.assign(Object.create(null), project.groups);
    return project;
  } catch { return; }
}

export function encodeCache(project: CompiledProject, key: string): string | undefined {
  const payload = JSON.stringify(project);
  if (Buffer.byteLength(payload) > maximumBytes) return;
  const envelope = JSON.stringify({ version: 4, key, length: payload.length });
  const stored = envelope + '\n' + payload;
  return Buffer.byteLength(stored) <= maximumBytes ? stored : undefined;
}
