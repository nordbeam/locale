export const agentProtocolVersion = 1 as const;

export const catalogMigrationFormats = [
  'i18next', 'vue-i18n', 'next-intl', 'formatjs', 'lingui', 'tolgee', 'arb', 'yaml',
  'android-xml', 'apple-strings', 'apple-xcstrings', 'po', 'pot', 'mo',
  'json-gettext',
] as const;

export const sourceCodemodFormats = [
  'auto', 'i18next', 'react-i18next', 'next-i18next', 'next-intl',
  'formatjs', 'react-intl', 'lingui', 'lingui-react', 'vue-i18n',
  'nuxt-i18n', 'tolgee', 'tolgee-react', 'next-international',
  'typesafe-i18n', 'svelte-i18n', 'transloco', 'ngx-translate',
] as const;

export type AgentAccess = 'read' | 'write' | 'conditional';

export interface AgentCommandCapability {
  name: string;
  invocation: string;
  summary: string;
  access: AgentAccess;
  json: boolean;
  ndjson?: boolean;
  preview: boolean;
  idempotent: boolean;
  /** npm package that must be installed before the command runs. */
  requires?: string;
  /** Output-control options the command accepts beyond the shared ones. */
  options?: readonly string[];
}

export interface AgentCapabilities {
  protocolVersion: typeof agentProtocolVersion;
  product: '@nordbeam/locale';
  executable: 'nordbeam-locale';
  locality: 'local-only';
  commands: AgentCommandCapability[];
  formats: {
    catalogs: readonly string[];
    sourceCodemods: readonly string[];
  };
  exitCodes: {
    success: 0;
    /** Any failure; equal to validation. */
    failure: 1;
    validation: 1;
    usage: 2;
    inputNotFound: 3;
    refused: 4;
    internal: 70;
  };
  conventions: {
    stdout: string;
    stderr: string;
    paths: string;
    preview: string;
    reports: string;
  };
  recommendedWorkflow: readonly string[];
}

const commands: AgentCommandCapability[] = [
  { name: 'capabilities', invocation: 'capabilities --json', summary: 'Discover the machine-facing command contract without loading project configuration.', access: 'read', json: true, preview: false, idempotent: true },
  { name: 'agent-guide', invocation: 'agent-guide', summary: 'Print concise operating instructions for an LLM or automation client.', access: 'read', json: true, preview: false, idempotent: true },
  { name: 'explain', invocation: 'explain <CODE> --json', summary: 'Return the severity, explanation, fix and docs anchor for an error or diagnostic code.', access: 'read', json: true, preview: false, idempotent: true },
  { name: 'mcp', invocation: 'mcp', summary: 'Serve check, generate, inspect_project, inspect_message, explain_code, rename_message and find_unused as MCP tools over stdio (newline-delimited JSON-RPC).', access: 'conditional', json: false, preview: false, idempotent: false },
  { name: 'check', invocation: 'check --json', summary: 'Validate catalogs without generating files.', access: 'read', json: true, ndjson: true, preview: false, idempotent: true, options: ['limit', 'only', 'summary'] },
  { name: 'verify', invocation: 'verify --json', summary: 'Run check and confirm the generated output is fresh and unedited; exits 0 only when both pass. Run it before finishing.', access: 'read', json: true, preview: false, idempotent: true, options: ['limit', 'only', 'summary'] },
  { name: 'inspect', invocation: 'inspect --json', summary: 'Return resolved configuration, catalogs, generated ownership state, freshness, integrations, and diagnostics without writing; --id <message-id> describes one message.', access: 'read', json: true, ndjson: true, preview: false, idempotent: true, options: ['id', 'limit', 'only', 'summary'] },
  { name: 'doctor', invocation: 'doctor --json', summary: 'Validate catalogs and inspect source usage.', access: 'read', json: true, ndjson: true, preview: false, idempotent: true, options: ['limit', 'only', 'summary'] },
  { name: 'prune', invocation: 'prune --dry-run --json', summary: 'Report unused base messages; this command never deletes them.', access: 'read', json: true, preview: true, idempotent: true },
  { name: 'export', invocation: 'export --locale <locale> [--out <new-file>] --json', summary: 'Export a locale as PO; JSON embeds output unless --out creates a new file.', access: 'conditional', json: true, preview: true, idempotent: false },
  { name: 'migrate', invocation: 'migrate --from <path> --format <format> --dry-run --json', summary: 'Convert a catalog, previewing before an optional new output file is created.', access: 'conditional', json: true, ndjson: true, preview: true, idempotent: false, requires: '@nordbeam/locale-migrate' },
  { name: 'codemod', invocation: 'codemod --format <format> --source-dir <dir> --plan <new-file> --json', summary: 'Preview parser-verified rewrites with coded remediation; optionally move explicitly compatible type imports and save a hash-bound plan.', access: 'conditional', json: true, ndjson: true, preview: true, idempotent: true, requires: '@nordbeam/locale-migrate' },
  { name: 'migrate-project', invocation: 'migrate-project --from <path> --format <format> --source-dir <dir> --json', summary: 'Preview a full catalog, integration, generation, and source migration; --write applies it.', access: 'conditional', json: true, ndjson: true, preview: true, idempotent: true, requires: '@nordbeam/locale-migrate' },
  { name: 'pseudo', invocation: 'pseudo --locale <locale> --dry-run --json', summary: 'Preview a pseudo-locale; remove --dry-run to create it.', access: 'conditional', json: true, preview: true, idempotent: true },
  { name: 'import', invocation: 'import --locale <locale> --from <po> --dry-run --json', summary: 'Preview reviewed PO changes before updating one catalog.', access: 'conditional', json: true, preview: true, idempotent: true },
  { name: 'apply-plan', invocation: 'apply-plan --from <reviewed-plan> --json', summary: 'Apply exactly one reviewed plan after validating its hash, root, target set, and every before-content hash.', access: 'write', json: true, ndjson: true, preview: false, idempotent: false },
  { name: 'rename', invocation: 'rename --id <old> --to <new> --json', summary: 'Rename a catalog key and recognizable source references.', access: 'write', json: true, preview: false, idempotent: false },
  { name: 'extract', invocation: 'extract --id <id> --message <text> --json', summary: 'Add one validated source message to a catalog.', access: 'write', json: true, preview: false, idempotent: false },
  { name: 'schema', invocation: 'schema [--schema-dir <dir>] --json', summary: 'Write local catalog and configuration schemas for editor tooling.', access: 'write', json: true, preview: false, idempotent: true },
  { name: 'generate', invocation: 'generate [--config <path>] --json', summary: 'Compile catalogs into generated JavaScript and types; watch mode uses --ndjson.', access: 'write', json: true, ndjson: true, preview: false, idempotent: true, options: ['limit', 'only', 'summary'] },
  { name: 'init', invocation: 'init [--framework next|vite-react|vue|svelte|solid|tanstack-start] [--agent] --json', summary: 'Create missing configuration, starter catalogs, generated output, and optional framework adapters. --agent writes the agent block to AGENTS.md (and CLAUDE.md when present) and installs the bundled agent skills, even when a configuration already exists.', access: 'write', json: true, preview: false, idempotent: true, options: ['agent'] },
  { name: 'skills', invocation: 'skills install [--target claude|agents|all] [--skill <name>] [--dry-run] --json', summary: 'Install the version-matched agent skills (nordbeam-locale, nordbeam-locale-migrate) into .claude/skills and .agents/skills. Files edited since installation are skipped and reported, never overwritten.', access: 'write', json: true, preview: true, idempotent: true, options: ['target', 'skill'] },
];

export function getAgentCapabilities(): AgentCapabilities {
  return {
    protocolVersion: agentProtocolVersion,
    product: '@nordbeam/locale',
    executable: 'nordbeam-locale',
    locality: 'local-only',
    commands: commands.map(command => ({ ...command })),
    formats: {
      catalogs: catalogMigrationFormats,
      sourceCodemods: sourceCodemodFormats,
    },
    exitCodes: { success: 0, failure: 1, validation: 1, usage: 2, inputNotFound: 3, refused: 4, internal: 70 },
    conventions: {
      stdout: 'With --json, stdout contains exactly one JSON document. Parse it before using exit status for control flow.',
      stderr: 'Diagnostics and human progress use stderr when stdout carries a data format.',
      paths: 'Relative paths resolve from the working directory, except catalog/output paths loaded from config, which resolve from the config file.',
      preview: 'Run preview-capable mutations without --write or with --dry-run, review the structured result, then apply the identical command with --write or without --dry-run.',
      reports: 'check, doctor, generate, inspect and verify return a summary {errors, warnings, byCode}, lists capped at 50 rows (--limit all lifts the cap, and truncated counts what was left out), --only CODE filters by code, and paths are project-relative under one absolute root. Grouped FALLBACK_MESSAGE and MISSING_MESSAGE warnings appear as one row with a count.',
    },
    recommendedWorkflow: [
      'Run capabilities --json once and reject unsupported protocolVersion values.',
      'Run doctor --json before changing catalogs or source calls.',
      'Use preview mode for every command that supports it and surface skipped constructs or collisions.',
      'Apply only after the preview matches the requested scope.',
      'Run check --json and the project type-check or build after every mutation.',
      'Run verify --json before finishing; it exits 0 only when check passes and the generated output is fresh.',
      'Never edit generated output directly.',
    ],
  };
}

export function getAgentGuide(): string {
  return `# Nordbeam Locale agent guide

Operate from the project root. Start with \`nordbeam-locale capabilities --json\`; its \`protocolVersion\` versions the machine contract.
Clients that speak MCP can run \`nordbeam-locale mcp\` instead, which serves check, generate, inspect_project, inspect_message, explain_code, rename_message and find_unused as tools. Migration commands (\`migrate\`, \`migrate-project\`, \`codemod\`) need \`@nordbeam/locale-migrate\` installed at the same version; their capabilities carry \`requires\`.

1. Run \`nordbeam-locale inspect --json\` and \`nordbeam-locale doctor --json\` to establish project, catalog, generated-output, integration, and source state. \`inspect --id <message-id> --json\` describes one message across locales.
2. Prefer structured output. Results carry a \`summary\` and lists capped at 50 rows; when \`truncated\` is present, narrow with \`--only CODE\` or read everything with \`--limit all\`. Paths are project-relative under one \`root\`. Treat non-zero exit status or \`ok: false\` as failure. Exit status 2 is a usage error, 3 a missing input, 4 a refused unsafe operation such as a stale plan, and 70 an internal error; \`errors[].code\` names the cause and \`nordbeam-locale explain <CODE> --json\` gives its fix.
3. Preview catalog imports and conversions with \`--dry-run --json\`.
4. For codemods, prefer \`--plan .nordbeam/codemod.json --json\`, review the affected paths and plan hash, then use \`apply-plan --from .nordbeam/codemod.json --json\`. A concurrent edit makes the plan stale before any target is written.
5. Use \`--ndjson\` for watch mode and long checks or migrations; the first line versions the event stream and the final event carries the result.
6. After a mutation, run \`nordbeam-locale check --json\`, then the repository's type-check, tests, or production build. Before finishing, run \`nordbeam-locale verify --json\`: it exits 0 only when check passes and the generated output is fresh and unedited.
7. Edit source catalogs and application source only. Never hand-edit generated i18n files.

Agent skills for this library ship in the package: \`nordbeam-locale skills install\` (or \`init --agent\`) copies them into \`.claude/skills/\` and \`.agents/skills/\`. Read the \`nordbeam-locale\` skill before editing catalogs and the \`nordbeam-locale-migrate\` skill before moving off another i18n library.

Commands that do not advertise preview support are immediate writes. Keep their scope explicit, inspect the diff afterward, and do not retry a failed rename or extract blindly.
`;
}
