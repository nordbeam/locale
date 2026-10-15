import { isAbsolute, relative, sep } from 'node:path';
import { errorCodeEntry, usageError } from './error-codes.js';

const codes = { red: 31, green: 32, yellow: 33 } as const;
export type Tone = keyof typeof codes;

/** Color only on a terminal without NO_COLOR, or whenever FORCE_COLOR is set. */
export function colorEnabled(stream: { isTTY?: boolean }): boolean {
  const force = process.env.FORCE_COLOR;
  if (force !== undefined && force !== '0') return true;
  return !!stream.isTTY && process.env.NO_COLOR === undefined;
}

/** Wrap human-readable text in ANSI color for the given output stream. */
export function paint(stream: { isTTY?: boolean }, tone: Tone, text: string): string {
  return colorEnabled(stream) ? `\x1b[${codes[tone]}m${text}\x1b[39m` : text;
}

/** Singular or plural noun with its count, e.g. "1 locale" or "2 locales". */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Project-relative, forward-slash path. Human output is relative to the working directory; JSON passes the project root as base. */
export function displayPath(file: string, base = process.cwd()): string {
  return relative(base, file).split(sep).join('/') || '.';
}

/** Rewrites absolute paths under `root` to project-relative ones. Other strings are left as they are. */
export function relativePaths<T>(value: T, root: string): T {
  const prefix = root.endsWith(sep) ? root : root + sep;
  const visit = (node: unknown): unknown => {
    if (typeof node === 'string') return isAbsolute(node) && (node === root || node.startsWith(prefix)) ? displayPath(node, root) : node;
    if (Array.isArray(node)) return node.map(visit);
    if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, visit(item)]));
    return node;
  };
  return visit(value) as T;
}

/** Adds the registry fix and docs link to a coded diagnostic; its own hint stays the fix when it has one. */
export function withGuidance<T extends { readonly code?: string; readonly hint?: string }>(item: T): T & { fix?: string; docs?: string } {
  const entry = item.code === undefined ? undefined : errorCodeEntry(item.code);
  return entry ? { ...item, fix: item.hint ?? entry.fix, docs: entry.docs } : item;
}

export const defaultLimit = 50;
/** Message IDs listed in a grouped warning when --limit is not given. */
const groupedIdSample = 10;
/** Warnings that repeat once per message; three or more with one code, locale and file become one row. */
const groupedCodes = new Set(['FALLBACK_MESSAGE', 'MISSING_MESSAGE']);
const groupMinimum = 3;

/** Output controls shared by check, doctor, generate, inspect and verify. */
export interface ReportOptions {
  /** Rows per list; Infinity for --limit all. */
  readonly limit: number;
  /** Whether --limit was given, which also sets how many message IDs a grouped row lists. */
  readonly explicitLimit: boolean;
  readonly only?: readonly string[];
  /** Print only the summary, ok and the first five errors. */
  readonly summary?: boolean;
  readonly baseLocale?: string;
}

export function parseLimit(value: string | undefined): Pick<ReportOptions, 'limit' | 'explicitLimit'> {
  if (value === undefined) return { limit: defaultLimit, explicitLimit: false };
  if (value === 'all') return { limit: Infinity, explicitLimit: true };
  if (!/^[1-9]\d*$/.test(value)) throw usageError('--limit must be a positive whole number, or all.', { option: '--limit', value, validValues: ['<n>', 'all'] });
  return { limit: Number(value), explicitLimit: true };
}

export interface ReportSummary { errors: number; warnings: number; byCode: Record<string, number> }

/** Counts what the output reports: with --only, only the selected codes. */
export function summarize(errors: readonly { readonly code?: string }[], warnings: readonly { readonly code?: string }[]): ReportSummary {
  const counts = new Map<string, number>();
  for (const item of [...errors, ...warnings]) if (item.code !== undefined) counts.set(item.code, (counts.get(item.code) ?? 0) + 1);
  return { errors: errors.length, warnings: warnings.length, byCode: Object.fromEntries([...counts].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) };
}

export interface GroupedWarning {
  readonly code: string;
  readonly locale?: string;
  readonly file?: string;
  readonly count: number;
  readonly messageIds: readonly string[];
  readonly message: string;
  readonly fix?: string;
  readonly docs?: string;
}

export interface Diagnosable { readonly code?: string; readonly message?: string; readonly file?: string; readonly locale?: string; readonly messageId?: string; readonly hint?: string }

export interface ShapedDiagnostics<T> {
  readonly summary: ReportSummary;
  readonly errors: (T & { fix?: string; docs?: string })[];
  readonly warnings: (T | GroupedWarning)[];
  /** Rows left out of each list, present only when a list was capped. */
  readonly truncated?: { errors?: number; warnings?: number };
}

/** Filters by --only, counts, groups repeated warnings, and caps each list. Paths stay absolute here. */
export function shapeDiagnostics<T extends Diagnosable>(errors: readonly T[], warnings: readonly T[], options: ReportOptions): ShapedDiagnostics<T> {
  const selected = (items: readonly T[]) => options.only ? items.filter(item => options.only!.includes(item.code ?? '')) : items;
  const allErrors = selected(errors), allWarnings = selected(warnings);
  const summary = summarize(allErrors, allWarnings);
  const groupKey = (item: T) => JSON.stringify([item.code, item.locale, item.file]);
  const members = new Map<string, T[]>();
  for (const item of allWarnings) {
    if (!groupedCodes.has(item.code ?? '')) continue;
    const key = groupKey(item);
    members.set(key, [...(members.get(key) ?? []), item]);
  }
  const idLimit = options.explicitLimit ? options.limit : groupedIdSample;
  const rows: (T | GroupedWarning)[] = [];
  const grouped = new Set<string>();
  for (const item of allWarnings) {
    const key = groupedCodes.has(item.code ?? '') ? groupKey(item) : undefined;
    const group = key === undefined ? undefined : members.get(key)!;
    if (key === undefined || group!.length < groupMinimum) { rows.push(item); continue; }
    if (grouped.has(key)) continue;
    grouped.add(key);
    const count = group!.length;
    const message = item.code === 'MISSING_MESSAGE' ? `${count} messages are missing in ${item.locale}` : `${count} messages fall back to ${options.baseLocale ?? 'the base locale'}`;
    const entry = errorCodeEntry(item.code!);
    rows.push({ code: item.code!, locale: item.locale, file: item.file, count, messageIds: group!.flatMap(member => member.messageId ? [member.messageId] : []).slice(0, idLimit), message, fix: entry?.fix, docs: entry?.docs });
  }
  const errorRows = allErrors.map(withGuidance);
  const truncated: { errors?: number; warnings?: number } = {};
  if (errorRows.length > options.limit) truncated.errors = errorRows.length - options.limit;
  if (rows.length > options.limit) truncated.warnings = rows.length - options.limit;
  return {
    summary,
    errors: errorRows.slice(0, options.limit),
    warnings: rows.slice(0, options.limit),
    ...(truncated.errors === undefined && truncated.warnings === undefined ? {} : { truncated }),
  };
}

/** Caps a top-level list field, returning how many entries were left out. */
export function capList<T>(items: readonly T[], limit: number): { items: T[]; omitted: number } {
  return { items: items.slice(0, limit), omitted: Math.max(0, items.length - limit) };
}

/** The one-line hint that names the way to see every row. Empty when nothing was capped. */
export function truncationHint(truncated: Record<string, number | undefined> | undefined): string | undefined {
  if (!truncated) return undefined;
  const parts = Object.entries(truncated).filter(([, count]) => count).map(([name, count]) => `${count} more ${name}`);
  return parts.length ? `… ${parts.join(', ')} not shown. Use --limit all, or --only CODE to see a single code.` : undefined;
}
