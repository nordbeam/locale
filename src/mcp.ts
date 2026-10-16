import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, relative, resolve, sep } from 'node:path';
import { discoverConfig, readConfig } from './config.js';
import { CliError, errorCodeEntry, errorCodes } from './error-codes.js';
import type { GenerateOptions } from './project.js';
import type { Diagnostic } from './compiler.js';

/** Model Context Protocol server over stdio: newline-delimited JSON-RPC 2.0. stdout carries protocol messages only. */

export interface McpOptions {
  root?: string;
  config?: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

interface ToolContext { root: string; config?: string }

interface Property {
  type: 'string' | 'boolean' | 'integer';
  description: string;
  minLength?: number;
  minimum?: number;
  maximum?: number;
  default?: string | number | boolean;
}

interface InputSchema {
  type: 'object';
  properties: Record<string, Property>;
  required?: string[];
  additionalProperties: false;
}

export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: InputSchema;
  outputSchema: { type: 'object'; properties: Record<string, unknown>; additionalProperties: true };
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: false };
  run: (args: Record<string, unknown>, context: ToolContext) => Promise<Record<string, unknown>>;
}

const protocolVersions = ['2025-06-18', '2025-03-26', '2024-11-05'];
const latestProtocolVersion = '2025-06-18';
const instructions = 'Nordbeam Locale compiles ICU MessageFormat catalogs into typed messages. Run check after editing catalogs and generate once it passes. Call inspect_message before changing a message and rename_message to rename an ID across catalogs and source. Call explain_code for any diagnostic code to get its cause and fix.';
let serverVersion: string | undefined;

/** A tool failure reported with isError: true, not as a JSON-RPC error. */
class ToolError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/** A protocol problem reported as a JSON-RPC error object. */
class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is string | number | null => typeof value === 'string' || typeof value === 'number' || value === null;
const rpcFailure = (id: string | number | null, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

const projectPath = (file: string | undefined, root: string) => file === undefined ? undefined : relative(root, file).split(sep).join('/');

/** Diagnostic fields an agent needs to act: the code, its location in the project and the registry fix. */
function compact(diagnostic: Diagnostic, root: string) {
  const entry = errorCodeEntry(diagnostic.code);
  return {
    code: diagnostic.code,
    message: diagnostic.message,
    locale: diagnostic.locale,
    messageId: diagnostic.messageId,
    file: projectPath(diagnostic.file, root),
    line: diagnostic.location?.line,
    column: diagnostic.location?.column,
    hint: diagnostic.hint,
    fix: entry?.fix,
    docs: entry?.docs,
  };
}

/** Maps any thrown value to the isError payload: code, message, and the registry fix and docs when the code is known. */
function failure(error: unknown, root: string): Record<string, unknown> {
  let payload: Record<string, unknown>;
  if (error instanceof ToolError || error instanceof CliError) payload = { code: error.code, message: error.message, ...error.details };
  else if (error instanceof Error && error.name === 'CompileError') {
    const diagnostics = (error as Error & { diagnostics?: Diagnostic[] }).diagnostics ?? [];
    payload = { code: diagnostics[0]?.code ?? 'VALIDATION_FAILED', message: diagnostics[0]?.message ?? error.message, errors: diagnostics.slice(0, 20).map(item => compact(item, root)) };
  } else if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
    const path = (error as NodeJS.ErrnoException).path;
    payload = { code: 'FILE_NOT_FOUND', message: (error as Error).message, ...(path ? { path: projectPath(path, root) } : {}) };
  } else {
    // As in the CLI: library code reports user-facing conditions with plain Error; anything else is a defect.
    const reported = error instanceof Error && Object.getPrototypeOf(error) === Error.prototype;
    payload = { code: reported ? 'COMMAND_FAILED' : 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) };
  }
  const entry = errorCodeEntry(String(payload.code));
  return entry ? { ...payload, fix: entry.fix, docs: entry.docs } : payload;
}

/** Re-read the configuration on every call, mirroring the CLI's option construction. */
async function loadProject(context: ToolContext) {
  const configFile = context.config === undefined
    ? await discoverConfig(context.root).catch(error => { throw new ToolError('INVALID_CONFIG', (error as Error).message); })
    : resolve(context.root, context.config);
  const loaded = await readConfig(configFile, context.config !== undefined).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ToolError('FILE_NOT_FOUND', `Configuration file not found: ${configFile}.`);
    throw new ToolError('INVALID_CONFIG', (error as Error).message, { file: configFile });
  });
  const root = dirname(configFile);
  const options: GenerateOptions = {
    ...loaded,
    root,
    baseLocale: loaded?.baseLocale ?? 'en',
    catalogs: loaded?.catalogs ?? 'messages',
    outDir: loaded?.outDir ?? 'src/i18n',
    development: process.env.NODE_ENV !== 'production',
  };
  return { configFile, loaded, options, root };
}

const limitOf = (args: Record<string, unknown>, fallback: number) => (args.limit as number | undefined) ?? fallback;
const limitProperty = (fallback: number): Property => ({ type: 'integer', description: `Maximum entries to return. Default ${fallback}.`, minimum: 1, maximum: 1000, default: fallback });
const schema = (properties: Record<string, Property>, required?: string[]): InputSchema => ({ type: 'object', properties, ...(required ? { required } : {}), additionalProperties: false });
const output = (properties: Record<string, unknown>) => ({
  type: 'object' as const,
  properties: { ...properties, code: { type: 'string' }, message: { type: 'string' }, fix: { type: 'string' }, docs: { type: 'string' } },
  additionalProperties: true as const,
});
const annotations = (readOnlyHint: boolean, destructiveHint: boolean, idempotentHint: boolean) => ({ readOnlyHint, destructiveHint, idempotentHint, openWorldHint: false as const });
const bool = { type: 'boolean' }, int = { type: 'integer' }, str = { type: 'string' };
const diagnostics = { type: 'array', items: { type: 'object' } };
const strings = { type: 'array', items: { type: 'string' } };

/** Validates arguments against the tool's input schema. Returns a problem description, or undefined when valid. */
function validate(inputSchema: InputSchema, args: Record<string, unknown>): string | undefined {
  for (const key of inputSchema.required ?? []) if (args[key] === undefined) return `${key} is required`;
  for (const [key, value] of Object.entries(args)) {
    const property = inputSchema.properties[key];
    if (!property) return `unknown argument ${key}`;
    if (value === undefined) continue;
    if (property.type === 'integer' ? !Number.isInteger(value) : typeof value !== property.type) return `${key} must be ${property.type === 'integer' ? 'an integer' : `a ${property.type}`}`;
    if (typeof value === 'string' && property.minLength !== undefined && value.length < property.minLength) return `${key} must not be empty`;
    if (typeof value === 'number' && property.minimum !== undefined && value < property.minimum) return `${key} must be at least ${property.minimum}`;
    if (typeof value === 'number' && property.maximum !== undefined && value > property.maximum) return `${key} must be at most ${property.maximum}`;
  }
  return undefined;
}

/** Up to five codes whose name starts with the query, then those that contain it. */
function suggestCodes(query: string): string[] {
  if (!query) return [];
  const keys = Object.keys(errorCodes);
  const prefixed = keys.filter(key => key.startsWith(query));
  return [...prefixed, ...keys.filter(key => !prefixed.includes(key) && key.includes(query))].slice(0, 5);
}

export const mcpTools: McpTool[] = [
  {
    name: 'check',
    title: 'Check catalogs',
    description: 'Validate every catalog and message without writing files. Returns counts and the first diagnostics, each with its code, project-relative file and location, and the registry fix and docs.',
    inputSchema: schema({ limit: limitProperty(20) }),
    outputSchema: output({ ok: bool, errorCount: int, warningCount: int, errors: diagnostics, warnings: diagnostics }),
    annotations: annotations(true, false, true),
    async run(args, context) {
      const { options, root } = await loadProject(context);
      const { check } = await import('./project.js');
      const limit = limitOf(args, 20);
      const result = await check(options);
      return {
        ok: result.ok,
        errorCount: result.errors.length,
        warningCount: result.warnings.length,
        errors: result.errors.slice(0, limit).map(item => compact(item, root)),
        warnings: result.warnings.slice(0, limit).map(item => compact(item, root)),
      };
    },
  },
  {
    name: 'generate',
    title: 'Generate messages',
    description: 'Write the generated runtime and types from the catalogs. Only compiler-owned files change. Run check first when catalogs may be invalid.',
    inputSchema: schema({}),
    outputSchema: output({ changed: strings, count: int, warnings: diagnostics }),
    annotations: annotations(false, false, true),
    async run(_args, context) {
      const { options, root } = await loadProject(context);
      const { generate } = await import('./project.js');
      const result = await generate(options);
      const changed = result.changed.map(file => projectPath(file, root)!);
      return { changed, count: changed.length, warnings: result.warnings.slice(0, 20).map(item => compact(item, root)) };
    },
  },
  {
    name: 'inspect_project',
    title: 'Inspect project',
    description: 'Summarize the project: locales, message count (entries across all catalogs), per-locale missing and untranslated counts, generated-output freshness and the config path.',
    inputSchema: schema({}),
    outputSchema: output({ ok: bool, config: str, baseLocale: str, locales: strings, messageCount: int, catalogs: { type: 'array', items: { type: 'object' } }, generated: { type: 'object' }, freshness: { type: 'object' }, errorCount: int, warningCount: int }),
    annotations: annotations(true, false, true),
    async run(_args, context) {
      const { configFile, loaded, options, root } = await loadProject(context);
      const { inspectProject } = await import('./inspect.js');
      // Output from a production build (the Vite or Next plugin) is fresh too, unless NODE_ENV names a mode.
      const result = await inspectProject(options, configFile, loaded, { anyMode: process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'development' });
      return {
        ok: result.ok,
        config: projectPath(configFile, root),
        baseLocale: options.baseLocale,
        locales: [...result.locales],
        messageCount: result.messageCount,
        catalogs: result.catalogs.map(catalog => ({
          locale: catalog.locale,
          messageCount: catalog.messageCount,
          missingCount: catalog.missingCount,
          untranslatedCount: catalog.untranslatedCount,
        })),
        generated: { status: result.generated.status },
        freshness: {
          status: result.freshness.status,
          ...(result.freshness.next === undefined ? {} : { next: result.freshness.next }),
          stale: result.freshness.staleReason.map(item => ({ input: item.input, message: item.message })),
        },
        errorCount: result.diagnostics.errors.length,
        warningCount: result.diagnostics.warnings.length,
      };
    },
  },
  {
    name: 'inspect_message',
    title: 'Inspect message',
    description: 'Describe one message ID across all catalogs: which locales have it or leave it untranslated, its arguments, and each locale\'s source text and position. An unknown ID is an error.',
    inputSchema: schema({ id: { type: 'string', minLength: 1, description: 'Message ID, as used in source calls.' } }, ['id']),
    outputSchema: output({ id: str, baseLocale: str, present: strings, missing: strings, untranslated: strings, arguments: { type: 'array', items: { type: 'object' } }, argumentsError: str, export: str, locales: { type: 'array', items: { type: 'object' } } }),
    annotations: annotations(true, false, true),
    async run(args, context) {
      const { options, root } = await loadProject(context);
      const { inspectMessage } = await import('./inspect.js');
      const id = args.id as string;
      const result = await inspectMessage(options, id);
      if (!result.found) throw new ToolError('UNKNOWN_MESSAGE_ID', `Message ID ${JSON.stringify(id)} does not exist in any catalog.`, { messageId: id });
      return {
        id,
        baseLocale: result.baseLocale,
        present: [...result.present],
        missing: [...result.missing],
        untranslated: [...result.untranslated],
        arguments: result.arguments.map(item => ({ name: item.name, type: item.type, choices: [...item.choices] })),
        ...(result.argumentsError === undefined ? {} : { argumentsError: result.argumentsError }),
        export: result.export,
        locales: result.locales.map(item => ({
          locale: item.locale,
          file: projectPath(item.file, root),
          present: item.present,
          blank: item.blank,
          line: item.line,
          column: item.column,
          source: item.source,
        })),
      };
    },
  },
  {
    name: 'explain_code',
    title: 'Explain code',
    description: 'Explain a diagnostic or error code: what it means, how to fix it and its docs anchor. Matching is case-insensitive; an unknown code lists close matches.',
    inputSchema: schema({ code: { type: 'string', minLength: 1, description: 'Diagnostic code, for example INVALID_ICU.' } }, ['code']),
    outputSchema: output({ severity: str, explanation: str, exitCode: int }),
    annotations: annotations(true, false, true),
    async run(args) {
      const query = String(args.code).trim().toUpperCase();
      const entry = errorCodeEntry(query);
      if (!entry) throw new ToolError('USAGE', `No error code matches ${JSON.stringify(args.code)}.`, { suggestions: suggestCodes(query) });
      return {
        code: entry.code,
        severity: entry.severity,
        explanation: entry.explanation,
        fix: entry.fix,
        docs: entry.docs,
        ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
      };
    },
  },
  {
    name: 'rename_message',
    title: 'Rename message',
    description: 'Rename a message ID in every catalog and in source references, then regenerate output unless regenerate is false. Fails when the destination ID already exists.',
    inputSchema: schema({
      from: { type: 'string', minLength: 1, description: 'Current message ID.' },
      to: { type: 'string', minLength: 1, description: 'New message ID.' },
      regenerate: { type: 'boolean', description: 'Regenerate output after the rename. Default true.', default: true },
    }, ['from', 'to']),
    outputSchema: output({ from: str, to: str, locales: strings, changed: strings, regenerated: bool, generated: strings, stale: bool, next: str, warnings: diagnostics }),
    annotations: annotations(false, true, false),
    async run(args, context) {
      const { options, root } = await loadProject(context);
      const { renameMessage } = await import('./cli-tools.js');
      const from = args.from as string, to = args.to as string;
      const result = await renameMessage({ ...options, from, to, regenerate: (args.regenerate as boolean | undefined) ?? true });
      return {
        from,
        to,
        locales: [...result.locales],
        changed: result.changed.map(file => projectPath(file, root)!),
        regenerated: result.regenerated,
        generated: result.generated.map(file => projectPath(file, root)!),
        stale: result.stale,
        ...(result.next === undefined ? {} : { next: result.next }),
        warnings: result.warnings.map(item => compact(item, root)),
      };
    },
  },
  {
    name: 'find_unused',
    title: 'Find unused messages',
    description: 'List base-catalog message IDs that no source call references, and source references to IDs the catalog does not define. Unused is a static estimate: dynamic keys are not seen.',
    inputSchema: schema({ limit: limitProperty(50) }),
    outputSchema: output({ ok: bool, messageCount: int, unused: strings, unusedCount: int, unknownReferences: diagnostics, unknownReferenceCount: int }),
    annotations: annotations(true, false, true),
    async run(args, context) {
      const { options, root } = await loadProject(context);
      const { doctor } = await import('./cli-tools.js');
      const limit = limitOf(args, 50);
      const result = await doctor(options);
      const unknown = result.errors.filter(item => item.code === 'UNKNOWN_MESSAGE_ID');
      return {
        ok: result.ok,
        messageCount: result.messageCount,
        unused: result.unused.slice(0, limit),
        unusedCount: result.unused.length,
        unknownReferences: unknown.slice(0, limit).map(item => compact(item, root)),
        unknownReferenceCount: unknown.length,
      };
    },
  },
  {
    name: 'find_hardcoded',
    title: 'Find hardcoded UI text',
    description: 'List UI text in source files that is not a catalog message, with its confidence and, when the catalog already has the same text, that message ID. Needs the optional oxc-parser. To move the text into the catalog, run nordbeam-locale hardcoded --fix (reuse) or --extract (add), which preview until --write.',
    inputSchema: schema({ limit: limitProperty(50), high: { type: 'boolean', description: 'Only high-confidence findings. Default false.', default: false } }),
    outputSchema: output({ ok: bool, sourceFiles: int, summary: { type: 'object' }, findings: diagnostics, findingCount: int }),
    annotations: annotations(true, false, true),
    async run(args, context) {
      const { options, root } = await loadProject(context);
      const { scanText } = await import('./text-scan.js');
      const limit = limitOf(args, 50);
      const result = await scanText(options);
      const findings = args.high ? result.findings.filter(finding => finding.confidence === 'high') : result.findings;
      return {
        ok: true,
        sourceFiles: result.sourceFiles,
        summary: { high: result.summary.high, medium: result.summary.medium, inCatalog: result.summary.inCatalog, mixedFiles: result.summary.mixedFiles, unlocalizedFiles: result.summary.unlocalizedFiles },
        findings: findings.slice(0, limit).map(finding => ({
          file: projectPath(finding.file, root), line: finding.line, column: finding.column, text: finding.text, confidence: finding.confidence, where: finding.where, reason: finding.reason,
          ...(finding.catalog ? { catalog: finding.catalog } : {}), ...(finding.translations ? { translations: finding.translations } : {}),
        })),
        findingCount: findings.length,
      };
    },
  },
];

async function callTool(tool: McpTool, args: Record<string, unknown>, context: ToolContext) {
  try {
    const result = await tool.run(args, context);
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  } catch (error) {
    const payload = failure(error, context.root);
    return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError: true };
  }
}

async function dispatch(method: string, params: unknown, context: ToolContext): Promise<unknown> {
  switch (method) {
    case 'initialize': {
      const requested = isObject(params) ? params.protocolVersion : undefined;
      serverVersion ??= await packageVersion();
      return {
        protocolVersion: typeof requested === 'string' && protocolVersions.includes(requested) ? requested : latestProtocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'nordbeam-locale', version: serverVersion },
        instructions,
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: mcpTools.map(({ run: _run, ...tool }) => tool) };
    case 'tools/call': {
      const call: Record<string, unknown> = isObject(params) ? params : {};
      if (typeof call.name !== 'string') throw new RpcError(-32602, 'tools/call requires a tool name.');
      const tool = mcpTools.find(item => item.name === call.name);
      if (!tool) throw new RpcError(-32602, `Unknown tool: ${call.name}.`);
      const args = call.arguments === undefined ? {} : call.arguments;
      if (!isObject(args)) throw new RpcError(-32602, 'Tool arguments must be an object.');
      const problem = validate(tool.inputSchema, args);
      if (problem) throw new RpcError(-32602, `Invalid arguments for ${tool.name}: ${problem}.`);
      return callTool(tool, args, context);
    }
    default:
      throw new RpcError(-32601, `Method not found: ${method}.`);
  }
}

async function packageVersion(): Promise<string> {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
  return packageJson.version ?? 'unknown';
}

/** Responds to one message. Notifications (no id) never produce a response. */
async function handleMessage(message: unknown, context: ToolContext): Promise<unknown> {
  const id = isObject(message) && isId(message.id) ? message.id : null;
  if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return rpcFailure(id, -32600, 'Invalid Request.');
  const notification = !('id' in message);
  try {
    const result = await dispatch(message.method, message.params, context);
    return notification ? undefined : { jsonrpc: '2.0', id, result };
  } catch (error) {
    if (notification) return undefined;
    if (error instanceof RpcError) return rpcFailure(id, error.code, error.message);
    process.stderr.write(`nordbeam-locale mcp: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    return rpcFailure(id, -32603, 'Internal error.');
  }
}

/** Responds to one input line, which may be a single message or a batch. */
async function respond(line: string, context: ToolContext): Promise<unknown> {
  let message: unknown;
  try { message = JSON.parse(line); }
  catch { return rpcFailure(null, -32700, 'Parse error.'); }
  if (!Array.isArray(message)) return handleMessage(message, context);
  if (message.length === 0) return rpcFailure(null, -32600, 'Invalid Request.');
  const responses: unknown[] = [];
  for (const item of message) {
    const response = await handleMessage(item, context);
    if (response !== undefined) responses.push(response);
  }
  return responses.length ? responses : undefined;
}

/** Serves MCP over newline-delimited JSON on the given streams, one message at a time, until input ends. */
export async function serveMcp(options: McpOptions = {}): Promise<void> {
  const context: ToolContext = { root: resolve(options.root ?? process.cwd()), config: options.config };
  const output = options.output ?? process.stdout;
  const lines = createInterface({ input: options.input ?? process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const response = await respond(line, context);
    if (response !== undefined) output.write(`${JSON.stringify(response)}\n`);
  }
}
