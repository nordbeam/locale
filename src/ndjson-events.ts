/**
 * Versioned, stdout-safe events for long-running Nordbeam operations.
 *
 * The writer is intentionally the only piece that knows about a destination:
 * reserve stdout for NDJSON and send human-readable logs to stderr. The first
 * record written by a writer is always the `version` record.
 */
import { CompileError, type Diagnostic } from './diagnostics.js';

export const NORDBEAM_EVENT_PROTOCOL = 'nordbeam.i18n';
export const NORDBEAM_EVENT_VERSION = 1 as const;
export const EVENT_PROTOCOL = NORDBEAM_EVENT_PROTOCOL;
export const EVENT_VERSION = NORDBEAM_EVENT_VERSION;

export type EventType = 'version' | 'progress' | 'diagnostic' | 'change' | 'final';
export const EVENT_TYPES = ['version', 'progress', 'diagnostic', 'change', 'final'] as const;
export type DiagnosticSeverity = 'info' | 'warning' | 'error';
export type ChangeAction = 'add' | 'update' | 'remove';
export type FinalStatus = 'succeeded' | 'failed' | 'cancelled';

/** JSON values allowed in event payloads. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface EventContext {
  /** Stable identifier for the long-running invocation. */
  operationId: string;
  /** Optional RFC 3339 timestamp supplied by the caller. */
  timestamp?: string;
  /** Optional monotonic sequence number supplied by the caller. */
  sequence?: number;
}

export interface VersionEvent {
  readonly version: typeof NORDBEAM_EVENT_VERSION;
  readonly type: 'version';
  readonly protocol: string;
  readonly events: readonly ['progress', 'diagnostic', 'change', 'final'];
}
export interface ProgressEvent extends EventContext {
  readonly version: typeof NORDBEAM_EVENT_VERSION;
  readonly type: 'progress';
  readonly phase?: string;
  readonly completed: number;
  readonly total?: number;
  readonly message?: string;
  readonly details?: JsonValue;
}
export interface DiagnosticEvent extends EventContext {
  readonly version: typeof NORDBEAM_EVENT_VERSION;
  readonly type: 'diagnostic';
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly code?: string;
  /** Absolute source path. Omitted when a project root is given, because `file` then carries the project-relative path. */
  readonly path?: string;
  /** Source path relative to the project root when the root is known. */
  readonly file?: string;
  /** One-based line: the source file line when `file` is set, otherwise the ICU message line. */
  readonly line?: number;
  /** One-based column, with the same source as `line`. */
  readonly column?: number;
  readonly messageId?: string;
  readonly locale?: string;
  readonly hint?: string;
  readonly details?: JsonValue;
}
export interface ChangeEvent extends EventContext {
  readonly version: typeof NORDBEAM_EVENT_VERSION;
  readonly type: 'change';
  readonly action: ChangeAction;
  readonly key?: string;
  readonly locale?: string;
  readonly before?: JsonValue;
  readonly after?: JsonValue;
}
export interface FinalEvent extends EventContext {
  readonly version: typeof NORDBEAM_EVENT_VERSION;
  readonly type: 'final';
  readonly status: FinalStatus;
  readonly summary?: string;
  readonly result?: JsonValue;
  readonly error?: { readonly code?: string; readonly message: string };
}
export type NordbeamEvent = VersionEvent | ProgressEvent | DiagnosticEvent | ChangeEvent | FinalEvent;

type ContextInput = EventContext;
const compact = <T extends Record<string, unknown>>(value: T): Partial<T> =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;

function validateContext(input: ContextInput): EventContext {
  if (!input || typeof input !== 'object' || typeof input.operationId !== 'string' || !input.operationId) {
    throw new TypeError('an event operationId must be a non-empty string');
  }
  if (input.timestamp !== undefined && typeof input.timestamp !== 'string') throw new TypeError('event timestamp must be a string');
  if (input.sequence !== undefined && (!Number.isSafeInteger(input.sequence) || input.sequence < 0)) {
    throw new TypeError('event sequence must be a non-negative safe integer');
  }
  return compact({ operationId: input.operationId, timestamp: input.timestamp, sequence: input.sequence }) as EventContext;
}

export function versionEvent(protocol = NORDBEAM_EVENT_PROTOCOL): VersionEvent {
  if (typeof protocol !== 'string' || !protocol) throw new TypeError('event protocol must be a non-empty string');
  return { version: NORDBEAM_EVENT_VERSION, type: 'version', protocol, events: ['progress', 'diagnostic', 'change', 'final'] };
}

export interface ProgressEventInput extends ContextInput { phase?: string; completed: number; total?: number; message?: string; details?: JsonValue }
export function progressEvent(input: ProgressEventInput): ProgressEvent {
  if (!input || typeof input !== 'object') throw new TypeError('progress event input is required');
  if (!Number.isFinite(input.completed) || input.completed < 0) throw new TypeError('progress completed must be a non-negative number');
  if (input.total !== undefined && (!Number.isFinite(input.total) || input.total < 0)) throw new TypeError('progress total must be a non-negative number');
  if (input.total !== undefined && input.completed > input.total) throw new RangeError('progress completed cannot exceed total');
  return { version: NORDBEAM_EVENT_VERSION, type: 'progress', ...validateContext(input), ...compact({ phase: input.phase, completed: input.completed, total: input.total, message: input.message, details: input.details }) } as ProgressEvent;
}

export interface DiagnosticEventInput extends ContextInput {
  severity?: DiagnosticSeverity; message: string; code?: string; path?: string; file?: string;
  line?: number; column?: number; messageId?: string; locale?: string; hint?: string; details?: JsonValue;
}
export function diagnosticEvent(input: DiagnosticEventInput): DiagnosticEvent {
  if (!input || typeof input !== 'object') throw new TypeError('diagnostic event input is required');
  if (typeof input.message !== 'string' || !input.message) throw new TypeError('diagnostic message must be a non-empty string');
  const severity = input.severity ?? 'info';
  if (!['info', 'warning', 'error'].includes(severity)) throw new TypeError('diagnostic severity must be info, warning, or error');
  for (const key of ['line', 'column'] as const) {
    if (input[key] !== undefined && (!Number.isSafeInteger(input[key]) || input[key]! < 1)) throw new TypeError(`diagnostic ${key} must be a positive integer`);
  }
  return { version: NORDBEAM_EVENT_VERSION, type: 'diagnostic', ...validateContext(input), ...compact({ severity, message: input.message, code: input.code, path: input.path, file: input.file, line: input.line, column: input.column, messageId: input.messageId, locale: input.locale, hint: input.hint, details: input.details }) } as DiagnosticEvent;
}

/** The fields of a compiler `Diagnostic` that a diagnostic event carries. */
export type DiagnosticLike = Pick<Diagnostic, 'code' | 'message' | 'file' | 'line' | 'column' | 'location' | 'messageId' | 'locale' | 'hint'>;
export interface DiagnosticEventFromOptions extends ContextInput { severity?: DiagnosticSeverity; root?: string; details?: JsonValue }
/**
 * Build a diagnostic event straight from a compiler diagnostic, so callers do
 * not have to copy location fields by hand. `root` makes `file` project-relative.
 */
export function diagnosticEventFrom(diagnostic: DiagnosticLike, options: DiagnosticEventFromOptions): DiagnosticEvent {
  const { file, location } = diagnostic;
  // Mirror renderDiagnostic: a file-based diagnostic is positioned in the file,
  // anything else in its ICU message.
  const position = file === undefined ? { line: diagnostic.line, column: diagnostic.column } : location ?? {};
  return diagnosticEvent({
    operationId: options.operationId,
    timestamp: options.timestamp,
    sequence: options.sequence,
    severity: options.severity,
    message: diagnostic.message,
    code: diagnostic.code,
    // With a root, `file` is the project-relative path; the absolute one would only repeat it.
    path: options.root === undefined ? file : undefined,
    file: file === undefined ? undefined : projectRelative(file, options.root),
    line: position.line,
    column: position.column,
    messageId: diagnostic.messageId,
    locale: diagnostic.locale,
    hint: diagnostic.hint,
    details: options.details,
  });
}
// Plain string handling keeps this entry free of Node built-ins.
function projectRelative(file: string, root: string | undefined): string {
  if (!root) return file;
  const base = `${root.replaceAll('\\', '/').replace(/\/+$/, '')}/`;
  const portable = file.replaceAll('\\', '/');
  return portable.startsWith(base) ? portable.slice(base.length) : file;
}

export interface ChangeEventInput extends ContextInput { action: ChangeAction; key?: string; locale?: string; before?: JsonValue; after?: JsonValue }
export function changeEvent(input: ChangeEventInput): ChangeEvent {
  if (!input || typeof input !== 'object') throw new TypeError('change event input is required');
  if (!['add', 'update', 'remove'].includes(input.action)) throw new TypeError('change action must be add, update, or remove');
  return { version: NORDBEAM_EVENT_VERSION, type: 'change', ...validateContext(input), ...compact({ action: input.action, key: input.key, locale: input.locale, before: input.before, after: input.after }) } as ChangeEvent;
}

export interface FinalEventInput extends ContextInput { status: FinalStatus; summary?: string; result?: JsonValue; error?: { code?: string; message: string } }
export function finalEvent(input: FinalEventInput): FinalEvent {
  if (!input || typeof input !== 'object') throw new TypeError('final event input is required');
  if (!['succeeded', 'failed', 'cancelled'].includes(input.status)) throw new TypeError('final status must be succeeded, failed, or cancelled');
  if (input.error !== undefined && (typeof input.error.message !== 'string' || !input.error.message)) throw new TypeError('final error message must be a non-empty string');
  const error = input.error instanceof CompileError ? finalErrorFrom(input.error) : input.error;
  return { version: NORDBEAM_EVENT_VERSION, type: 'final', ...validateContext(input), ...compact({ status: input.status, summary: input.summary, result: input.result, error }) } as FinalEvent;
}

/**
 * Error payload for a `final` event. A CompileError keeps the code of its first
 * diagnostic (for example an ICU error code) instead of a generic one.
 */
export function finalErrorFrom(error: unknown, fallbackCode?: string): { code?: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof CompileError ? error.diagnostics[0]?.code ?? fallbackCode : fallbackCode;
  return compact({ code, message }) as { code?: string; message: string };
}

/** Map an operation callback discriminator to its typed event constructor. */
export function createEvent(type: 'version', input?: string): VersionEvent;
export function createEvent(type: 'progress', input: ProgressEventInput): ProgressEvent;
export function createEvent(type: 'diagnostic', input: DiagnosticEventInput): DiagnosticEvent;
export function createEvent(type: 'change', input: ChangeEventInput): ChangeEvent;
export function createEvent(type: 'final', input: FinalEventInput): FinalEvent;
export function createEvent(type: EventType, input?: unknown): NordbeamEvent {
  switch (type) {
    case 'version': return versionEvent(input as string | undefined);
    case 'progress': return progressEvent(input as ProgressEventInput);
    case 'diagnostic': return diagnosticEvent(input as DiagnosticEventInput);
    case 'change': return changeEvent(input as ChangeEventInput);
    case 'final': return finalEvent(input as FinalEventInput);
  }
  throw new TypeError(`unsupported event type: ${String(type)}`);
}

/** Serialize a JSON value with recursively sorted object keys. */
export function stringifyDeterministically(value: unknown): string {
  const encoded = JSON.stringify(sortJson(value));
  if (encoded === undefined) throw new TypeError('value is not JSON serializable');
  return encoded;
}
export const stableStringify = stringifyDeterministically;
function sortJson(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (typeof (value as { toJSON?: unknown }).toJSON === 'function') return sortJson((value as { toJSON: () => unknown }).toJSON(), seen);
  if (seen.has(value)) throw new TypeError('cannot serialize cyclic JSON');
  seen.add(value);
  const result = Array.isArray(value)
    ? value.map(item => sortJson(item, seen))
    : Object.fromEntries(Object.keys(value).sort().map(key => [key, sortJson((value as Record<string, unknown>)[key], seen)]));
  seen.delete(value);
  return result;
}

export function serializeEvent(event: NordbeamEvent): string {
  assertEvent(event);
  return `${stringifyDeterministically(event)}\n`;
}
export const serializeNdjsonEvent = serializeEvent;
function assertEvent(value: unknown): asserts value is NordbeamEvent {
  if (!value || typeof value !== 'object') throw new TypeError('event must be an object');
  const event = value as { version?: unknown; type?: unknown };
  if (event.version !== NORDBEAM_EVENT_VERSION) throw new TypeError(`unsupported event version: ${String(event.version)}`);
  if (!(EVENT_TYPES as readonly unknown[]).includes(event.type)) throw new TypeError(`unsupported event type: ${String(event.type)}`);
}
export function isNordbeamEvent(value: unknown): value is NordbeamEvent { try { assertEvent(value); return true; } catch { return false; } }

/** Minimal sink contract; it also works with Node's process.stdout. */
export interface NdjsonSink {
  write(chunk: string): unknown;
  /** Node Writable-compatible backpressure hook. */
  once?(event: 'drain', listener: () => void): unknown;
}
export interface NdjsonWriterOptions { protocol?: string; emitVersion?: boolean }
export interface NdjsonEventWriter { emit(event: NordbeamEvent): Promise<void>; write(event: NordbeamEvent): Promise<void>; version(): Promise<void>; flush(): Promise<void> }

/** Create an ordered writer that queues concurrent callbacks and honors drain backpressure. */
export function createNdjsonWriter(sink: NdjsonSink, options: NdjsonWriterOptions = {}): NdjsonEventWriter {
  if (!sink || typeof sink.write !== 'function') throw new TypeError('an NDJSON sink with write(chunk) is required');
  const protocol = options.protocol ?? NORDBEAM_EVENT_PROTOCOL;
  const emitVersion = options.emitVersion !== false;
  let versionWritten = false;
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (task: () => Promise<void>): Promise<void> => { const next = queue.then(task); queue = next.catch(() => undefined); return next; };
  const writeOne = async (event: NordbeamEvent): Promise<void> => {
    const result = sink.write(serializeEvent(event));
    if (result && typeof (result as PromiseLike<unknown>).then === 'function') await result;
    else if (result === false && sink.once) await new Promise<void>(resolve => sink.once?.('drain', resolve));
  };
  const ensureVersion = async (): Promise<void> => { if (!emitVersion || versionWritten) return; await writeOne(versionEvent(protocol)); versionWritten = true; };
  const emit = (event: NordbeamEvent): Promise<void> => enqueue(async () => {
    if (event.type === 'version') {
      if (versionWritten) throw new Error('the NDJSON version event can only be emitted once');
      await writeOne(event); versionWritten = true; return;
    }
    await ensureVersion(); await writeOne(event);
  });
  return { emit, write: emit, version: () => emit(versionEvent(protocol)), flush: () => queue };
}
export const createNdjsonEventWriter = createNdjsonWriter;

/** Construct a writer backed by stdout without importing Node types. */
export function createStdoutNdjsonWriter(stdout?: NdjsonSink, options?: NdjsonWriterOptions): NdjsonEventWriter {
  const processLike = (globalThis as typeof globalThis & { process?: { stdout?: NdjsonSink } }).process;
  const sink = stdout ?? processLike?.stdout;
  if (!sink) throw new Error('stdout is unavailable; pass an explicit sink');
  return createNdjsonWriter(sink, options);
}
export const createStdoutWriter = createStdoutNdjsonWriter;
