import type { Catalog } from './compiler.js';
import { parse, TYPE } from '@formatjs/icu-messageformat-parser';

/** A deliberately small structural type for JSON Schema documents. Keeping
 * this dependency-free means schema generation adds no compiler/runtime cost. */
export interface JsonSchema {
  readonly $schema?: string;
  readonly $id?: string;
  readonly title?: string;
  readonly description?: string;
  readonly type?: string;
  readonly properties?: Record<string, JsonSchema>;
  readonly additionalProperties?: boolean | JsonSchema;
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly enum?: readonly unknown[];
  readonly anyOf?: readonly JsonSchema[];
  readonly minLength?: number;
  readonly minItems?: number;
  readonly minimum?: number;
  readonly default?: unknown;
  readonly [key: string]: unknown;
}

const draft = 'https://json-schema.org/draft/2020-12/schema';

/** The schema for nordbeam-locale.config.json. It is also exported so editors,
 * config UIs and other tools can validate without loading the compiler. */
export const configSchema: JsonSchema = {
  $schema: draft,
  $id: 'https://nordbeam.com/schemas/nordbeam-locale.config.json',
  title: 'Nordbeam Locale configuration',
  description: 'Configuration for Nordbeam Locale catalog generation.',
  type: 'object',
  additionalProperties: false,
  properties: {
    $schema: { type: 'string', description: 'Optional JSON Schema URL used by your editor.' },
    baseLocale: { type: 'string', minLength: 1, description: 'Canonical BCP 47 locale used as the source contract.' },
    catalogs: { type: 'string', minLength: 1, description: 'Directory containing one JSON catalog per locale.' },
    outDir: { type: 'string', minLength: 1, description: 'Directory for generated modules and declarations.' },
    missing: { enum: ['fallback', 'error'], description: 'Whether missing translations fall back or fail generation.' },
    development: { type: 'boolean', description: 'Include helpful runtime argument checks in generated functions.' },
    timeZone: { type: 'string', minLength: 1 },
    artifacts: { enum: ['typed', 'runtime', 'loader', 'loader-typed'] },
    includeSources: { anyOf: [{ enum: ['rich', 'all'] }, { type: 'array', items: { type: 'string', minLength: 1 } }], description: 'Retain original ICU source for compatibility renderers: rich/tag messages, every message, or exact message IDs.' },
    shareLiterals: { type: 'boolean', description: 'Opt into a shared plain-literal module for cold loader and loader-typed artifacts. Disabled by default to minimize first-load dependency edges.' },
    selectionFallback: { enum: ['warn', 'error', 'off'], description: 'Diagnostic policy for automatic Vite loader narrowing fallbacks.' },
    shareMessages: { type: 'boolean', description: 'Share overlapping Vite selection functions between chunks.' },
    preloadManifest: { type: 'boolean', description: 'Emit a locale preload manifest for router integrations.' },
    staticLocale: { type: 'string', minLength: 1, description: 'Bind Vite selections to one known locale.' },
    lockedKeys: { type: 'array', items: { type: 'string', minLength: 1, pattern: '^(?:[^*]+|[^*]+\\.\\*)$' }, description: 'Exact message IDs or dotted prefix patterns ending in .* whose source text is copied verbatim.' },
    ignoredKeys: { type: 'array', items: { type: 'string', minLength: 1, pattern: '^(?:[^*]+|[^*]+\\.\\*)$' }, description: 'Exact message IDs or dotted prefix patterns ending in .* omitted from translation work.' },
    formats: {
      type: 'object',
      additionalProperties: false,
      properties: {
        number: { type: 'object', additionalProperties: { type: 'object' } },
        date: { type: 'object', additionalProperties: { type: 'object' } },
        time: { type: 'object', additionalProperties: { type: 'object' } },
      },
    },
    scopes: {
      type: 'object',
      additionalProperties: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
    },
    cache: {
      type: 'object',
      additionalProperties: false,
      properties: { maxMessageCacheBytes: { type: 'number', minimum: 0 } },
    },
    persistentCache: {
      anyOf: [{ type: 'boolean' }, { type: 'string', minLength: 1 }],
    },
  },
};

function catalogNode(value: Catalog, path: string): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const key of Object.keys(value).sort()) {
    const entry = value[key];
    const id = path ? `${path}.${key}` : key;
    properties[key] = typeof entry === 'string'
      ? {
          type: 'string',
          description: `ICU message ${JSON.stringify(id)}.`,
          default: entry,
          'x-nordbeam': { id, source: entry, ...messageArguments(entry) },
        }
      : catalogNode(entry as Catalog, id);
  }
  return { type: 'object', additionalProperties: false, properties };
}

/** Extract a compact argument contract for hover/completion clients. Invalid
 * ICU is intentionally ignored here; the compiler remains the authority for
 * diagnostics and can still surface the original source in the schema. */
function messageArguments(source: string): { arguments?: Record<string, { kind: string; choices?: string[] }> } {
  const result: Record<string, { kind: string; choices?: string[] }> = {};
  try {
    const ast = parse(source, { shouldParseSkeletons: false });
    const visit = (nodes: readonly { type: TYPE; value?: string; options?: Record<string, { value: readonly any[] }>; children?: readonly any[] }[]): void => {
      for (const node of nodes) {
        if (node.type === TYPE.literal || node.type === TYPE.pound || node.value === undefined) continue;
        if (node.type === TYPE.tag) {
          result[node.value] ??= { kind: 'rich-text' };
          if (node.children) visit(node.children);
          continue;
        }
        const kind = node.type === TYPE.number || node.type === TYPE.plural ? 'number'
          : node.type === TYPE.date || node.type === TYPE.time ? 'date'
          : node.type === TYPE.select ? 'select' : 'value';
        const previous = result[node.value];
        if (!previous) result[node.value] = { kind };
        else if (previous.kind === 'value') previous.kind = kind;
        if (node.type === TYPE.select && node.options) {
          const choices = Object.keys(node.options).filter(choice => choice !== 'other').sort();
          if (choices.length) result[node.value] = { ...result[node.value]!, choices };
          for (const option of Object.values(node.options)) visit(option.value);
        } else if ((node.type === TYPE.plural) && node.options) for (const option of Object.values(node.options)) visit(option.value);
      }
    };
    visit(ast);
  } catch { return {}; }
  return Object.keys(result).length ? { arguments: result } : {};
}

/** Build an editor-friendly schema from the base catalog. Message keys are
 * constrained to the source contract while translated catalogs remain sparse
 * (no keys are marked required). The source text is included as local editor
 * metadata for hover/completion integrations; it is never shipped at runtime. */
export function catalogSchema(catalog: Catalog, baseLocale = 'en'): JsonSchema {
  return {
    $schema: draft,
    $id: `https://nordbeam.com/schemas/catalog-${encodeURIComponent(baseLocale)}.json`,
    title: `Nordbeam Locale ${baseLocale} catalog`,
    description: `Message keys and ICU source contract for locale ${baseLocale}.`,
    ...catalogNode(catalog, ''),
  };
}
