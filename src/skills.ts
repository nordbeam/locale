import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, usageError } from './error-codes.js';

/** Agent skills that ship inside the package (`skills/<name>/SKILL.md`), version-matched to the CLI. */
export type SkillTarget = 'claude' | 'agents';
export type SkillAction = 'created' | 'updated' | 'unchanged' | 'skipped';
export type SkillFileAction = SkillAction | 'removed';

/** Project directories that agents read: Claude Code uses `.claude/skills`; Codex, Cursor, Copilot, Gemini CLI, OpenCode and other
 * Agent Skills clients read the cross-client `.agents/skills` convention. */
export const skillTargetDirectories: Readonly<Record<SkillTarget, string>> = { claude: '.claude/skills', agents: '.agents/skills' };
export const skillTargets = Object.keys(skillTargetDirectories) as SkillTarget[];

/** Ownership record written beside an installed skill. Only files whose current content hashes to the recorded value are ever replaced. */
export const skillManifestName = '.nordbeam-skill.json';

export interface SkillFileResult { file: string; action: SkillFileAction; reason?: string }
export interface SkillInstallEntry {
  skill: string;
  target: SkillTarget;
  directory: string;
  action: SkillAction;
  counts: Record<SkillFileAction, number>;
  files: SkillFileResult[];
  reason?: string;
}
export interface SkillInstallResult { dryRun: boolean; version: string; skills: SkillInstallEntry[] }

interface SkillManifest { package: string; version: string; skill: string; files: Record<string, string> }

const hash = (content: Uint8Array | string): string => createHash('sha256').update(content).digest('hex');

/** The package's own `skills` directory: `dist/skills.js` sits next to it in a published package and in a checkout. */
export function bundledSkillsDirectory(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'skills');
}

async function exists(path: string): Promise<'file' | 'directory' | 'symlink' | 'other' | undefined> {
  try {
    const stat = await lstat(path);
    return stat.isSymbolicLink() ? 'symlink' : stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Names of the skills in the package, in a stable order. */
export async function listBundledSkills(source = bundledSkillsDirectory()): Promise<string[]> {
  let entries;
  try { entries = await readdir(source, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new CliError('FILE_NOT_FOUND', `Bundled skills not found at ${source}. Reinstall @nordbeam/locale.`, { path: source });
    throw error;
  }
  const names: string[] = [];
  for (const entry of entries) if (entry.isDirectory() && await exists(join(source, entry.name, 'SKILL.md')) === 'file') names.push(entry.name);
  return names.sort();
}

async function skillFiles(directory: string, prefix = ''): Promise<string[]> {
  const output: string[] = [];
  for (const entry of (await readdir(join(directory, prefix), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
    if (entry.name === '.DS_Store' || entry.name === skillManifestName) continue;
    if (prefix === '' && entry.name === 'evals') continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) output.push(...await skillFiles(directory, path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

async function readManifest(directory: string): Promise<SkillManifest | undefined> {
  try {
    const value = JSON.parse(await readFile(join(directory, skillManifestName), 'utf8')) as Partial<SkillManifest>;
    if (value && typeof value === 'object' && value.files && typeof value.files === 'object') return value as SkillManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  return undefined;
}

const emptyCounts = (): Record<SkillFileAction, number> => ({ created: 0, updated: 0, unchanged: 0, skipped: 0, removed: 0 });

/** Install one skill into one target directory without clobbering local edits. */
async function installOne(root: string, source: string, skill: string, target: SkillTarget, version: string, dryRun: boolean): Promise<SkillInstallEntry> {
  const directory = resolve(root, skillTargetDirectories[target], skill);
  const entry: SkillInstallEntry = { skill, target, directory, action: 'skipped', counts: emptyCounts(), files: [] };
  const kind = await exists(directory);
  if (kind === 'symlink' || (kind !== undefined && kind !== 'directory')) {
    entry.reason = kind === 'symlink' ? 'The skill directory is a symbolic link, so another installer manages it.' : 'A file occupies the skill directory path.';
    return entry;
  }
  const previous = kind === 'directory' ? await readManifest(directory) : undefined;
  const recorded = previous?.files ?? {};
  const next: Record<string, string> = {};
  const shipped = await skillFiles(join(source, skill));
  const record = (file: string, action: SkillFileAction, reason?: string): void => {
    entry.files.push({ file: join(directory, ...file.split('/')), action, ...(reason ? { reason } : {}) });
    entry.counts[action]++;
  };
  for (const file of shipped) {
    const content = await readFile(join(source, skill, ...file.split('/')));
    const digest = hash(content);
    const path = join(directory, ...file.split('/'));
    const state = await exists(path);
    if (state === undefined) {
      if (!dryRun) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content, { flag: 'wx' }); }
      next[file] = digest; record(file, 'created');
    } else if (state !== 'file') {
      if (recorded[file] !== undefined) next[file] = recorded[file]!;
      record(file, 'skipped', state === 'symlink' ? 'A symbolic link is not replaced.' : 'A directory or special file is in the way.');
    } else {
      const current = hash(await readFile(path));
      if (current === digest) { next[file] = digest; record(file, 'unchanged'); }
      else if (recorded[file] !== undefined && current === recorded[file]) {
        if (!dryRun) await writeFile(path, content);
        next[file] = digest; record(file, 'updated');
      } else {
        if (recorded[file] !== undefined) next[file] = recorded[file]!;
        record(file, 'skipped', recorded[file] === undefined ? 'The file exists and was not installed by nordbeam-locale.' : 'The file was edited after installation.');
      }
    }
  }
  // A file an older version shipped and this one dropped is removed only when it is still exactly what was installed.
  for (const [file, digest] of Object.entries(recorded)) {
    if (shipped.includes(file) || file.split('/').includes('..')) continue;
    const path = join(directory, ...file.split('/'));
    if (await exists(path) !== 'file') continue;
    if (hash(await readFile(path)) === digest) {
      if (!dryRun) await rm(path);
      record(file, 'removed');
    } else {
      next[file] = digest;
      record(file, 'skipped', 'The file is no longer shipped but was edited after installation.');
    }
  }
  const { created, updated, unchanged, skipped, removed } = entry.counts;
  entry.action = created + updated + unchanged + removed === 0 ? 'skipped'
    : created === shipped.length ? 'created'
    : created + updated + removed > 0 ? 'updated' : 'unchanged';
  if (skipped > 0 && entry.action === 'skipped') entry.reason = 'Every file already exists with local content.';
  if (!dryRun && Object.keys(next).length) {
    const manifest: SkillManifest = { package: '@nordbeam/locale', version, skill, files: next };
    const text = JSON.stringify(manifest, null, 2) + '\n';
    const manifestPath = join(directory, skillManifestName);
    const current = await exists(manifestPath) === 'file' ? await readFile(manifestPath, 'utf8') : undefined;
    if (current !== text) { await mkdir(directory, { recursive: true }); await writeFile(manifestPath, text); }
  }
  return entry;
}

export interface InstallSkillsOptions {
  targets?: readonly SkillTarget[];
  skills?: readonly string[];
  dryRun?: boolean;
  version: string;
  /** Override the package's skills directory (tests). */
  source?: string;
}

/** Copy the bundled skills into the project. Existing files are never replaced unless they are byte-identical to what an earlier
 * install recorded; everything else is reported as skipped. */
export async function installSkills(root: string, options: InstallSkillsOptions): Promise<SkillInstallResult> {
  const source = options.source ?? bundledSkillsDirectory();
  const available = await listBundledSkills(source);
  const wanted = options.skills?.length ? [...new Set(options.skills)] : available;
  for (const name of wanted) {
    if (!available.includes(name)) throw usageError(`Unknown skill ${JSON.stringify(name)}. Bundled skills: ${available.join(', ')}.`, { option: '--skill', value: name, validValues: available });
  }
  const targets = options.targets?.length ? options.targets : skillTargets;
  const skills: SkillInstallEntry[] = [];
  for (const target of targets) for (const skill of wanted) skills.push(await installOne(root, source, skill, target, options.version, options.dryRun === true));
  return { dryRun: options.dryRun === true, version: options.version, skills };
}
