import { existsSync, watch } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { generate, createGenerator, check } from './project.js';
import type { GenerateOptions } from './project.js';
import { notesFile } from './notes.js';
import { configName, configWarnings, discoverConfig, readConfig } from './config.js';
import { CompileError, formatDiagnostic } from './diagnostics.js';
import type { Diagnostic } from './compiler.js';
import { commandNames, optionHelp, printHelp, suggest, unknownCommandError } from './cli-help.js';
import { CliError, errorCodeEntry, errorCodes, exitCodes, usageError } from './error-codes.js';
import type { ErrorCodeEntry } from './error-codes.js';
import { capList, displayPath, paint, parseLimit, plural, relativePaths, shapeDiagnostics, summarize, truncationHint, withGuidance } from './cli-output.js';
import type { GroupedWarning, ReportOptions, ShapedDiagnostics } from './cli-output.js';
import type { InitFramework } from './init.js';
import type { SkillInstallEntry } from './skills.js';
import type { InspectFreshness, InspectMessageResult, InspectResult } from './inspect.js';
import { coreVersion, loadMigrate } from './migrate-loader.js';
import type { CodemodFormat, CodemodSkip, MigrationFormat } from './migrate-loader.js';
import type { JsonValue, NdjsonEventWriter } from './ndjson-events.js';
import type { TextFinding, TextScanOptions } from './text-scan.js';

let jsonAny = process.argv.includes('--json') && process.argv.slice(2).some(argument => (commandNames as readonly string[]).includes(argument));
let ndjsonAny = process.argv.includes('--ndjson');
let ndjsonWriter: NdjsonEventWriter | undefined;
let operationId = '';
// Project root for project-relative paths in NDJSON diagnostics, once the config is known.
let eventRoot: string | undefined;
let operationCommand = 'command';

const fail = (message: string): void => console.error(paint(process.stderr, 'red', message));
const warn = (message: string): void => console.warn(paint(process.stderr, 'yellow', message));
const ok = (message: string): void => console.log(paint(process.stdout, 'green', message));
const mark = (dryRun: boolean | undefined): string => dryRun ? '~' : paint(process.stdout, 'green', '✓');
/** Errors win over warnings, and a clean run reads as success. */
const summaryTone = (errors: number, warnings: number): 'red' | 'yellow' | 'green' => errors ? 'red' : warnings ? 'yellow' : 'green';
const modeLabel = (development: boolean): string => development ? 'development output' : 'production output';

/** Every parser failure is a usage error; an unknown option also gets a did-you-mean suggestion. */
function parseArgumentError(error: unknown): CliError {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes('Unknown option')) return usageError(message);
  const token = message.match(/['"](-[^'"]+)['"]/)?.[1] ?? '--unknown';
  const near = suggest(token, Object.keys(optionHelp));
  return usageError(`Unknown option ${token}${near ? `, did you mean --${near}?` : '. Run nordbeam-locale --help for options.'}`, { option: token, ...(near ? { suggestion: `--${near}` } : {}) });
}

/** A missing format is a usage error; a value outside the accepted set is UNKNOWN_FORMAT and lists validValues. */
function formatError(option: string, message: string, value: string | undefined, validValues: readonly string[]): CliError {
  return new CliError(value === undefined ? 'USAGE' : 'UNKNOWN_FORMAT', message, { option: `--${option}`, ...(value === undefined ? {} : { value }), validValues });
}

function catalogDirectory(options: GenerateOptions): string {
  return resolve(options.root ?? process.cwd(), options.catalogs ?? 'messages');
}

function missingCatalogs(options: GenerateOptions): CliError {
  return new CliError('FILE_NOT_FOUND', `No catalogs directory at ${displayPath(catalogDirectory(options))}/. Run nordbeam-locale init, or set "catalogs" in ${configName} to the directory that holds your locale files.`, { path: displayPath(catalogDirectory(options)) });
}

function requireCatalogs(options: GenerateOptions): void {
  if (!existsSync(catalogDirectory(options))) throw missingCatalogs(options);
}

function displayCliError(error: unknown, options?: GenerateOptions): Error {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' && options && !existsSync(catalogDirectory(options))) return missingCatalogs(options);
  return error instanceof Error ? error : new Error(String(error));
}

function jsonError(errors: readonly Record<string, unknown>[], extra: Record<string, unknown> = {}): void {
  const body = { ok: false, summary: summarize(errors as { code?: string }[], []), ...extra, errors };
  // The project root is known once the config loads; before that, paths stay as the error reported them.
  console.log(JSON.stringify(eventRoot === undefined ? { version: 1, ...body } : { version: 1, root: eventRoot, ...relativePaths(body, eventRoot) }));
}

/** The report for --json: long lists capped like other reports, with what was left out counted in `truncated`. */
function reportJson(report: import('./report.js').ProjectReport, limit: number): Record<string, unknown> {
  const messages = capList(report.messages, limit), unused = capList(report.usage.unused, limit);
  const errors = capList(report.diagnostics.errors, limit), warnings = capList(report.diagnostics.warnings, limit), samples = capList(report.hardcoded.samples, limit);
  const truncated = Object.fromEntries(Object.entries({ messages: messages.omitted, unused: unused.omitted, errors: errors.omitted, warnings: warnings.omitted, hardcodedSamples: samples.omitted }).filter(([, count]) => count));
  return {
    ...report,
    usage: { ...report.usage, unused: unused.items },
    hardcoded: { ...report.hardcoded, samples: samples.items },
    diagnostics: { errors: errors.items, warnings: warnings.items },
    messages: messages.items,
    ...(Object.keys(truncated).length ? { truncated } : {}),
  };
}

/** A written page's path, relative when it is inside the current directory and absolute otherwise. */
function pagePath(file: string): string {
  const shown = displayPath(file);
  return shown.startsWith('../') ? file : shown;
}

/** Open a file with the platform's default handler without waiting for it. */
function openPage(file: string): void {
  const [command, args] = process.platform === 'darwin' ? ['open', [file]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', file]] : ['xdg-open', [file]];
  const child = spawn(command as string, args as string[], { detached: true, stdio: 'ignore' });
  child.on('error', () => console.error(`nordbeam-locale: could not open a browser. Open ${pagePath(file)} yourself.`));
  child.unref();
}

/** Command results that list diagnostics share one machine shape: a summary, capped lists, project-relative paths and the project root. */
function machineReport(result: Record<string, unknown>, shape: ReportOptions, root: string): Record<string, unknown> {
  const { errors = [], warnings = [], ...rest } = result as { errors?: Diagnostic[]; warnings?: Diagnostic[] } & Record<string, unknown>;
  const lists = shapeDiagnostics(errors, warnings, shape.summary ? { ...shape, limit: 5 } : shape);
  const truncated: Record<string, number> = { ...lists.truncated };
  const body: Record<string, unknown> = shape.summary
    ? { ok: rest.ok ?? true, summary: lists.summary, errors: lists.errors }
    : { ...rest, summary: lists.summary, errors: lists.errors, warnings: lists.warnings };
  if (!shape.summary) for (const key of ['unused', 'changed']) {
    if (!Array.isArray(body[key])) continue;
    const capped = capList(body[key] as unknown[], shape.limit);
    body[key] = capped.items;
    if (capped.omitted) truncated[key] = capped.omitted;
  }
  if (Object.keys(truncated).length) body.truncated = truncated;
  return { root, ...relativePaths(body, root) };
}

/** Diagnostics for a list of messages, as human lines: summary mode shows the first five errors only. */
function humanLists(errors: readonly Diagnostic[], warnings: readonly Diagnostic[], shape: ReportOptions): ShapedDiagnostics<Diagnostic> {
  const lists = shapeDiagnostics(errors, warnings, shape.summary ? { ...shape, limit: 5 } : shape);
  return shape.summary ? { ...lists, warnings: [] } : lists;
}

/** Prints capped diagnostics to stderr, then the summary line and the hint for any rows left out. */
function printLists(lists: ShapedDiagnostics<Diagnostic>, shape: ReportOptions, summaryLine: string): void {
  printDiagnostics(lists.errors, 'red');
  printDiagnostics(lists.warnings, 'yellow');
  console.log(paint(process.stdout, summaryTone(lists.summary.errors, lists.summary.warnings), summaryLine));
  const hint = truncationHint(shape.summary ? { errors: lists.truncated?.errors } : lists.truncated);
  if (hint) console.log(hint);
}

/** Inspect keeps its diagnostics under `diagnostics`; the summary and freshness lists follow the same caps. */
function inspectReport(result: InspectResult, shape: ReportOptions, root: string): Record<string, unknown> {
  const { diagnostics, freshness, config: { root: _configRoot, ...config }, ...rest } = result;
  const lists = shapeDiagnostics(diagnostics.errors, diagnostics.warnings, shape.summary ? { ...shape, limit: 5 } : shape);
  if (shape.summary) return { root, ok: result.ok, summary: lists.summary, errors: lists.errors, ...(lists.truncated ? { truncated: { errors: lists.truncated.errors } } : {}) };
  const staleReason = capList(freshness.staleReason, shape.limit), modifiedFiles = capList(freshness.modifiedFiles, shape.limit);
  const truncated = { ...(staleReason.omitted ? { staleReason: staleReason.omitted } : {}), ...(modifiedFiles.omitted ? { modifiedFiles: modifiedFiles.omitted } : {}) };
  const body = {
    ...rest,
    config,
    summary: lists.summary,
    freshness: { ...freshness, staleReason: staleReason.items, modifiedFiles: modifiedFiles.items, ...(Object.keys(truncated).length ? { truncated } : {}) },
    diagnostics: { errors: lists.errors, warnings: lists.warnings, ...(lists.truncated ? { truncated: lists.truncated } : {}) },
  };
  return { root, ...relativePaths(body, root) };
}

/** Machine-readable parse of --only: codes are checked against the registry, so a typo is a usage error. */
function parseOnly(value: string): string[] {
  const codes = value.split(',').map(code => code.trim().toUpperCase()).filter(Boolean);
  if (!codes.length) throw usageError('--only needs at least one code, for example --only FALLBACK_MESSAGE.', { option: '--only', value });
  for (const code of codes) {
    if (errorCodeEntry(code)) continue;
    const near = suggest(code, Object.keys(errorCodes));
    throw usageError(`Unknown code ${JSON.stringify(code)}${near ? `, did you mean ${near}?` : '.'} Codes are listed in docs/reference/errors.md.`, { option: '--only', value: code, ...(near ? { suggestion: near } : {}) });
  }
  return codes;
}

function jsonSuccess(result: Record<string, unknown> = {}): void {
  // Keep result fields at the top level for compatibility with the original
  // command-specific JSON while giving every response the same envelope.
  console.log(JSON.stringify({ version: 1, ok: true, ...result }));
}

function printExplanation(entry: ErrorCodeEntry): void {
  console.log(`${entry.code} — ${entry.severity}${entry.exitCode === undefined ? '' : `, exit status ${entry.exitCode}`}`);
  console.log(`\n${entry.explanation}`);
  console.log(`\nFix: ${entry.fix}`);
  console.log(`Docs: ${entry.docs}`);
}

/** Human diagnostics show project-relative files; the structured result keeps absolute paths. */
function printDiagnostics(diagnostics: readonly (Diagnostic | GroupedWarning)[], tone: 'red' | 'yellow'): void {
  for (const diagnostic of diagnostics) {
    if ('count' in diagnostic) {
      const ids = diagnostic.messageIds.slice(0, 3).join(', ');
      console.error(paint(process.stderr, tone, `${diagnostic.file ? displayPath(diagnostic.file) : diagnostic.locale ?? ''}: ${diagnostic.message} [${diagnostic.code}]${ids ? ` e.g. ${ids}` : ''}\n  ${diagnostic.fix ?? ''}`.trimEnd()) + '\n');
      continue;
    }
    const shown = diagnostic.file ? { ...diagnostic, file: displayPath(diagnostic.file) } : diagnostic;
    console.error(paint(process.stderr, tone, formatDiagnostic(shown)) + '\n');
  }
}

interface Failure {
  readonly code: string;
  readonly exitCode: number;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly diagnostics: readonly Record<string, unknown>[];
}

/** Maps any thrown value to its stable code, exit status, and the diagnostics it reports. A plain Error is a reported condition; any other exception is an internal error. */
async function failureOf(error: unknown): Promise<Failure> {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof CliError) {
    // Library modules attach absolute paths; the CLI reports them project-relative like every other path.
    const details = typeof error.details.path === 'string' && isAbsolute(error.details.path) ? { ...error.details, path: displayPath(error.details.path) } : error.details;
    return { code: error.code, exitCode: error.exitCode, message, details, diagnostics: [{ code: error.code, message, ...details }] };
  }
  if (error instanceof CompileError) {
    const code = error.diagnostics[0]?.code ?? 'VALIDATION_FAILED';
    return { code, exitCode: errorCodes[code]?.exitCode ?? exitCodes.validation, message, details: {}, diagnostics: error.diagnostics as unknown as readonly Record<string, unknown>[] };
  }
  // Structural, not instanceof: the migration package is loaded lazily and may be a different module instance.
  if (error instanceof Error && error.name === 'CodemodStrictError' && Array.isArray((error as { diagnostics?: unknown }).diagnostics)) return { code: 'UNRESOLVED_MIGRATION_CONSTRUCT', exitCode: exitCodes.refused, message, details: {}, diagnostics: (error as Error & { diagnostics: readonly CodemodSkip[] }).diagnostics.map(item => ({
    code: 'UNRESOLVED_MIGRATION_CONSTRUCT',
    message: `${item.code ? `[${item.code}] ` : ''}${item.callee} — ${item.reason}${item.action ? ` ${item.action}` : ''}`,
    ...(item.code ? { detailCode: item.code } : {}),
    ...(item.action ? { action: item.action } : {}),
    ...(item.offset === undefined ? {} : { offset: item.offset }),
    ...(item.file ? { file: item.file } : {}),
  })) };
  const { PlanApplyError } = await import('./plan-apply.js');
  if (error instanceof PlanApplyError) return { code: error.code, exitCode: errorCodes[error.code]?.exitCode ?? exitCodes.validation, message, details: {}, diagnostics: [{ code: error.code, message }] };
  const system = error as NodeJS.ErrnoException;
  if (system.code === 'ENOENT' || system.code === 'EEXIST') {
    const code = system.code === 'ENOENT' ? 'FILE_NOT_FOUND' : 'FILE_EXISTS';
    const details = typeof system.path === 'string' ? { path: displayPath(system.path) } : {};
    return { code, exitCode: code === 'FILE_NOT_FOUND' ? exitCodes.inputNotFound : exitCodes.refused, message, details, diagnostics: [{ code, message, ...details }] };
  }
  // Library code reports user-facing conditions with plain Error; TypeError, RangeError and non-Error values are defects.
  const code = error instanceof Error && Object.getPrototypeOf(error) === Error.prototype ? 'COMMAND_FAILED' : 'INTERNAL_ERROR';
  return { code, exitCode: code === 'COMMAND_FAILED' ? exitCodes.validation : exitCodes.internal, message, details: {}, diagnostics: [{ code, message }] };
}

/** The NDJSON writer and event builders load only when an NDJSON command runs. */
async function eventKit() {
  const events = await import('./ndjson-events.js');
  ndjsonWriter ??= events.createStdoutNdjsonWriter(process.stdout);
  operationId ||= randomUUID();
  return { events, writer: ndjsonWriter };
}

async function eventStart(command: string): Promise<void> {
  const { events, writer } = await eventKit();
  await writer.emit(events.progressEvent({ operationId, phase: command, completed: 0, total: 1, message: 'Operation started.' }));
  await writer.flush();
}

async function eventResult(command: string, result: Record<string, unknown>, succeeded = result.ok !== false, diagnostics: { errors?: unknown; warnings?: unknown } = result): Promise<void> {
  const { events, writer } = await eventKit();
  for (const [severity, items] of [['error', diagnostics.errors], ['warning', diagnostics.warnings]] as const) {
    for (const item of (items as Array<Record<string, unknown>> | undefined) ?? []) await writer.emit(events.diagnosticEventFrom(item as never, { operationId, severity, root: eventRoot }));
  }
  const changed = Array.isArray(result.changed) ? result.changed : [];
  for (const item of changed) {
    const path = typeof item === 'string' ? item : item && typeof item === 'object' && typeof (item as { file?: unknown }).file === 'string' ? (item as { file: string }).file : undefined;
    await writer.emit(events.changeEvent({ operationId, action: 'update', key: path }));
  }
  await writer.emit(events.progressEvent({ operationId, phase: command, completed: 1, total: 1, message: 'Operation completed.' }));
  await writer.emit(events.finalEvent({ operationId, status: succeeded ? 'succeeded' : 'failed', summary: `${command} ${succeeded ? 'completed' : 'failed'}`, result: result as unknown as JsonValue }));
  await writer.flush();
}

async function eventError(command: string, error: unknown): Promise<void> {
  const { events, writer } = await eventKit();
  const failure = await failureOf(error);
  for (const item of failure.diagnostics) await writer.emit(events.diagnosticEventFrom(item as never, { operationId, severity: 'error', root: eventRoot }));
  await writer.emit(events.finalEvent({ operationId, status: 'failed', summary: `${command} failed`, error: { ...events.finalErrorFrom(error, failure.code), ...failure.details } }));
  await writer.flush();
}

/** Human text for a freshness problem, or undefined when the generated output is fresh. */
function freshnessProblem(freshness: InspectFreshness): Diagnostic | undefined {
  if (freshness.status === 'fresh') return undefined;
  if (freshness.status === 'modified') {
    const names = freshness.modifiedFiles.slice(0, 3).map(item => item.input).join(', ');
    return { code: 'GENERATED_MODIFIED', message: `${plural(freshness.modifiedFiles.length, 'generated file')} edited by hand: ${names}` } as Diagnostic;
  }
  const reasons = freshness.staleReason.slice(0, 3).map(item => item.message).join('; ');
  return { code: 'GENERATED_STALE', message: `generated output is ${freshness.status}${reasons ? `: ${reasons}` : ''}` } as Diagnostic;
}

function printMessage(message: InspectMessageResult, root: string): void {
  const list = (items: readonly string[]) => items.length ? items.join(', ') : 'none';
  const argumentsText = message.argumentsError !== undefined ? `unknown (${message.argumentsError})`
    : list(message.arguments.map(argument => `${argument.name} (${argument.type}${argument.choices.length ? `: ${argument.choices.join('|')}` : ''})`));
  console.log(message.id);
  console.log(`  present:      ${list(message.present)}`);
  console.log(`  missing:      ${list(message.missing)}`);
  console.log(`  untranslated: ${list(message.untranslated)}`);
  console.log(`  arguments:    ${argumentsText}`);
  for (const item of message.locales) {
    console.log(item.present ? `  ${item.locale}: ${displayPath(item.file, root)}:${item.line}:${item.column}  ${item.source}` : `  ${item.locale}: missing in ${displayPath(item.file, root)}`);
  }
}

/** One human line per installed skill and target; files that were left alone say why on stderr. */
function printSkillEntry(entry: SkillInstallEntry, root: string, dryRun: boolean): void {
  const verbs = dryRun
    ? { created: 'Would create', updated: 'Would update', unchanged: 'Preserved', skipped: 'Skipped' }
    : { created: 'Created', updated: 'Updated', unchanged: 'Preserved', skipped: 'Skipped' };
  const { created, updated, unchanged, skipped, removed } = entry.counts;
  const total = created + updated + unchanged + skipped + removed;
  const detail = entry.action === 'created' || entry.action === 'unchanged' ? `${plural(total, 'file')}` : [created && `${created} created`, updated && `${updated} updated`, unchanged && `${unchanged} unchanged`, skipped && `${skipped} skipped`, removed && `${removed} removed`].filter(Boolean).join(', ');
  console.log(`${verbs[entry.action]} skill ${entry.skill} in ${displayPath(entry.directory, root)}${detail ? ` (${detail})` : ''}`);
  if (entry.reason) warn(`  ${entry.reason}`);
  for (const file of entry.files) if (file.action === 'skipped' && file.reason) warn(`  ${displayPath(file.file, root)}: ${file.reason}`);
}

async function installAgentSkills(root: string) {
  const { installSkills } = await import('./skills.js');
  return installSkills(root, { version: await coreVersion() });
}

function agentVerb(action: string): string {
  return action === 'unchanged' ? 'Preserved' : action === 'created' ? 'Created' : 'Updated';
}

/** One finding as a human line: position, the text, how it is translated inline, and its catalog match. */
function findingLine(finding: TextFinding): string {
  const text = finding.text.length > 90 ? `${finding.text.slice(0, 89)}…` : finding.text;
  const inline = finding.translations ? ` · ${Object.keys(finding.translations).join(' and ')} inline` : '';
  const match = finding.catalog ? paint(process.stdout, 'green', ` → ${finding.catalog.id}${finding.catalog.exact ? '' : ` (${finding.catalog.locale} text only)`}`) : '';
  const where = finding.kind === 'jsx-text' || finding.kind === 'template-text' ? '' : ` · ${finding.where}`;
  return `  ${`${finding.line}:${finding.column}`.padEnd(8)} ${JSON.stringify(text)}${where}${inline}${match}${finding.confidence === 'medium' ? ' · medium' : ''}`;
}

/** `hardcoded`: list UI text outside the catalog, and preview or write fixes for it. */
async function hardcodedCommand(options: TextScanOptions, values: { json?: boolean; fix?: boolean; extract?: boolean; write?: boolean; strict?: boolean; regenerate?: boolean; confidence?: string }, limit: number, root: string): Promise<void> {
  const { scanText, planTextFixes } = await import('./text-scan.js');
  const result = await scanText(options);
  // New messages need surer findings than reusing a catalog message: --extract defaults to high.
  const confidence = (values.confidence ?? (values.extract ? 'high' : 'medium')) === 'high' ? 'high' : 'medium';
  const findings = confidence === 'high' ? result.findings.filter(finding => finding.confidence === 'high') : result.findings;
  const fixing = !!(values.fix || values.extract);
  const plan = fixing ? await planTextFixes({ ...result, findings }, { ...options, extract: !!values.extract, confidence }) : undefined;
  const written = plan && values.write && (plan.edits.length || plan.messages.length)
    ? await (await import('./cli-tools.js')).applyTextFixes({ ...options, regenerate: !!values.regenerate }, plan) : undefined;
  const failed = !!values.strict && findings.length > 0 && !written;
  const { summary } = result;
  if (values.json) {
    const shown = capList(findings, limit);
    const edits = plan && capList(plan.edits, limit), skipped = plan && capList(plan.skipped, limit);
    const truncated = Object.fromEntries(Object.entries({ findings: shown.omitted, edits: edits?.omitted, skipped: skipped?.omitted }).filter(([, count]) => count));
    const body = {
      ok: !failed, sourceFiles: result.sourceFiles, confidence,
      summary: { ...summary, ...(confidence === 'high' ? { reported: findings.length } : {}) },
      findings: shown.items, learned: result.learned.slice(0, 50), ignored: result.ignored, incomplete: result.incomplete, timing: result.timing,
      ...(plan ? { plan: { edits: edits!.items, messages: plan.messages, skipped: skipped!.items } } : {}),
      ...(written ? { written } : {}),
      ...(Object.keys(truncated).length ? { truncated } : {}),
    };
    jsonSuccess({ root, ...relativePaths(body, root) });
    if (failed) process.exitCode = 1;
    return;
  }
  if (plan) {
    let file = '';
    for (const edit of plan.edits.slice(0, limit)) {
      if (edit.file !== file) { file = edit.file; console.log(displayPath(file)); }
      if (edit.before) console.log(`  ${String(edit.line).padEnd(6)} ${paint(process.stdout, 'red', `- ${edit.before.replace(/\s*\n\s*/g, ' ')}`)}`);
      console.log(`  ${(edit.before ? '' : String(edit.line)).padEnd(6)} ${paint(process.stdout, 'green', `+ ${edit.after.trim()}`)}${edit.added ? ' (new message)' : ''}`);
    }
    if (plan.edits.length > limit) console.log(`… ${plan.edits.length - limit} more. --limit all shows every edit.`);
    const { textSkipReasons } = await import('./text-scan.js');
    const reasons = new Map<string, number>();
    for (const item of plan.skipped) reasons.set(textSkipReasons[item.kind], (reasons.get(textSkipReasons[item.kind]) ?? 0) + 1);
    const files = new Set(plan.edits.map(edit => edit.file)).size, replacements = plan.edits.filter(edit => edit.before).length, bindings = plan.edits.length - replacements;
    if (written) {
      ok(`nordbeam-locale: replaced ${plural(written.replaced, 'string')} in ${plural(files, 'file')} and added ${plural(written.added.length, 'message')}.`);
      if (written.stale) console.log(`Generated output is stale: run ${written.next}.`);
    } else {
      console.log(`nordbeam-locale: ${values.extract ? 'extract' : 'fix'} preview — ${plural(replacements, 'replacement')} in ${plural(files, 'file')}, ${plural(plan.messages.length, 'new message')}${bindings ? `, ${plural(bindings, 'added binding')}` : ''}.`);
      if (plan.edits.length) console.log('Nothing was written. Re-run with --write to apply.');
    }
    for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(paint(process.stdout, 'yellow', `  skipped ${count}: ${reason}`));
    return;
  }
  let file = '';
  for (const finding of findings.slice(0, limit)) {
    if (finding.file !== file) {
      file = finding.file;
      console.log(`${displayPath(file)}${finding.context === 'mixed' ? '  (renders messages too)' : ''}`);
    }
    console.log(findingLine(finding));
  }
  const reported = findings.length, high = findings.filter(finding => finding.confidence === 'high').length;
  const tone = reported ? 'yellow' : 'green';
  console.log(paint(process.stdout, tone, reported
    ? `nordbeam-locale: ${plural(reported, 'string')} of UI text outside the catalog — ${high} high${confidence === 'medium' ? ` and ${reported - high} medium` : ''} confidence; ${findings.filter(finding => finding.catalog).length} match a catalog message.`
    : `nordbeam-locale: no UI text outside the catalog in ${plural(result.sourceFiles, 'source file')}.`));
  if (reported) {
    console.log(`  ${plural(summary.mixedFiles, 'file')} that render messages, ${plural(summary.unlocalizedFiles, 'file')} that render none. Most text by area:`);
    for (const area of summary.areas.slice(0, 6)) console.log(`    ${area.area.padEnd(36)} ${String(area.findings).padStart(5)} in ${plural(area.files, 'file')}`);
    if (reported > limit) console.log(`Showing ${limit} of ${reported}, files that render messages first. --limit all lists every one; --json gives the full report.`);
    const exact = findings.filter(finding => finding.catalog?.exact).length;
    console.log(`Next: ${exact ? `--fix reuses the ${plural(exact, 'exact catalog match', 'exact catalog matches')}; ` : ''}--extract adds the rest as new messages. Both preview until --write.`);
  }
  if (result.incomplete.length) warn(`Not scanned: ${plural(result.incomplete.length, 'file')} (${result.incomplete.slice(0, 3).map(item => `${displayPath(item.file)}: ${item.reason}`).join('; ')}).`);
  if (failed) process.exitCode = 1;
}

async function main(): Promise<void> {
  // Keep the parser options inline so Node's generic overload can validate
  // individual fields below; this small structural annotation also lets us
  // customize parse errors before the command dispatch.
  let parsed: { values: any; positionals: string[] };
  try {
    parsed = parseArgs({ allowPositionals: true, options: {
    config: { type: 'string' },
    catalogs: { type: 'string' },
    'base-locale': { type: 'string' },
    'out-dir': { type: 'string' },
    framework: { type: 'string' },
    locale: { type: 'string' },
    from: { type: 'string' },
    out: { type: 'string' },
    id: { type: 'string' },
    message: { type: 'string' },
    'default-message': { type: 'string' },
    to: { type: 'string' },
    'source-dir': { type: 'string' },
    'schema-dir': { type: 'string' },
    'messages-object': { type: 'string' },
    'messages-import': { type: 'string' },
    'messages-hook': { type: 'string' },
    notes: { type: 'string' },
    'move-type-import': { type: 'string', multiple: true },
    'message-id-map': { type: 'string' },
    'custom-call': { type: 'string', multiple: true },
    'initial-locale-expression': { type: 'string' },
    write: { type: 'boolean' },
    'from-locale': { type: 'string' },
    expansion: { type: 'string' },
    update: { type: 'boolean' },
    format: { type: 'string' },
    'catalog-format': { type: 'string' },
    plan: { type: 'string' },
    'dry-run': { type: 'boolean' },
    regenerate: { type: 'boolean' },
    development: { type: 'boolean' },
    production: { type: 'boolean' },
    strict: { type: 'boolean' },
    watch: { type: 'boolean' },
    json: { type: 'boolean' },
    ndjson: { type: 'boolean' },
    version: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    limit: { type: 'string' },
    only: { type: 'string' },
    summary: { type: 'boolean' },
    agent: { type: 'boolean' },
    target: { type: 'string' },
    skill: { type: 'string', multiple: true },
    open: { type: 'boolean' },
    fix: { type: 'boolean' },
    extract: { type: 'boolean' },
    confidence: { type: 'string' },
    } });
  } catch (error) {
    throw parseArgumentError(error);
  }
  const { values, positionals } = parsed;
  if (values.version) {
    console.log(`nordbeam-locale ${await coreVersion()}`);
    return;
  }
  // A bare `--json` is still a usage error on stderr for compatibility; once
  // a command is selected, every JSON-capable path gets an envelope.
  jsonAny ||= !!values.json && !!positionals[0];
  ndjsonAny ||= !!values.ndjson;
  const helpCommand = positionals[0] === 'help' ? positionals[1] : undefined;
  const command = helpCommand ?? positionals[0];
  if (positionals[0] === 'help') {
    if (positionals.length > 2) throw usageError('help accepts one command name.');
    printHelp(helpCommand);
    return;
  }
  operationCommand = command ?? 'generate';
  const positionalLimit = command === 'rename' || command === 'extract' ? 3 : command === 'explain' || command === 'skills' ? 2 : 1;
  if (positionals.length && !(commandNames as readonly string[]).includes(command!)) throw unknownCommandError(command!);
  if (positionals.length > positionalLimit) throw usageError('Unknown command. Use nordbeam-locale --help or nordbeam-locale capabilities --json.');
  if (values.help) {
    printHelp(command);
    return;
  }
  const generating = !command || command === 'generate';
  const checking = positionals[0] === 'check';
  const init = positionals[0] === 'init';
  const exporting = positionals[0] === 'export';
  const importing = positionals[0] === 'import';
  const renaming = positionals[0] === 'rename';
  const extracting = positionals[0] === 'extract';
  const pruning = positionals[0] === 'prune';
  const doctoring = positionals[0] === 'doctor';
  const migrating = positionals[0] === 'migrate';
  const migratingProject = positionals[0] === 'migrate-project';
  const pseudolocalizing = positionals[0] === 'pseudo';
  const inspecting = positionals[0] === 'inspect';
  const writingSchemas = positionals[0] === 'schema';
  const codemodding = positionals[0] === 'codemod';
  const showingCapabilities = positionals[0] === 'capabilities';
  const showingAgentGuide = positionals[0] === 'agent-guide';
  const applyingPlan = positionals[0] === 'apply-plan';
  const verifying = positionals[0] === 'verify';
  const writingReport = positionals[0] === 'report';
  const scanningText = positionals[0] === 'hardcoded';
  const reporting = checking || doctoring || inspecting || verifying || (generating && !!command);
  if (showingCapabilities) {
    const { getAgentCapabilities } = await import('./agent.js');
    const capabilities = getAgentCapabilities();
    if (values.json) jsonSuccess(capabilities as unknown as Record<string, unknown>);
    else {
      console.log(`Nordbeam Locale agent protocol ${capabilities.protocolVersion} (${capabilities.locality})`);
      for (const item of capabilities.commands) console.log(`${item.access.padEnd(11)} ${item.name.padEnd(16)} ${item.summary}`);
      console.log('\nUse nordbeam-locale capabilities --json for the complete machine contract.');
    }
    return;
  }
  if (showingAgentGuide) {
    const { getAgentCapabilities, getAgentGuide } = await import('./agent.js');
    const guide = getAgentGuide();
    if (values.json) jsonSuccess({ protocolVersion: 1, guide, capabilities: getAgentCapabilities() });
    else process.stdout.write(guide);
    return;
  }
  if (positionals[0] === 'explain') {
    const typed = positionals[1];
    if (typed === undefined) throw usageError('explain requires a code, for example nordbeam-locale explain INVALID_ICU.', { command: 'explain' });
    const entry = errorCodeEntry(typed.toUpperCase());
    if (!entry) {
      const near = suggest(typed.toUpperCase(), Object.keys(errorCodes));
      throw usageError(`Unknown code ${JSON.stringify(typed)}${near ? `, did you mean ${near}?` : '.'} Codes are listed in docs/reference/errors.md.`, { command: 'explain', value: typed, ...(near ? { suggestion: near } : {}) });
    }
    if (values.json) jsonSuccess({ ...entry });
    else printExplanation(entry);
    return;
  }
  if (positionals[0] === 'mcp') {
    // From here on stdout carries only protocol messages.
    const { serveMcp } = await import('./mcp.js');
    await serveMcp({ config: values.config });
    return;
  }
  if (positionals[0] === 'skills') {
    if (positionals[1] !== 'install') throw usageError('skills requires a subcommand: nordbeam-locale skills install.', { command: 'skills', validValues: ['install'] });
    if (values.json && values.ndjson) throw usageError('Choose either --json or --ndjson, not both.');
    if (values.ndjson) throw usageError('--ndjson is not available with nordbeam-locale skills.');
    for (const option of ['framework', 'locale', 'from', 'out', 'format', 'write', 'plan', 'strict', 'watch', 'agent', 'limit', 'only', 'summary', 'id', 'to', 'message', 'catalogs', 'out-dir', 'base-locale', 'development', 'production'] as const) {
      if (values[option] !== undefined) throw usageError(`--${option} is not available with nordbeam-locale skills install.`, { option: `--${option}` });
    }
    const skillsModule = await import('./skills.js');
    const targets = values.target === undefined || values.target === 'all' ? skillsModule.skillTargets
      : (skillsModule.skillTargets as readonly string[]).includes(values.target) ? [values.target as 'claude' | 'agents']
      : (() => { throw usageError('--target must be "claude", "agents" or "all".', { option: '--target', value: values.target, validValues: ['claude', 'agents', 'all'] }); })();
    const skillsRoot = values.config ? dirname(resolve(values.config)) : process.cwd();
    eventRoot = skillsRoot;
    const result = await skillsModule.installSkills(skillsRoot, { targets, skills: values.skill, dryRun: !!values['dry-run'], version: await coreVersion() });
    const totals = { created: 0, updated: 0, unchanged: 0, skipped: 0, removed: 0 };
    for (const entry of result.skills) for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += entry.counts[key];
    if (values.json) jsonSuccess({ root: skillsRoot, ...relativePaths({ dryRun: result.dryRun, version: result.version, totals, skills: result.skills }, skillsRoot) });
    else {
      for (const entry of result.skills) printSkillEntry(entry, skillsRoot, result.dryRun);
      console.log(`nordbeam-locale: skills ${result.dryRun ? 'preview' : 'installed'} for @nordbeam/locale ${result.version} — ${totals.created} created, ${totals.updated} updated, ${totals.unchanged} unchanged, ${totals.skipped} skipped${totals.removed ? `, ${totals.removed} removed` : ''}.`);
    }
    return;
  }
  // Migration and codemod format lists live in agent.ts; only those commands pay for it.
  const agent = migrating || migratingProject || codemodding ? await import('./agent.js') : undefined;
  const migrationFormats: readonly MigrationFormat[] = agent?.catalogMigrationFormats ?? [];
  const codemodFormats: readonly string[] = agent?.sourceCodemodFormats ?? [];
  if (values.json && values.ndjson) throw usageError('Choose either --json or --ndjson, not both.');
  if (values.json && !checking && !importing && !pruning && !doctoring && !renaming && !extracting && !migrating && !migratingProject && !pseudolocalizing && !inspecting && !codemodding && !init && !exporting && !writingSchemas && !applyingPlan && !verifying && !writingReport && !scanningText && !(generating && !!command)) throw usageError('--json is available with nordbeam-locale check and other explicit agent-facing commands; run nordbeam-locale capabilities --json for the complete list.');
  if (values.ndjson && !checking && !doctoring && !migrating && !migratingProject && !inspecting && !codemodding && !applyingPlan && !(generating && !!command)) throw usageError('--ndjson is available with generate, check, doctor, inspect, migrate, migrate-project, codemod, or apply-plan.');
  if (values.framework !== undefined && !init && !migratingProject) throw usageError('--framework is available with nordbeam-locale init or migrate-project.');
  if (values.framework !== undefined && !['next', 'vite-react', 'vue', 'svelte', 'solid', 'tanstack-start'].includes(values.framework)) throw usageError('--framework must be "next", "vite-react", "vue", "svelte", "solid" or "tanstack-start".', { option: '--framework', value: values.framework, validValues: ['next', 'vite-react', 'vue', 'svelte', 'solid', 'tanstack-start'] });
  if (values.locale !== undefined && !exporting && !importing && !extracting && !pseudolocalizing && !migrating && !migratingProject) throw usageError('--locale is available with nordbeam-locale export, import, extract, pseudo, migrate, or migrate-project.');
  if (values.from !== undefined && !importing && !renaming && !migrating && !migratingProject && !applyingPlan) throw usageError('--from is available with nordbeam-locale import, rename, migrate, migrate-project, or apply-plan.');
  if (values.out !== undefined && !exporting && !migrating && !writingReport) throw usageError('--out is available with nordbeam-locale export, migrate, or report.');
  if (values.open && !writingReport) throw usageError('--open is available with nordbeam-locale report.');
  if (values.open && (values.out === '-' || values.json && values.out === undefined)) throw usageError('--open needs a page file: drop --json, or add --out <file>.');
  if (values['dry-run'] !== undefined && !importing && !pruning && !migrating && !pseudolocalizing) throw usageError('--dry-run is available with nordbeam-locale import, prune, migrate, pseudo, or skills install.');
  if (values.format !== undefined && !migrating && !migratingProject && !codemodding) throw usageError('--format is available with nordbeam-locale migrate, migrate-project, or codemod.');
  if (values['catalog-format'] !== undefined && !migratingProject) throw usageError('--catalog-format is available with nordbeam-locale migrate-project.');
  if (migrating && (!values.from || !values.format)) throw usageError(`migrate requires --from and --format ${migrationFormats.join('|')}.`);
  if (migrating && !migrationFormats.includes(values.format as MigrationFormat)) throw formatError('format', `--format must be one of: ${migrationFormats.join(', ')}.`, values.format, migrationFormats);
  if (migratingProject && (!values.from || !values.format || !codemodFormats.includes(values.format))) throw formatError('format', 'migrate-project requires --from and a supported --format; run nordbeam-locale --help for the complete list.', values.format, codemodFormats);
  if (migratingProject && values['catalog-format'] !== undefined && !migrationFormats.includes(values['catalog-format'] as MigrationFormat)) throw formatError('catalog-format', `--catalog-format must be one of: ${migrationFormats.join(', ')}.`, values['catalog-format'], migrationFormats);
  if (codemodding && (!values.format || !codemodFormats.includes(values.format))) throw formatError('format', 'codemod requires a supported format; run nordbeam-locale --help for the complete list.', values.format, codemodFormats);
  if ((values['messages-object'] !== undefined || values['custom-call'] !== undefined) && !codemodding && !migratingProject) throw usageError('--messages-object and --custom-call are available with nordbeam-locale codemod or migrate-project.');
  if (values['messages-import'] !== undefined && !codemodding) throw usageError('--messages-import is available with nordbeam-locale codemod.');
  if (values['move-type-import'] !== undefined && !codemodding) throw usageError('--move-type-import is available with nordbeam-locale codemod.');
  if (values['messages-hook'] !== undefined && !codemodding) throw usageError('--messages-hook is available with nordbeam-locale codemod.');
  if (values.notes !== undefined && !migrating) throw usageError('--notes is available with nordbeam-locale migrate. Set "notes" in the config for the project\'s notes file.');
  if (values['messages-hook'] !== undefined && !values['messages-import']) throw usageError('--messages-hook requires --messages-import, the module that exports the hook.');
  if (values['move-type-import']?.length && !values['messages-import']) throw usageError('--move-type-import requires --messages-import as the explicit replacement type module.');
  if (values['message-id-map'] !== undefined && !migratingProject && !codemodding) throw usageError('--message-id-map is available with nordbeam-locale migrate-project or codemod.');
  if (values['initial-locale-expression'] !== undefined && !migratingProject) throw usageError('--initial-locale-expression is available with nordbeam-locale migrate-project.');
  if (values.write !== undefined && !codemodding && !migratingProject && !scanningText) throw usageError('--write is available with nordbeam-locale codemod, migrate-project, or hardcoded.');
  if ((values.fix !== undefined || values.extract !== undefined || values.confidence !== undefined) && !scanningText) throw usageError('--fix, --extract and --confidence are available with nordbeam-locale hardcoded.');
  if (scanningText && values.write && !values.fix && !values.extract) throw usageError('hardcoded --write applies a fix: add --fix to reuse catalog messages, or --extract to add new ones too.', { option: '--write' });
  if (values.confidence !== undefined && values.confidence !== 'high' && values.confidence !== 'medium') throw usageError('--confidence must be "high" or "medium".', { option: '--confidence', value: values.confidence, validValues: ['high', 'medium'] });
  if (values.regenerate !== undefined && scanningText && !values.write) throw usageError('--regenerate applies with hardcoded --write.', { option: '--regenerate' });
  if (values.plan !== undefined && !codemodding) throw usageError('--plan is available with nordbeam-locale codemod.');
  if (codemodding && values.plan && values.write) throw usageError('Create a reviewed plan or apply immediately with --write; do not combine --plan and --write.');
  if (values['from-locale'] !== undefined && !pseudolocalizing) throw usageError('--from-locale is available with nordbeam-locale pseudo.');
  if (values.expansion !== undefined && !pseudolocalizing) throw usageError('--expansion is available with nordbeam-locale pseudo.');
  if (values.update !== undefined && !pseudolocalizing) throw usageError('--update is available with nordbeam-locale pseudo.');
  if (values['schema-dir'] !== undefined && !writingSchemas) throw usageError('--schema-dir is available with nordbeam-locale schema.');
  if (inspecting && values.id !== undefined && values.ndjson) throw usageError('inspect --id prints one message, as JSON or as text; it does not stream NDJSON.');
  if (values.agent !== undefined && !init) throw usageError('--agent is available with nordbeam-locale init.');
  if (values.target !== undefined || values.skill !== undefined) throw usageError('--target and --skill are available with nordbeam-locale skills install.');
  if (writingReport && (values.only !== undefined || values.summary !== undefined)) throw usageError('report accepts --limit for its JSON lists, but not --only or --summary.');
  if (scanningText && (values.only !== undefined || values.summary !== undefined)) throw usageError('hardcoded accepts --limit for its lists, but not --only or --summary.');
  if ((values.limit !== undefined || values.only !== undefined || values.summary !== undefined) && !reporting && !writingReport && !scanningText) throw usageError('--limit, --only and --summary are available with nordbeam-locale check, doctor, generate, inspect, or verify.');
  const reportShape = { ...parseLimit(values.limit), ...(values.only === undefined ? {} : { only: parseOnly(values.only) }), summary: !!values.summary };
  if (applyingPlan && !values.from) throw usageError('apply-plan requires --from <reviewed-plan.json>.');
  if (pseudolocalizing && !values.locale) throw usageError('pseudo requires --locale en-XA.');
  if (values.development && values.production) throw usageError('Choose either --development or --production, not both.');
  if (values.production && !generating && !init && !migratingProject) throw usageError('--production is available with nordbeam-locale generate, init, or migrate-project.');
  const renameFrom = values.id ?? positionals[1], renameTo = values.to ?? positionals[2];
  const extractId = values.id ?? positionals[1], extractMessageText = values.message ?? values['default-message'] ?? positionals[2];
  if (renaming && (!renameFrom || !renameTo)) throw usageError('rename requires --id old.id and --to new.id (or: rename old.id new.id).');
  if (extracting && (!extractId || extractMessageText === undefined)) throw usageError('extract requires --id message.id and --message "Source text" (or: extract message.id "Source text").');
  if (writingReport && (values.id !== undefined || values.to !== undefined || values.message !== undefined || values['default-message'] !== undefined)) throw usageError('report accepts --source-dir, --out, --open, --limit and --json.');
  if (scanningText && (values.id !== undefined || values.to !== undefined || values.message !== undefined || values['default-message'] !== undefined)) throw usageError('hardcoded accepts --source-dir, --confidence, --fix, --extract, --write, --strict, --limit and --json.');
  if (!renaming && !extracting && !pruning && !doctoring && !inspecting && !codemodding && !migratingProject && !writingReport && !scanningText && (values.id !== undefined || values.to !== undefined || values.message !== undefined || values['default-message'] !== undefined || values['source-dir'] !== undefined)) throw usageError('--id, --to, --message and --source-dir are available with rename, extract, prune, doctor, codemod, or migrate-project.');
  if ((pruning || doctoring) && (values.id !== undefined || values.to !== undefined || values.message !== undefined || values['default-message'] !== undefined)) throw usageError('prune and doctor accept only --source-dir and --dry-run/--json.');
  if (exporting || importing) {
    if (!values.locale) throw usageError('Choose a target locale with --locale, for example --locale fr.');
    if (importing && !values.from) throw usageError('Choose a PO input file with --from, for example --from fr.po.');
    if (values.watch || values.development !== undefined || values['out-dir'] !== undefined || exporting && values.strict) throw usageError('Translation commands do not accept --watch, --development or --out-dir; --strict applies to import validation.');
  }
  if (checking && values.watch) throw usageError('nordbeam-locale check is a one-shot validation command. Use nordbeam-locale --watch for generation and repair.');
  if (init && values.watch) throw usageError('Run nordbeam-locale init first, then nordbeam-locale --watch.');
  if (values.json && values.watch) throw usageError('Use --ndjson for watch mode so every rebuild is a separate event sequence.');
  if ((importing || migrating || migratingProject) && !existsSync(resolve(values.from!))) throw new CliError('FILE_NOT_FOUND', `Input not found: ${displayPath(resolve(values.from!))}.`, { path: displayPath(resolve(values.from!)) });
  if (values.ndjson && !values.watch) await eventStart(operationCommand);
  if (applyingPlan) {
    const { applyPlan, parsePlan } = await import('./plan-apply.js');
    const plan = parsePlan(await readFile(resolve(values.from!), 'utf8'));
    const result = await applyPlan(plan);
    if (values.ndjson) await eventResult('apply-plan', result as unknown as Record<string, unknown>);
    else if (values.json) jsonSuccess(result as unknown as Record<string, unknown>);
    else if (result.status === 'already-applied') console.log(`nordbeam-locale: plan ${result.planHash} is already applied — nothing to do.`);
    else console.log(`nordbeam-locale: applied plan ${result.planHash} — ${plural(result.changed.length, 'file')} updated.`);
    return;
  }
  const configFile = values.config ? resolve(values.config) : await discoverConfig(process.cwd());
  if (values.config && !init && !existsSync(configFile)) throw new CliError('FILE_NOT_FOUND', `Configuration file not found: ${displayPath(configFile)}.`, { path: displayPath(configFile) });
  const loaded = await readConfig(configFile, !!values.config && !init).catch(error => { throw new CompileError([{ code: 'INVALID_CONFIG', message: (error as Error).message, file: configFile }]); });
  // Machine output keeps stderr empty, so notices are for human-readable runs only.
  const human = !values.json && !values.ndjson;
  if (human) for (const notice of loaded ? configWarnings(loaded, displayPath(configFile)) : []) warn(`${notice.code}: ${notice.message}`);
  const config = loaded ?? {};
  const initModule = init ? await import('./init.js') : undefined;
  const detectedCatalogs = initModule && values.catalogs === undefined && config.catalogs === undefined
    ? await initModule.detectCatalogDirectory(dirname(configFile)) : undefined;
  const detectedFramework = initModule && values.framework === undefined ? await initModule.detectFramework(dirname(configFile)) : undefined;
  // Runtime mode is chosen by the invoking command, not the persisted config.
  // Production builds should set NODE_ENV=production or pass --production; an
  // unset NODE_ENV keeps the development output that the CLI has always produced.
  const development = values.development ?? (values.production ? false : process.env.NODE_ENV !== 'production');
  if (human && process.env.NODE_ENV === undefined && values.development === undefined && !values.production && (generating || (init && !(values.agent && loaded)) || migratingProject)) {
    console.error('nordbeam-locale: NODE_ENV is unset, so development output with argument guards is generated. For production builds, set NODE_ENV=production or pass --production.');
  }
  eventRoot = dirname(configFile);
  const options: GenerateOptions = {
    ...config,
    root: dirname(configFile),
    baseLocale: values['base-locale'] ?? config.baseLocale ?? 'en',
    catalogs: values.catalogs ?? config.catalogs ?? detectedCatalogs ?? 'messages',
    outDir: values['out-dir'] ?? config.outDir ?? 'src/i18n',
    development,
    // Migration strictness means "rewrite or diagnose". It must not silently
    // strengthen the independent catalog fallback policy.
    // An explicit undefined would change the generation digest, so `verify` would call output from a bundler plugin stale.
    ...(values.strict && !codemodding && !migratingProject ? { missing: 'error' as const } : config.missing === undefined ? {} : { missing: config.missing }),
  };
  const root = options.root!;
  const shape: ReportOptions = { ...reportShape, baseLocale: options.baseLocale };
  if (writingReport) {
    requireCatalogs(options);
    const { buildReport } = await import('./report.js');
    const report = await buildReport({ ...options, sourceDir: values['source-dir'] }, configFile, loaded);
    let file: string | undefined;
    if (!values.json || values.out !== undefined) {
      const { renderReportPage } = await import('./report-page.js');
      const page = renderReportPage(report);
      if (values.out === '-') process.stdout.write(page);
      else {
        file = values.out === undefined ? resolve(root, 'nordbeam-locale-report.html') : resolve(values.out);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, page);
      }
    }
    const { summary } = report;
    const line = `nordbeam-locale: report on ${plural(summary.messages, 'message')} in ${plural(summary.locales, 'locale')} — `
      + `${summary.locales > 1 ? `${(Math.floor(summary.coverage * 1000) / 10).toString()}% translated, ` : ''}`
      + `${summary.sourceFiles ? `${summary.unused} unused, ` : ''}${report.hardcoded.high ? `${plural(report.hardcoded.high, 'hardcoded string')}, ` : ''}${plural(summary.errors, 'error')}, ${plural(summary.warnings, 'warning')}.`;
    if (values.json) jsonSuccess({ ...(file ? { file } : {}), ...reportJson(report, reportShape.limit) });
    else if (file) {
      console.log(line);
      console.log(`→ ${pagePath(file)}${values.open ? '' : ' (open it in a browser, or add --open)'}`);
    } else console.error(line);
    if (values.open && file) openPage(file);
    return;
  }
  if (scanningText) {
    requireCatalogs(options);
    await hardcodedCommand({ ...options, sourceDir: values['source-dir'], text: config.text }, values, reportShape.limit, root);
    return;
  }
  if (inspecting) {
    const { inspectProject, inspectMessage, baseMessageIds } = await import('./inspect.js');
    if (values.id !== undefined) {
      requireCatalogs(options);
      const message = await inspectMessage(options, values.id);
      if (!message.found) {
        const near = suggest(values.id, await baseMessageIds(options));
        throw new CliError('UNKNOWN_MESSAGE_ID', `Unknown message ID ${JSON.stringify(values.id)}${near ? `, did you mean ${near}?` : '.'} Message IDs are the keys of the base catalog.`, { id: values.id, ...(near ? { suggestion: near } : {}) });
      }
      if (values.json) jsonSuccess({ root, ...relativePaths(message, root) });
      else printMessage(message, root);
      if (!message.found) process.exitCode = 1;
      return;
    }
    const result = await inspectProject(options, configFile, loaded);
    const report = inspectReport(result, shape, root);
    if (values.ndjson) await eventResult('inspect', report, undefined, (report.diagnostics ?? report) as { errors?: unknown; warnings?: unknown });
    else if (values.json) jsonSuccess(report);
    else {
      const lists = humanLists(result.diagnostics.errors, result.diagnostics.warnings, shape);
      printLists(lists, shape, `nordbeam-locale: ${plural(result.messageCount, 'message')} in ${plural(result.locales.length, 'locale')} — ${plural(lists.summary.errors, 'error')}, ${plural(lists.summary.warnings, 'warning')}.`);
      console.log(`generated output ${displayPath(result.generated.directory, root)}: ${result.freshness.status}${result.freshness.next ? `. Next: ${result.freshness.next}` : ''}`);
    }
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (verifying) {
    requireCatalogs(options);
    const { inspectProject } = await import('./inspect.js');
    const result = await inspectProject(options, configFile, loaded);
    const { freshness } = result;
    const problem = freshnessProblem(freshness);
    const lists = humanLists([...result.diagnostics.errors, ...(problem ? [problem] : [])], result.diagnostics.warnings, shape);
    const ok = result.ok && !problem;
    const staleReason = capList(freshness.staleReason, shape.limit), modifiedFiles = capList(freshness.modifiedFiles, shape.limit);
    const truncated = { ...lists.truncated, ...(staleReason.omitted ? { staleReason: staleReason.omitted } : {}), ...(modifiedFiles.omitted ? { modifiedFiles: modifiedFiles.omitted } : {}) };
    const body = {
      ok,
      summary: lists.summary,
      freshness: { status: freshness.status, ...(freshness.next ? { next: freshness.next } : {}), staleReason: staleReason.items, modifiedFiles: modifiedFiles.items },
      errors: lists.errors,
      ...(Object.keys(truncated).length ? { truncated } : {}),
    };
    if (values.json) jsonSuccess({ root, ...relativePaths(body, root) });
    else {
      // Verify reports problems only: warnings are counted in the summary but not printed.
      for (const item of lists.errors) console.error(paint(process.stderr, 'red', `${'file' in item && item.file ? `${displayPath(item.file, root)}: ` : ''}${item.code}: ${item.message}`));
      console.log(paint(process.stdout, ok ? 'green' : 'red', ok
        ? `nordbeam-locale: verified — ${plural(result.messageCount, 'message')} in ${plural(result.locales.length, 'locale')}, generated output is fresh.`
        : `nordbeam-locale: verify failed — ${plural(lists.summary.errors, 'problem')}.`));
      const hint = truncationHint(lists.truncated);
      if (hint) console.log(hint);
      if (!ok) console.log(`Next: ${freshness.status === 'fresh' ? 'nordbeam-locale check' : freshness.next ?? 'nordbeam-locale'}`);
    }
    if (!ok) process.exitCode = 1;
    return;
  }
  const customCalls = values['custom-call']?.map((value: string) => {
    const [callee, namespace] = value.split(':', 2);
    if (!callee || !/^(?:[A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)*$/.test(callee)) throw usageError(`Invalid --custom-call ${JSON.stringify(value)}; use callee or callee:namespace.`, { option: '--custom-call', value });
    return { callee, ...(namespace ? { namespace } : {}) };
  });
  if (migratingProject) {
    const { migrateProject } = await loadMigrate('migrate-project');
    const result = await migrateProject({
      ...options,
      catalogs: values.catalogs ?? (loaded ? config.catalogs ?? 'messages' : 'messages-nordbeam'),
      from: values.from!,
      format: values.format as CodemodFormat,
      catalogFormat: values['catalog-format'] as MigrationFormat | undefined,
      locale: values.locale,
      framework: values.framework as InitFramework | undefined,
      sourceDir: values['source-dir'],
      messagesObject: values['messages-object'],
      messageIdBySourceFile: values['message-id-map'],
      customCalls,
      initialLocaleExpression: values['initial-locale-expression'],
      strict: values.strict,
      write: values.write,
      configFile,
    });
    if (values.ndjson) await eventResult('migrate-project', result as unknown as Record<string, unknown>);
    else if (values.json) jsonSuccess(result as unknown as Record<string, unknown>);
    else {
      console.log(`nordbeam-locale: ${result.dryRun ? 'migration preview' : 'project migrated'} — ${plural(result.catalogs.length, 'locale')}, ${plural(result.codemod.replacements, 'source call')}, ${plural(result.generatedFiles.length, 'generated file')}.`);
      for (const catalog of result.catalogs) console.log(`${mark(result.dryRun)} ${catalog.locale}: ${plural(catalog.messageCount, 'message')} → ${catalog.destination}`);
      for (const file of result.scaffoldFiles) console.log(`${mark(result.dryRun)} scaffold ${file}`);
      for (const file of result.configFiles) console.log(`${mark(result.dryRun)} config ${file}`);
      for (const file of result.packageEdits) console.log(`${mark(result.dryRun)} package edit ${file}`);
      if (result.integration) console.log(`${mark(result.dryRun)} ${result.integration.kind} integration: ${result.integration.filesChanged} of ${plural(result.integration.filesScanned, 'file')}, ${plural(result.integration.replacements, 'call')}, ${plural(result.integration.skipped.length, 'skip')}.`);
      for (const action of result.manualActions) console.log(paint(process.stdout, 'yellow', `! ${action}`));
      if (result.dryRun) console.log('No files changed. Re-run with --write after reviewing this report.');
    }
    return;
  }
  if (writingSchemas) {
    const { writeEditorSchemas } = await import('./cli-tools.js');
    const result = await writeEditorSchemas({ ...options, directory: values['schema-dir'] });
    if (values.json) jsonSuccess(result as unknown as Record<string, unknown>);
    else console.log(`nordbeam-locale: wrote editor schemas for ${plural(result.messageCount, 'message')} → ${displayPath(result.directory)}`);
    return;
  }
  if (codemodding) {
    const { codemodProject } = await loadMigrate('codemod');
    const { serializePlan } = await import('./plan-apply.js');
    const result = await codemodProject({ root: options.root, sourceDir: values['source-dir'], format: values.format as CodemodFormat, messagesObject: values['messages-object'], messagesImport: values['messages-import'], messagesHook: values['messages-hook'], moveTypeImports: values['move-type-import'], customCalls, messageIdBySourceFile: values['message-id-map'], write: values.write, plan: !!values.plan, strict: values.strict, requireMessagesBinding: values.strict ? true : 'warn' });
    const { plan, ...report } = result;
    let planFile: string | undefined;
    if (values.plan && plan) {
      planFile = resolve(values.plan);
      await mkdir(dirname(planFile), { recursive: true });
      await writeFile(planFile, serializePlan(plan), { flag: 'wx' });
    }
    const output = { ...report, ...(plan ? { plan: { protocolVersion: plan.protocolVersion, toolVersion: plan.toolVersion, planHash: plan.planHash, affectedPaths: plan.affectedPaths }, planFile } : {}) };
    if (values.ndjson) await eventResult('codemod', output as unknown as Record<string, unknown>);
    else if (values.json) jsonSuccess(output as unknown as Record<string, unknown>);
    else {
      console.log(`nordbeam-locale: ${result.dryRun ? 'would rewrite' : 'rewrote'} ${plural(result.replacements, 'call')} and moved ${plural(result.typeImportsMoved, 'type import')} in ${result.changed.length} of ${plural(result.filesScanned, 'file')}.`);
      for (const change of result.changed) console.log(`${mark(result.dryRun)} ${displayPath(change.file)} (${plural(change.replacements, 'call')}, ${plural(change.typeImportsMoved, 'type import')})`);
      for (const item of result.warnings ?? []) warn(`! ${item.file ? displayPath(item.file) : ''}:${item.line ?? 0}:${item.column ?? 1} [${item.code}] — ${item.reason}\n  ${item.action ?? ''}`.trimEnd());
      for (const skip of result.skipped) warn(`! ${skip.file ? displayPath(skip.file) : ''}:${skip.line !== undefined ? `${skip.line}:${skip.column ?? 1}` : skip.offset ?? 0} ${skip.callee} [${skip.code ?? 'MANUAL_REVIEW'}] — ${skip.reason}\n  ${skip.action ?? ''}`.trimEnd());
      if (planFile) console.log(`Plan written to ${displayPath(planFile)}. Review it, then run nordbeam-locale apply-plan --from ${displayPath(planFile)}.`);
      if (result.dryRun && result.replacements) console.log('Preview only. Re-run with --write after reviewing the report.');
    }
    return;
  }
  if (pseudolocalizing) {
    const { pseudoCatalog } = await import('./cli-tools.js');
    const expansion = values.expansion === undefined ? undefined : Number(values.expansion);
    if (expansion !== undefined && !Number.isFinite(expansion)) throw usageError('--expansion must be a finite number between 0 and 5.', { option: '--expansion', value: values.expansion });
    const result = await pseudoCatalog({ ...options, locale: values.locale!, fromLocale: values['from-locale'], expansion, dryRun: values['dry-run'], update: values.update });
    if (values.json) jsonSuccess(result as unknown as Record<string, unknown>);
    else console.log(`nordbeam-locale: ${result.dryRun ? 'previewed' : 'generated'} pseudo locale ${result.locale} from ${result.fromLocale} — ${plural(result.messageCount, 'message')}${result.written ? ` written to ${displayPath(result.catalogFile)}` : ''}.`);
    return;
  }
  if (renaming) {
    const { renameMessage } = await import('./cli-tools.js');
    const result = await renameMessage({ ...options, from: renameFrom!, to: renameTo!, sourceDir: values['source-dir'], regenerate: values.regenerate });
    if (values.json) jsonSuccess(result as unknown as Record<string, unknown>);
    else {
      console.log(`nordbeam-locale: renamed ${renameFrom} → ${renameTo} — ${plural(result.changed.length, 'file')} updated, ${plural(result.references.length, 'source file')} updated.`);
      for (const warning of result.warnings ?? []) warn(`${warning.file ? displayPath(warning.file) : ''}${warning.location ? `:${warning.location.line}:${warning.location.column}` : ''} [${warning.code}] ${warning.message}`);
      if (result.stale) console.log(`Run ${result.next} to refresh generated output, or pass --regenerate.`);
    }
    return;
  }
  if (extracting) {
    const { extractMessage } = await import('./cli-tools.js');
    const result = await extractMessage({ ...options, id: extractId!, message: extractMessageText!, locale: values.locale, regenerate: values.regenerate });
    if (values.json) jsonSuccess(result as unknown as Record<string, unknown>);
    else {
      console.log(`nordbeam-locale: extracted ${extractId} into ${values.locale ?? options.baseLocale} — ${plural(result.changed.length, 'file')} updated.`);
      if (result.stale) console.log(`Run ${result.next} to refresh generated output, or pass --regenerate.`);
    }
    return;
  }
  if (pruning) {
    const { pruneMessages } = await import('./cli-tools.js');
    const result = await pruneMessages({ ...options, sourceDir: values['source-dir'], dryRun: values['dry-run'] });
    if (values.json) jsonSuccess(result as unknown as Record<string, unknown>);
    else {
      console.log(`nordbeam-locale: ${plural(result.unused.length, 'potentially unused message', 'potentially unused messages')} across ${plural(result.sourceFiles, 'source file')}.`);
      for (const id of result.unused) console.log(`- ${id}`);
      console.log('No files changed. Dynamic keys may be intentionally absent from this report.');
    }
    return;
  }
  if (doctoring) {
    const { doctor } = await import('./cli-tools.js');
    const result = await doctor({ ...options, sourceDir: values['source-dir'] });
    const report = machineReport(result as unknown as Record<string, unknown>, shape, root);
    if (values.ndjson) await eventResult('doctor', report);
    else if (values.json) jsonSuccess(report);
    else {
      const lists = humanLists(result.errors, result.warnings, shape);
      printLists(lists, shape, `nordbeam-locale: doctor found ${plural(lists.summary.errors, 'error')}, ${plural(lists.summary.warnings, 'warning')} — ${plural(result.messageCount, 'message')}, ${plural(result.locales.length, 'locale')}, ${plural(result.sourceFiles, 'source file')}.`);
    }
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (migrating) {
    const { migrateCatalog } = await loadMigrate('migrate');
    const result = await migrateCatalog({
      from: values.from!,
      format: values.format as MigrationFormat,
      out: values.out,
      notes: values.notes,
      dryRun: values['dry-run'],
      locale: values.locale,
    });
    if (values.ndjson) await eventResult('migrate', result as unknown as Record<string, unknown>);
    else if (values.json) jsonSuccess(result as unknown as Record<string, unknown>);
    else {
      printDiagnostics(result.warnings, 'yellow');
      for (const collision of result.collisions) fail(`${collision.code}: ${collision.message}`);
      if (result.destination) console.log(`nordbeam-locale: ${result.dryRun ? 'previewed' : result.changed.length ? 'migrated' : 'no changes'} ${plural(result.messageCount, 'message')} → ${displayPath(result.destination)}`);
      if (result.notesDestination) console.log(`nordbeam-locale: ${result.dryRun ? 'previewed' : 'wrote'} ${plural(Object.keys(result.notes).length, 'note')} → ${displayPath(result.notesDestination)}`);
      else if (result.ok) process.stdout.write(result.output);
      else fail('nordbeam-locale: migration produced no output because collisions must be resolved first.');
      if (result.dryRun) console.error('No files changed. Remove --dry-run to write a new output file.');
    }
    if (!result.ok) process.exitCode = result.collisions.some(item => item.code === 'MIGRATION_OUTPUT_EXISTS') ? exitCodes.refused : exitCodes.validation;
    return;
  }
  if (exporting || importing) {
    const { exportPo, importPo } = await import('./translations.js');
    if (exporting) {
      const result = await exportPo({ ...options, locale: values.locale! });
      let destination: string | undefined;
      if (values.out && values.out !== '-') {
        destination = resolve(values.out);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, result.po, { flag: 'wx' });
      } else if (!values.json) process.stdout.write(result.po);
      if (values.json) jsonSuccess({ locale: result.locale, messageCount: result.messageCount, translatedCount: result.translatedCount, destination, ...(destination ? {} : { output: result.po }) });
      else console.error(`nordbeam-locale: exported ${plural(result.messageCount, 'message')} for ${result.locale}, ${result.translatedCount} already translated.`);
    } else {
      const result = await importPo({ ...options, locale: values.locale!, from: resolve(values.from!), dryRun: values['dry-run'] });
      if (values.json) jsonSuccess(result as unknown as Record<string, unknown>);
      else {
        printDiagnostics(result.warnings, 'yellow');
        console.log(`nordbeam-locale: ${result.dryRun ? 'preview' : result.written ? 'imported' : 'no changes'} — ${result.added.length} added, ${result.updated.length} updated, ${result.unchanged} unchanged; skipped ${result.skipped.fuzzy} fuzzy, ${result.skipped.untranslated} untranslated, ${result.skipped.obsolete} obsolete.`);
        const changes = [...result.added.map(id => `+ ${id}`), ...result.updated.map(id => `~ ${id}`)];
        for (const line of changes.slice(0, 20)) console.log(line);
        if (changes.length > 20) console.log(`… ${changes.length - 20} more changes. Use --dry-run --json for every ID.`);
        console.log(displayPath(result.catalogFile));
      }
    }
    return;
  }
  if (checking) {
    requireCatalogs(options);
    const result = await check(options).catch(error => { throw displayCliError(error, options); });
    const report = machineReport(result as unknown as Record<string, unknown>, shape, root);
    if (values.ndjson) await eventResult('check', report);
    else if (values.json) jsonSuccess(report);
    else {
      const lists = humanLists(result.errors, result.warnings, shape);
      printLists(lists, shape, `nordbeam-locale: checked ${plural(result.messageCount, 'message')} in ${plural(result.locales.length, 'locale')} — ${plural(lists.summary.errors, 'error')}, ${plural(lists.summary.warnings, 'warning')}.`);
    }
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (init) {
    if (values.agent && loaded) {
      // An existing configuration is left alone; only the agent instructions are written.
      const agentFiles = await initModule!.writeAgentInstructions(options.root!, options);
      const agentSkills = (await installAgentSkills(options.root!)).skills;
      if (values.json) jsonSuccess({ root, ...relativePaths({ agentFiles, agentSkills }, root) });
      else {
        for (const item of agentFiles) console.log(`${agentVerb(item.action)} ${displayPath(item.file, root)}`);
        for (const entry of agentSkills) printSkillEntry(entry, root, false);
      }
      return;
    }
    if (loaded && (values.catalogs !== undefined || values['base-locale'] !== undefined || values['out-dir'] !== undefined || values.development !== undefined || values.strict !== undefined)) {
      throw new CliError('CONFIG_EXISTS', `Configuration already exists at ${displayPath(configFile)}. Edit that file, then run nordbeam-locale; init never replaces it.`, { path: displayPath(configFile) });
    }
    const result = await initModule!.initialize(options, configFile, loaded !== undefined, (values.framework as InitFramework | undefined) ?? detectedFramework);
    const agentFiles = values.agent ? await initModule!.writeAgentInstructions(options.root!, options) : undefined;
    const agentSkills = values.agent ? (await installAgentSkills(options.root!)).skills : undefined;
    if (values.json) {
      const { files: _files, groups: _groups, ...project } = result.project;
      jsonSuccess({ root, ...relativePaths({ ...result, project, ...(agentFiles ? { agentFiles } : {}), ...(agentSkills ? { agentSkills } : {}) }, root) });
      return;
    }
    for (const item of agentFiles ?? []) console.log(`${agentVerb(item.action)} ${displayPath(item.file, root)}`);
    for (const entry of agentSkills ?? []) printSkillEntry(entry, root, false);
    for (const file of result.created) console.log(`Created ${displayPath(file)}`);
    for (const file of result.updated ?? []) console.log(`Updated ${displayPath(file)}`);
    for (const file of result.frameworkCreated ?? []) console.log(`Created ${displayPath(file)}`);
    for (const file of result.frameworkExisting ?? []) console.log(`Preserved ${displayPath(file)}`);
    ok(`nordbeam-locale: ready — ${plural(result.project.locales.length, 'locale')}, ${plural(result.project.changed.length, 'generated file')} updated (${modeLabel(development)}).`);
    for (const warning of result.project.warnings) warn(`${warning.locale}:${warning.messageId}: ${warning.message}`);
    const configArg = values.config ? ` --config ${JSON.stringify(displayPath(configFile))}` : '';
    console.log(`\nEdit ${displayPath(resolve(options.root!, options.catalogs!))}/*.json\nGenerate: nordbeam-locale${configArg}\nWatch: nordbeam-locale${configArg} --watch`);
    const module = './' + displayPath(resolve(result.project.outDir, 'index.js'));
    console.log(`\nFrom the project directory:\nimport { loadLocale } from ${JSON.stringify(module)};\nconst { messages: m } = await loadLocale(${JSON.stringify(options.baseLocale)});`);
    if (result.seeded) console.log("m.greeting({ name: 'Ada' });\nm.items({ count: 3 });\n\nThe starter text is English; replace it with your base language.");
    console.log('\nVite: add nordbeamLocale() from "@nordbeam/locale/vite" to plugins. It reads nordbeam-locale.config.json at the Vite project root. For a custom config path, pass its options explicitly.');
    console.log('Next.js: wrap next.config.mjs with withNordbeamLocale() from "@nordbeam/locale/next"; it generates before builds and watches catalogs during next dev.');
    if (result.framework === 'vite-react') console.log(`\nVite React scaffold: import { i18n } from ${JSON.stringify('./' + displayPath(resolve(result.project.outDir, 'client.js')))} and wrap the app with <i18n.Provider initialLocale="${options.baseLocale}">.`);
    for (const note of result.frameworkNotes ?? []) console.log(`\nNext: ${note}`);
    const adapter = (file: string) => JSON.stringify('./' + displayPath(resolve(result.project.outDir, file)));
    if (result.framework === 'vue') console.log(`\nVue scaffold: import { i18n } from ${adapter('vue.js')} and call app.use(i18n) in the entry file.`);
    if (result.framework === 'svelte') console.log(`\nSvelte scaffold: import { i18n } from ${adapter('svelte.js')} and call setI18nContext(i18n) in the root component or layout.`);
    if (result.framework === 'solid') console.log(`\nSolid scaffold: import { i18n } from ${adapter('solid.js')} and wrap the app in <i18n.Provider>.`);
    if (result.framework === 'tanstack-start') {
      console.log(`\nTanStack Start scaffold: import { i18n } from ${adapter('tanstack.js')}; its routing is in ${adapter('routing.js')}. Wire the router, start.ts and the root route as described above, then use <Link> as usual: links follow the page's locale.`);
    }
    if (result.framework === 'next') {
      console.log(`\nNext.js scaffold: import { i18n } from ${JSON.stringify('./' + displayPath(resolve(result.project.outDir, 'next.js')))} in your [locale] route and use i18n.generateStaticParams().`);
      // The request file and routing module were created above; say what each one does next.
      const created = result.frameworkCreated ?? [];
      const request = created.find(file => /(^|\/)(proxy|middleware)\.ts$/.test(file));
      const routing = created.find(file => /(^|\/)routing\.ts$/.test(file));
      if (request) console.log(`Next.js request boundary: ${displayPath(request)} sets the locale for each request${request.endsWith('middleware.ts') ? ' (Next.js 15 and earlier uses middleware.ts; Next.js 16 uses proxy.ts)' : ''}.`);
      if (routing) console.log(`Shared routing: ${displayPath(routing)} is used by the request file and App Router links; edit it to change supported locales.`);
    }
    if (!values.agent) console.log('\nAdd agent instructions and skills with nordbeam-locale init --agent');
    return;
  }
  const run = values.watch ? createGenerator(options) : () => generate(options);
  const modeText = modeLabel(development);
  async function build(): Promise<void> {
    const started = performance.now();
    if (values.ndjson && values.watch) { operationId = randomUUID(); await eventStart('generate'); }
    let result: Awaited<ReturnType<typeof run>>;
    try { requireCatalogs(options); result = await run(); }
    catch (error) { throw displayCliError(error, options); }
    const { files: _files, groups: _groups, ...report } = result;
    const machine = machineReport(report as unknown as Record<string, unknown>, shape, root);
    if (values.ndjson) await eventResult('generate', machine);
    else if (values.json) jsonSuccess(machine);
    else {
      const stamp = new Date().toISOString();
      const duration = Math.max(0, Math.round(performance.now() - started));
      ok(`[${stamp}] nordbeam-locale: ${plural(result.locales.length, 'locale')}, ${plural(result.changed.length, 'file')} updated in ${duration}ms → ${displayPath(result.outDir)} (${modeText})`);
      const lists = humanLists([], result.warnings, shape);
      printDiagnostics(lists.warnings, 'yellow');
      const hint = truncationHint(lists.truncated);
      if (hint) console.log(hint);
    }
  }
  if (!values.watch) { await build(); return; }
  if (!values.ndjson) console.log(`nordbeam-locale watch — watching ${displayPath(resolve(options.root!, options.catalogs!))} (Ctrl-C to stop)`);
  // Keep the repair loop available when watch mode starts with a broken catalog.
  try { await build(); } catch (error) { if (values.ndjson) { operationId = randomUUID(); await eventError('generate', error); } else fail((error as Error).message); }
  let timer: ReturnType<typeof setTimeout>;
  let queue = Promise.resolve();
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { queue = queue.then(build).catch(async error => { if (values.ndjson) { operationId = randomUUID(); await eventError('generate', error); } else fail((error as Error).message); }); }, 50);
  };
  let watcher, notesWatcher: ReturnType<typeof watch> | undefined;
  try {
    watcher = watch(resolve(options.root!, options.catalogs!), (_event, file) => {
      if (file && !file.endsWith('.json')) return;
      schedule();
    });
    // The directory, because editors that save by renaming end a watch on the file.
    const notes = notesFile(options);
    if (notes) notesWatcher = watch(dirname(notes), (_event, file) => { if (!file || file === basename(notes)) schedule(); });
  } catch (error) { throw displayCliError(error, options); }
  const close = () => { clearTimeout(timer); watcher.close(); notesWatcher?.close(); };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

main().catch(async error => {
  const failure = await failureOf(error);
  if (ndjsonAny) await eventError(operationCommand, error);
  else if (jsonAny) jsonError(failure.diagnostics.map(withGuidance), operationCommand === 'check' ? { warnings: [], locales: [], messageCount: 0, catalogFiles: [] } : {});
  else fail(failure.message);
  process.exitCode = failure.exitCode;
});
