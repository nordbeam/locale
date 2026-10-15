import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * The on-disk plan format is deliberately independent of the CLI.  A plan is
 * a reviewable description of files and their source revision; applying one
 * never has to re-run a generator (which is what makes it safe to review a
 * plan and apply it later).
 */
export const PLAN_PROTOCOL_VERSION = 'nordbeam-plan/v1';
export const PLAN_TOOL_VERSION = 'nordbeam-locale/plan-apply/1';
/** Tool versions a plan may carry. The legacy value is accepted so plans written before the rename still apply. */
const acceptedToolVersions: ReadonlySet<unknown> = new Set([PLAN_TOOL_VERSION, 'nordbeam-i18n/plan-apply/1']);

/** JSON values accepted by operation metadata (named to avoid colliding with the event module's JsonValue). */
export type PlanJsonValue = null | boolean | number | string | PlanJsonValue[] | { [key: string]: PlanJsonValue };
export type FileContent = string | Uint8Array;

export interface FileChangeInput {
  /** Path relative to the plan root. Absolute and escaping paths are rejected. */
  path: string;
  content: FileContent;
}

export interface PlanInput {
  /** `rootDir` is the preferred name; `root` is accepted for integration APIs. */
  rootDir?: string;
  root?: string;
  changes: readonly FileChangeInput[];
  /** Stable, operation-specific metadata (for example command and options). */
  operation?: unknown;
  /** Alias for callers that call operation metadata `metadata`. */
  metadata?: unknown;
  protocolVersion?: string;
  toolVersion?: string;
}

export type FileKind = 'missing' | 'file' | 'directory' | 'symlink' | 'other';

/** Content and presence state captured during planning and checked at apply. */
export interface FileState {
  exists: boolean;
  kind: FileKind;
  size: number | null;
  sha256: string | null;
  /** Permission bits are part of the source state, but are not changed by apply. */
  mode: number | null;
}

export interface PlannedFileChange {
  path: string;
  before: FileState;
  after: FileState;
  /** UTF-8 text, or base64 bytes when `contentEncoding` is `base64`. */
  content: string;
  contentEncoding: 'utf8' | 'base64';
}

export interface FilePlan {
  protocolVersion: string;
  toolVersion: string;
  rootDir: string;
  /** Sorted, normalized operation inputs; this is safe to serialize as JSON. */
  operation: PlanJsonValue;
  /** Sorted relative paths. This is an explicit target allow-list. */
  affectedPaths: readonly string[];
  changes: readonly PlannedFileChange[];
  /** SHA-256 of all plan fields except this field, using stable JSON. */
  planHash: string;
}

export interface ApplyOptions {
  /** Defaults to the root captured in the plan. */
  rootDir?: string;
  /** Optional caller allow-list. It must exactly equal `affectedPaths`. */
  targetPaths?: readonly string[];
}

export interface PlanVerification {
  rootDir: string;
  affectedPaths: readonly string[];
  current: Readonly<Record<string, FileState>>;
}

export interface ApplyResult {
  planHash: string;
  /** `already-applied` means every target already held its planned content, so nothing was written. */
  status: 'applied' | 'already-applied';
  changed: readonly string[];
  rolledBack: false;
}

export type PlanErrorCode =
  | 'INVALID_PLAN'
  | 'INVALID_TARGET'
  | 'ROOT_MISMATCH'
  | 'STALE_PLAN'
  | 'MISSING_TARGET'
  | 'UNEXPECTED_TARGET'
  | 'TARGET_NOT_FILE'
  | 'APPLY_FAILED';

/** Structured errors make stale-plan failures easy for a CLI or editor to report. */
export class PlanApplyError extends Error {
  readonly code: PlanErrorCode;
  readonly paths: readonly string[];
  readonly rolledBack: boolean;

  constructor(code: PlanErrorCode, message: string, paths: readonly string[] = [], rolledBack = false) {
    super(message);
    this.name = 'PlanApplyError';
    this.code = code;
    this.paths = paths;
    this.rolledBack = rolledBack;
  }
}

const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

/** Canonical JSON used for both operation metadata and plan IDs. */
export function normalizeJson(value: unknown): PlanJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new PlanApplyError('INVALID_PLAN', 'Operation metadata contains a non-finite number.');
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (typeof value === 'object') {
    if (value instanceof Uint8Array || value instanceof Date) {
      throw new PlanApplyError('INVALID_PLAN', 'Operation metadata must contain JSON values only.');
    }
    const result: { [key: string]: PlanJsonValue } = {};
    for (const key of Object.keys(value as object).sort(compare)) result[key] = normalizeJson((value as Record<string, unknown>)[key]);
    return result;
  }
  throw new PlanApplyError('INVALID_PLAN', `Operation metadata contains unsupported value ${String(value)}.`);
}

export function stableStringify(value: PlanJsonValue): string {
  return JSON.stringify(value);
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export const hashContent = sha256;

function normalizedRoot(input: PlanInput): string {
  const root = input.rootDir ?? input.root ?? '.';
  if (typeof root !== 'string' || !root) throw new PlanApplyError('INVALID_PLAN', 'A non-empty rootDir is required.');
  return resolve(root);
}

/** Convert a user path to one stable, portable, root-relative representation. */
export function normalizeTargetPath(rootDir: string, inputPath: string): string {
  if (typeof inputPath !== 'string' || !inputPath || inputPath.includes('\0')) {
    throw new PlanApplyError('INVALID_TARGET', `Invalid target path ${JSON.stringify(inputPath)}.`);
  }
  // Accept paths emitted on another platform while rejecting absolute paths on
  // either platform. A backslash is a separator for plan purposes.
  const portable = inputPath.replaceAll('\\', '/');
  if (portable.startsWith('/') || /^[A-Za-z]:\//.test(portable)) {
    throw new PlanApplyError('INVALID_TARGET', `Target path must be relative: ${inputPath}.`, [inputPath]);
  }
  const native = portable.split('/').join(sep);
  const absolute = resolve(rootDir, native);
  const rel = relative(rootDir, absolute).split(sep).join('/');
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    throw new PlanApplyError('INVALID_TARGET', `Target path escapes the plan root: ${inputPath}.`, [inputPath]);
  }
  return rel;
}

function stateForMissing(): FileState {
  return { exists: false, kind: 'missing', size: null, sha256: null, mode: null };
}

async function fileState(file: string): Promise<FileState> {
  let info;
  try { info = await lstat(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return stateForMissing();
    throw error;
  }
  const mode = info.mode & 0o7777;
  if (info.isFile()) {
    const bytes = await readFile(file);
    return { exists: true, kind: 'file', size: bytes.byteLength, sha256: sha256(bytes), mode };
  }
  if (info.isDirectory()) return { exists: true, kind: 'directory', size: null, sha256: null, mode };
  if (info.isSymbolicLink()) return { exists: true, kind: 'symlink', size: null, sha256: null, mode };
  return { exists: true, kind: 'other', size: null, sha256: null, mode };
}

function sameState(left: FileState, right: FileState): boolean {
  return left.exists === right.exists && left.kind === right.kind && left.size === right.size
    && left.sha256 === right.sha256 && left.mode === right.mode;
}

function bytesForChange(change: PlannedFileChange): Uint8Array {
  if (change.contentEncoding === 'utf8') return Buffer.from(change.content, 'utf8');
  if (change.contentEncoding === 'base64') {
    const bytes = Buffer.from(change.content, 'base64');
    if (bytes.toString('base64').replace(/=+$/, '') !== change.content.replace(/=+$/, '')) {
      // Buffer silently ignores malformed base64. Round-trip validation keeps a
      // hand-edited plan from producing a different payload than its hash.
      throw new PlanApplyError('INVALID_PLAN', `Invalid base64 content for ${change.path}.`, [change.path]);
    }
    return bytes;
  }
  throw new PlanApplyError('INVALID_PLAN', `Unknown content encoding for ${change.path}.`, [change.path]);
}

function planPayload(plan: Omit<FilePlan, 'planHash'> | FilePlan): PlanJsonValue {
  return {
    protocolVersion: plan.protocolVersion,
    toolVersion: plan.toolVersion,
    rootDir: plan.rootDir,
    operation: plan.operation,
    affectedPaths: [...plan.affectedPaths],
    changes: plan.changes.map(change => ({
      path: change.path,
      before: change.before,
      after: change.after,
      content: change.content,
      contentEncoding: change.contentEncoding,
    })),
  } as unknown as PlanJsonValue;
}

export function calculatePlanHash(plan: Omit<FilePlan, 'planHash'> | FilePlan): string {
  return sha256(stableStringify(planPayload(plan)));
}

export const hashPlan = calculatePlanHash;

function assertUniqueSortedPaths(paths: readonly string[], code: PlanErrorCode): void {
  const sorted = [...paths].sort(compare);
  if (sorted.some((path, index) => path !== paths[index] || path === sorted[index - 1])) {
    throw new PlanApplyError(code, 'Plan targets must be sorted and unique.', paths);
  }
}

async function assertParentDirectory(rootDir: string, path: string): Promise<void> {
  const parts = dirname(path).split('/').filter(part => part && part !== '.');
  let directory = rootDir;
  for (const part of parts) {
    let info;
    try { info = await lstat(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new PlanApplyError('MISSING_TARGET', `Parent directory is missing for ${path}.`, [path]);
      }
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new PlanApplyError('UNEXPECTED_TARGET', `Parent of ${path} is not a regular directory.`, [path]);
    directory = resolve(directory, part);
  }
  let info;
  try { info = await lstat(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new PlanApplyError('MISSING_TARGET', `Parent directory is missing for ${path}.`, [path]);
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new PlanApplyError('UNEXPECTED_TARGET', `Parent of ${path} is not a regular directory.`, [path]);
}

/** Build a deterministic, fully source-bound plan without writing anything. */
export async function createPlan(input: PlanInput): Promise<FilePlan> {
  if (!input || !Array.isArray(input.changes)) throw new PlanApplyError('INVALID_PLAN', 'changes must be an array.');
  const rootDir = normalizedRoot(input);
  const protocolVersion = input.protocolVersion ?? PLAN_PROTOCOL_VERSION;
  const toolVersion = input.toolVersion ?? PLAN_TOOL_VERSION;
  if (typeof protocolVersion !== 'string' || !protocolVersion) throw new PlanApplyError('INVALID_PLAN', 'protocolVersion must be a non-empty string.');
  if (typeof toolVersion !== 'string' || !toolVersion) throw new PlanApplyError('INVALID_PLAN', 'toolVersion must be a non-empty string.');
  const operation = normalizeJson(input.operation !== undefined ? input.operation : input.metadata ?? {});
  const entries = input.changes.map(change => {
    if (!change || typeof change.path !== 'string') throw new PlanApplyError('INVALID_TARGET', 'Every change needs a path.');
    return { ...change, path: normalizeTargetPath(rootDir, change.path) };
  });
  entries.sort((left, right) => compare(left.path, right.path));
  for (let i = 1; i < entries.length; i++) if (entries[i - 1]!.path === entries[i]!.path) {
    throw new PlanApplyError('UNEXPECTED_TARGET', `Duplicate target ${entries[i]!.path}.`, [entries[i]!.path]);
  }
  const changes: PlannedFileChange[] = [];
  for (const entry of entries) {
    await assertParentDirectory(rootDir, entry.path);
    const before = await fileState(resolve(rootDir, entry.path));
    if (before.kind !== 'missing' && before.kind !== 'file') {
      throw new PlanApplyError('TARGET_NOT_FILE', `Target is not a regular file: ${entry.path}.`, [entry.path]);
    }
    if (typeof entry.content !== 'string' && !(entry.content instanceof Uint8Array)) {
      throw new PlanApplyError('INVALID_PLAN', `Content for ${entry.path} must be text or bytes.`, [entry.path]);
    }
    const bytes = typeof entry.content === 'string' ? Buffer.from(entry.content, 'utf8') : Buffer.from(entry.content);
    const contentEncoding = typeof entry.content === 'string' ? 'utf8' : 'base64';
    const content = contentEncoding === 'utf8' ? entry.content as string : bytes.toString('base64');
    const after: FileState = { exists: true, kind: 'file', size: bytes.byteLength, sha256: sha256(bytes), mode: before.mode };
    changes.push({ path: entry.path, before, after, content, contentEncoding });
  }
  const planWithoutHash = {
    protocolVersion, toolVersion, rootDir, operation,
    affectedPaths: changes.map(change => change.path), changes,
  } satisfies Omit<FilePlan, 'planHash'>;
  return { ...planWithoutHash, planHash: calculatePlanHash(planWithoutHash) };
}

function validatePlanShape(plan: FilePlan): void {
  if (!plan || typeof plan !== 'object') throw new PlanApplyError('INVALID_PLAN', 'Expected a plan object.');
  if (plan.protocolVersion !== PLAN_PROTOCOL_VERSION) throw new PlanApplyError('INVALID_PLAN', `Unsupported plan protocol ${plan.protocolVersion}.`);
  if (!acceptedToolVersions.has(plan.toolVersion)) throw new PlanApplyError('INVALID_PLAN', `Unsupported plan tool version ${String(plan.toolVersion)}.`);
  if (typeof plan.rootDir !== 'string' || !isAbsolute(plan.rootDir)) throw new PlanApplyError('INVALID_PLAN', 'Plan rootDir must be absolute.');
  if (!Array.isArray(plan.affectedPaths) || !Array.isArray(plan.changes)) throw new PlanApplyError('INVALID_PLAN', 'Plan targets are missing.');
  assertUniqueSortedPaths(plan.affectedPaths, 'INVALID_PLAN');
  if (plan.affectedPaths.some(path => typeof path !== 'string')
    || plan.changes.some(change => !change || typeof change !== 'object' || typeof change.path !== 'string')
    || plan.affectedPaths.length !== plan.changes.length
    || plan.changes.some((change, index) => change.path !== plan.affectedPaths[index])) {
    throw new PlanApplyError('UNEXPECTED_TARGET', 'affectedPaths does not exactly match changes.');
  }
  if (calculatePlanHash(plan) !== plan.planHash) throw new PlanApplyError('INVALID_PLAN', 'Plan hash does not match its contents.');
  for (const change of plan.changes) {
    if (normalizeTargetPath(plan.rootDir, change.path) !== change.path) {
      throw new PlanApplyError('INVALID_TARGET', `Target path is not normalized: ${change.path}.`, [change.path]);
    }
    if (!change.before || !change.after || typeof change.content !== 'string') {
      throw new PlanApplyError('INVALID_PLAN', `Malformed change for ${change.path}.`, [change.path]);
    }
    if (change.before.kind !== 'missing' && change.before.kind !== 'file') throw new PlanApplyError('TARGET_NOT_FILE', `Plan target is not a regular file: ${change.path}.`, [change.path]);
    const bytes = bytesForChange(change);
    if (change.after.kind !== 'file' || change.after.exists !== true || change.after.size !== bytes.byteLength || change.after.sha256 !== sha256(bytes)) {
      throw new PlanApplyError('INVALID_PLAN', `After state does not match content for ${change.path}.`, [change.path]);
    }
  }
}

interface PlanInspection extends PlanVerification {
  failures: Array<{ code: PlanErrorCode; path: string; message: string }>;
  /** Paths whose current content already equals the planned after-content. */
  plannedContent: readonly string[];
}

/** A file already holds the planned bytes. Mode is not compared: apply never changes it. */
function hasPlannedContent(change: PlannedFileChange, actual: FileState): boolean {
  return actual.kind === 'file' && actual.size === change.after.size && actual.sha256 === change.after.sha256;
}

async function inspectPlan(plan: FilePlan, options: ApplyOptions): Promise<PlanInspection> {
  validatePlanShape(plan);
  const rootDir = resolve(options.rootDir ?? plan.rootDir);
  if (rootDir !== plan.rootDir) throw new PlanApplyError('ROOT_MISMATCH', 'Apply root differs from the root captured by the plan.');
  const expectedPaths = [...plan.affectedPaths];
  if (options.targetPaths) {
    const targets = options.targetPaths.map(path => normalizeTargetPath(rootDir, path)).sort(compare);
    if (targets.length !== expectedPaths.length || targets.some((path, index) => path !== expectedPaths[index])) {
      throw new PlanApplyError('UNEXPECTED_TARGET', 'The requested target set differs from the plan.', targets);
    }
  }
  const current: Record<string, FileState> = {};
  const failures: Array<{ code: PlanErrorCode; path: string; message: string }> = [];
  const plannedContent: string[] = [];
  for (const change of plan.changes) {
    await assertParentDirectory(rootDir, change.path);
    const actual = await fileState(resolve(rootDir, change.path));
    current[change.path] = actual;
    const atPlannedContent = hasPlannedContent(change, actual);
    if (atPlannedContent) plannedContent.push(change.path);
    const atBefore = change.before.kind === 'missing' ? actual.kind === 'missing' : sameState(change.before, actual);
    if (atBefore) continue;
    if (atPlannedContent) {
      failures.push({ code: 'STALE_PLAN', path: change.path, message: `Target already has planned content: ${change.path}.` });
    } else if (change.before.kind === 'missing') {
      failures.push({ code: 'UNEXPECTED_TARGET', path: change.path, message: `Target appeared after planning: ${change.path}.` });
    } else if (actual.kind === 'missing') {
      failures.push({ code: 'MISSING_TARGET', path: change.path, message: `Planned target is missing: ${change.path}.` });
    } else {
      failures.push({ code: 'STALE_PLAN', path: change.path, message: `Target changed after planning: ${change.path}.` });
    }
  }
  return { rootDir, affectedPaths: expectedPaths, current, failures, plannedContent };
}

/** Throw the structured error for an inspection that found stale or missing targets. */
function assertPlanInspection(plan: FilePlan, inspection: PlanInspection): void {
  if (!inspection.failures.length) return;
  const code = inspection.failures.some(failure => failure.code === 'MISSING_TARGET') ? 'MISSING_TARGET'
    : inspection.failures.some(failure => failure.code === 'UNEXPECTED_TARGET') ? 'UNEXPECTED_TARGET' : 'STALE_PLAN';
  const planned = inspection.plannedContent;
  const summary = !planned.length ? ''
    : planned.length === plan.changes.length ? 'Plan is already applied.'
    : `Plan is partially applied; already at planned content: ${planned.join(', ')}.`;
  const message = [summary, ...inspection.failures.map(failure => failure.message)].filter(Boolean).join(' ');
  throw new PlanApplyError(code, message, inspection.failures.map(failure => failure.path));
}

/** Validate the complete target set and source hashes. This method never writes. */
export async function verifyPlan(plan: FilePlan, options: ApplyOptions = {}): Promise<PlanVerification> {
  const inspection = await inspectPlan(plan, options);
  assertPlanInspection(plan, inspection);
  return { rootDir: inspection.rootDir, affectedPaths: inspection.affectedPaths, current: inspection.current };
}

interface StagedFile { destination: string; temporary: string; backup: string; before: FileState; after: FileState; installed: boolean; backedUp: boolean; }

/**
 * Apply a plan after a complete preflight. Files are staged first, then
 * replaced with same-directory renames; on a commit error the prior files are
 * restored in reverse order. Multi-file replacement cannot be made globally
 * atomic by POSIX, but this closes the partial-write window in normal errors.
 */
export async function applyPlan(plan: FilePlan, options: ApplyOptions = {}): Promise<ApplyResult> {
  const inspection = await inspectPlan(plan, options);
  if (plan.changes.length && inspection.plannedContent.length === plan.changes.length) {
    return { planHash: plan.planHash, status: 'already-applied', changed: [], rolledBack: false };
  }
  assertPlanInspection(plan, inspection);
  const verification = { rootDir: inspection.rootDir, affectedPaths: inspection.affectedPaths, current: inspection.current };
  const staged: StagedFile[] = [];
  let preserveBackups = false;
  try {
    for (const change of plan.changes) {
      await assertParentDirectory(verification.rootDir, change.path);
      const destination = resolve(verification.rootDir, change.path);
      const temporary = `${destination}.nordbeam-${randomUUID()}.tmp`;
      const backup = `${destination}.nordbeam-${randomUUID()}.bak`;
      const bytes = bytesForChange(change);
      await writeFile(temporary, bytes, { flag: 'wx', mode: change.before.mode ?? 0o666 });
      if (change.before.mode !== null) await chmod(temporary, change.before.mode);
      staged.push({ destination, temporary, backup, before: change.before, after: change.after, installed: false, backedUp: false });
    }
    // Staging can take meaningful time for large generated files. Re-run the
    // complete source preflight immediately before the first destination move.
    await verifyPlan(plan, options);
    for (const item of staged) {
      if (item.before.exists) { await rename(item.destination, item.backup); item.backedUp = true; }
      await rename(item.temporary, item.destination);
      item.installed = true;
    }
    return { planHash: plan.planHash, status: 'applied', changed: plan.affectedPaths, rolledBack: false };
  } catch (error) {
    let rollbackError: unknown;
    const rollbackPaths: string[] = [];
    for (const item of [...staged].reverse()) {
      try {
        if (item.installed) {
          const current = await fileState(item.destination);
          if (sameState(current, item.after)) await unlink(item.destination);
        }
        if (item.backedUp) {
          await rename(item.backup, item.destination);
          rollbackPaths.push(item.destination);
        }
      } catch (rollbackFailure) {
        rollbackError ??= rollbackFailure;
        // The backup is intentionally retained when restoration failed. It is
        // the only recoverable copy of the prior source content.
        if (item.backedUp) { preserveBackups = true; rollbackPaths.push(item.backup); }
      }
    }
    const detail = rollbackError ? ` Rollback also failed: ${(rollbackError as Error).message}.` : '';
    if (error instanceof PlanApplyError) throw error;
    if (rollbackError) {
      throw new PlanApplyError('APPLY_FAILED', `${(error as Error).message}. ${detail.trim()}`, rollbackPaths, false);
    }
    throw new PlanApplyError('APPLY_FAILED', `${(error as Error).message}.${detail}`, plan.affectedPaths, true);
  } finally {
    for (const item of staged) {
      await unlink(item.temporary).catch(() => undefined);
      if (!preserveBackups) await unlink(item.backup).catch(() => undefined);
    }
  }
}

/** Discoverable aliases for integrations that call the operation a file plan. */
export const planFileChanges = createPlan;
export const applyFilePlan = applyPlan;

export function serializePlan(plan: FilePlan): string {
  validatePlanShape(plan);
  return JSON.stringify(plan, null, 2) + '\n';
}

export function parsePlan(serialized: string): FilePlan {
  let value: unknown;
  try { value = JSON.parse(serialized); }
  catch (error) { throw new PlanApplyError('INVALID_PLAN', `Invalid plan JSON: ${(error as Error).message}.`); }
  validatePlanShape(value as FilePlan);
  return value as FilePlan;
}
