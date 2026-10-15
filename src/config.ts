import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { GenerateOptions } from './project.js';
import { validateKeyPolicy } from './key-policy.js';
export { matchesKeyPattern, patternsOverlap, resolveKeyPolicy, validateKeyPatterns, validateKeyPolicy } from './key-policy.js';
export type { KeyPattern, KeyPolicyDecision, KeyPolicyOptions, ResolvedKeyPolicy } from './key-policy.js';

/** The canonical project configuration filename. */
export const configName = 'nordbeam-locale.config.json';
/** Compatibility filename used by the previous @nordbeam/i18n release. */
export const legacyConfigName = 'nordbeam-i18n.config.json';
/** Compatibility filename used by the original fasti18n release. */
export const historicalConfigName = 'fasti18n.config.json';

/** Option keys that `init` persists to the config file. */
export const configKeys = [
  'baseLocale', 'catalogs', 'notes', 'outDir', 'missing',
  'formats', 'timeZone', 'scopes', 'artifacts', 'includeSources', 'shareLiterals', 'cache', 'persistentCache',
  'selectionFallback', 'shareMessages', 'preloadManifest', 'staticLocale', 'lockedKeys', 'ignoredKeys',
] as const;
/** Accepted but not persisted: the editor schema reference and the ignored development flag. */
const acceptedConfigKeys = new Set<string>([...configKeys, '$schema', 'development']);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Validate the option shape before filesystem work or compilation. This is
 * intentionally dependency-free and mirrors configSchema so editor errors and
 * CLI errors agree even when a JSON Schema validator is not installed. */
export function validateConfig(value: unknown, file = configName): asserts value is Partial<GenerateOptions> {
  if (!isRecord(value)) throw new Error(`${file}: expected a JSON configuration object.`);
  for (const key of Object.keys(value)) if (!acceptedConfigKeys.has(key)) {
    throw new Error(`${file}: unknown option ${JSON.stringify(key)}. Check the spelling or remove it.`);
  }
  const stringKeys = ['baseLocale', 'catalogs', 'notes', 'outDir', 'timeZone'] as const;
  for (const key of stringKeys) if (value[key] !== undefined && (typeof value[key] !== 'string' || !value[key])) {
    throw new Error(`${file}: ${key} must be a nonempty string.`);
  }
  if (value.$schema !== undefined && (typeof value.$schema !== 'string' || !value.$schema)) throw new Error(`${file}: $schema must be a nonempty string.`);
  if (value.missing !== undefined && value.missing !== 'fallback' && value.missing !== 'error') throw new Error(`${file}: missing must be "fallback" or "error".`);
  if (value.artifacts !== undefined && value.artifacts !== 'typed' && value.artifacts !== 'runtime' && value.artifacts !== 'loader' && value.artifacts !== 'loader-typed') throw new Error(`${file}: artifacts must be "typed", "runtime", "loader" or "loader-typed".`);
  if (value.includeSources !== undefined && value.includeSources !== 'rich' && value.includeSources !== 'all'
    && (!Array.isArray(value.includeSources) || value.includeSources.some(id => typeof id !== 'string' || !id))) {
    throw new Error(`${file}: includeSources must be "rich", "all" or an array of message IDs.`);
  }
  if (value.shareLiterals !== undefined && typeof value.shareLiterals !== 'boolean') throw new Error(`${file}: shareLiterals must be a boolean.`);
  if (value.development !== undefined && typeof value.development !== 'boolean') throw new Error(`${file}: development must be a boolean.`);
  if (value.selectionFallback !== undefined && !['warn', 'error', 'off'].includes(value.selectionFallback as string)) throw new Error(`${file}: selectionFallback must be "warn", "error" or "off".`);
  if (value.shareMessages !== undefined && typeof value.shareMessages !== 'boolean') throw new Error(`${file}: shareMessages must be a boolean.`);
  if (value.preloadManifest !== undefined && typeof value.preloadManifest !== 'boolean') throw new Error(`${file}: preloadManifest must be a boolean.`);
  if (value.staticLocale !== undefined && (typeof value.staticLocale !== 'string' || !value.staticLocale)) throw new Error(`${file}: staticLocale must be a nonempty string.`);
  validateKeyPolicy(value as Partial<GenerateOptions>, file);
  if (value.persistentCache !== undefined && typeof value.persistentCache !== 'boolean' && (typeof value.persistentCache !== 'string' || !value.persistentCache)) {
    throw new Error(`${file}: persistentCache must be a boolean or nonempty string.`);
  }
  if (value.scopes !== undefined) {
    if (!isRecord(value.scopes)) throw new Error(`${file}: scopes must be an object of scope names to message ID arrays.`);
    for (const [scope, patterns] of Object.entries(value.scopes)) {
      if (!Array.isArray(patterns) || !patterns.length || patterns.some(pattern => typeof pattern !== 'string' || !pattern)) {
        throw new Error(`${file}: scopes.${scope} must be a nonempty array of message IDs or prefix patterns.`);
      }
    }
  }
  if (value.cache !== undefined) {
    if (!isRecord(value.cache)) throw new Error(`${file}: cache must be an object.`);
    const bytes = value.cache.maxMessageCacheBytes;
    if (bytes !== undefined && (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0)) {
      throw new Error(`${file}: cache.maxMessageCacheBytes must be a finite nonnegative number.`);
    }
    for (const key of Object.keys(value.cache)) if (key !== 'maxMessageCacheBytes') throw new Error(`${file}: unknown cache option ${JSON.stringify(key)}.`);
  }
  if (value.formats !== undefined) {
    if (!isRecord(value.formats)) throw new Error(`${file}: formats must be an object.`);
    for (const kind of ['number', 'date', 'time']) {
      const formats = value.formats[kind];
      if (formats !== undefined) {
        if (!isRecord(formats)) throw new Error(`${file}: formats.${kind} must be an object.`);
        for (const [name, options] of Object.entries(formats)) if (!isRecord(options)) throw new Error(`${file}: formats.${kind}.${name} must be an object.`);
      }
    }
    for (const key of Object.keys(value.formats)) if (!['number', 'date', 'time'].includes(key)) throw new Error(`${file}: unknown formats group ${JSON.stringify(key)}.`);
  }
}

const exists = async (file: string): Promise<boolean> => {
  try { await lstat(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
};

/** Non-fatal config notices. `development` is accepted for editor compatibility
 * but never selects output: the CLI derives mode from NODE_ENV and its flags. */
export function configWarnings(value: Partial<GenerateOptions>, file = configName): Array<{ code: string; message: string }> {
  if (value.development === undefined) return [];
  return [{ code: 'CONFIG_DEVELOPMENT_IGNORED', message: `${file}: development is ignored. Output mode comes from NODE_ENV, or from the --development and --production flags.` }];
}

/** Find the product config, accepting exactly one bounded compatibility filename. */
export async function discoverConfig(root: string): Promise<string> {
  const candidates = [configName, legacyConfigName, historicalConfigName].map(name => resolve(root, name));
  const present = (await Promise.all(candidates.map(exists))).flatMap((found, index) => found ? [candidates[index]!] : []);
  if (present.length > 1) throw new Error(`Multiple Nordbeam Locale config files exist: ${present.map(file => file.slice(root.length + 1)).join(', ')}. Keep only ${configName}.`);
  return present[0] ?? candidates[0]!;
}

export async function readConfig(file: string, required = false): Promise<Partial<GenerateOptions> | undefined> {
  let text: string;
  try { text = await readFile(file, 'utf8'); }
  catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  let value: Partial<GenerateOptions>;
  try { value = JSON.parse(text) as Partial<GenerateOptions>; }
  catch (error) { throw new Error(`${file}: invalid JSON: ${(error as Error).message}`); }
  validateConfig(value, file);
  return value;
}
