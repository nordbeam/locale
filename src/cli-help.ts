import { CliError } from './error-codes.js';

/** Command catalog, help text and typo suggestions. Kept free of subsystem
 * imports so `--help` and usage errors stay on the fastest startup path. */
export const commandNames = ['generate', 'init', 'check', 'verify', 'export', 'import', 'rename', 'extract', 'prune', 'doctor', 'hardcoded', 'report', 'migrate', 'migrate-project', 'pseudo', 'inspect', 'schema', 'codemod', 'apply-plan', 'capabilities', 'agent-guide', 'explain', 'mcp', 'skills'] as const;

export const helpGroups: Readonly<Record<string, readonly [string, string][]>> = {
  Core: [
    ['generate', 'compile catalogs into typed locale modules (use --watch to rebuild)'], ['init', 'create catalogs, config, scripts, and generated output'],
    ['check', 'validate catalogs without writing output'], ['verify', 'check plus fresh generated output; the CI and agent gate'],
  ],
  Translation: [['export', 'export a locale as ICU-in-PO'], ['import', 'merge a reviewed PO translation']],
  Refactoring: [['rename', 'rename a message ID in catalogs and source'], ['extract', 'add one source message to a catalog'], ['prune', 'report unreferenced base messages'], ['doctor', 'validate catalogs and report likely issues'], ['hardcoded', 'find UI text outside the catalog; --fix and --extract move it in'], ['report', 'write an HTML page of coverage, usage, scopes and sizes']],
  Migration: [['migrate', 'convert one catalog format (needs @nordbeam/locale-migrate)'], ['migrate-project', 'preview or apply a complete project migration (needs @nordbeam/locale-migrate)'], ['codemod', 'rewrite recognized source calls (needs @nordbeam/locale-migrate)']],
  Other: [['pseudo', 'generate a pseudo-locale catalog'], ['inspect', 'print a machine-readable project snapshot'], ['schema', 'write editor schemas'], ['capabilities', 'print the automation contract'], ['agent-guide', 'print the automation guide'], ['apply-plan', 'apply a reviewed codemod plan'], ['explain', 'explain an error or diagnostic code and its fix'], ['mcp', 'serve the agent tools over MCP on stdio'], ['skills', 'install the bundled agent skills into .claude/skills and .agents/skills']],
};

/** Every accepted option with its value placeholder ('' for flags) and one-line description. */
export const optionHelp: Readonly<Record<string, readonly [value: string, text: string]>> = {
  config: ['<file>', 'configuration file (default: nordbeam-locale.config.json)'],
  catalogs: ['<dir>', 'catalog directory (default: messages)'],
  'base-locale': ['<locale>', 'base locale of the catalogs (default: en)'],
  'out-dir': ['<dir>', 'generated output directory (default: src/i18n)'],
  framework: ['<next|vite-react|vue|svelte|solid|tanstack-start>', 'also scaffold integration files for this framework'],
  locale: ['<locale>', 'target locale'],
  from: ['<path>', 'input file, catalog, or source directory'],
  out: ['<file>', 'output file, or - for stdout'],
  notes: ['<file>', 'write notes found in the source (comments, FormatJS and ARB descriptions) to this JSON file'],
  id: ['<id>', 'message ID'],
  message: ['<text>', 'source message text'],
  'default-message': ['<text>', 'alias of --message'],
  to: ['<id>', 'new message ID'],
  'source-dir': ['<dir>', 'source directory to scan (default: src)'],
  'schema-dir': ['<dir>', 'directory for editor schemas (default: .nordbeam)'],
  'messages-object': ['<name>', 'messages object name used in rewritten source'],
  'messages-import': ['<specifier>', 'module that provides the messages import'],
  'messages-hook': ['<name>', 'hook from --messages-import that returns the messages object; replaces dead formatter hooks such as const t = useT()'],
  'move-type-import': ['<Type>', 'move this type import to --messages-import (repeatable)'],
  'message-id-map': ['<file>', 'JSON map from source file to message ID prefix'],
  'custom-call': ['<callee[:namespace]>', 'treat this custom call as a message call (repeatable)'],
  'initial-locale-expression': ['<expr>', 'expression that yields the initial locale in migrated code'],
  write: ['', 'apply changes instead of previewing them'],
  'from-locale': ['<locale>', 'locale to derive the pseudo-locale from (default: base locale)'],
  expansion: ['<number>', 'text expansion ratio from 0 to 5'],
  update: ['', 'replace an existing pseudo-locale catalog'],
  format: ['<format>', 'source format (see nordbeam-locale capabilities --json)'],
  'catalog-format': ['<format>', 'catalog format written by the migration'],
  plan: ['<file>', 'write a reviewed plan for apply-plan instead of editing files'],
  'dry-run': ['', 'report what would change without writing'],
  regenerate: ['', 'regenerate output after editing catalogs'],
  development: ['', 'generate development output with argument guards'],
  production: ['', 'generate production output without argument guards'],
  strict: ['', 'fail on missing translations (codemod: on unresolved constructs; hardcoded: when any text is found)'],
  watch: ['', 'rebuild when catalog files change'],
  json: ['', 'print one JSON document'],
  ndjson: ['', 'print newline-delimited JSON events'],
  version: ['', 'print the package version'],
  help: ['', 'show help for the command'],
  limit: ['<n|all>', 'rows per list (default 50); all lists every row'],
  only: ['<CODE[,CODE]>', 'report only these diagnostic codes'],
  summary: ['', 'print only the summary, ok and the first five errors'],
  agent: ['', 'write agent instructions to AGENTS.md (and CLAUDE.md when it exists) and install the agent skills'],
  target: ['<claude|agents|all>', 'where to install skills: .claude/skills, .agents/skills, or both (default: all)'],
  skill: ['<name>', 'install only this skill (repeatable; default: every bundled skill)'],
  open: ['', 'open the written page in the default browser'],
  fix: ['', 'replace text that matches a catalog message with that message (preview; --write applies)'],
  extract: ['', 'also add the remaining text as new base-catalog messages (preview; --write applies)'],
  confidence: ['<high|medium>', 'lowest confidence to report (default: medium, every finding; high with --extract)'],
};

/** Options each command accepts, in display order. */
const commandOptions: Readonly<Record<string, readonly string[]>> = {
  generate: ['config', 'catalogs', 'out-dir', 'development', 'production', 'strict', 'watch', 'limit', 'only', 'summary', 'json', 'ndjson'],
  init: ['framework', 'config', 'catalogs', 'base-locale', 'out-dir', 'development', 'production', 'agent', 'json'],
  check: ['config', 'catalogs', 'strict', 'limit', 'only', 'summary', 'json', 'ndjson'],
  verify: ['config', 'catalogs', 'limit', 'only', 'summary', 'json'],
  export: ['config', 'catalogs', 'locale', 'out', 'json'],
  import: ['config', 'catalogs', 'locale', 'from', 'dry-run', 'strict', 'json'],
  rename: ['config', 'catalogs', 'id', 'to', 'source-dir', 'regenerate', 'json'],
  extract: ['config', 'catalogs', 'id', 'message', 'locale', 'regenerate', 'json'],
  prune: ['config', 'catalogs', 'source-dir', 'dry-run', 'json'],
  doctor: ['config', 'catalogs', 'source-dir', 'limit', 'only', 'summary', 'json', 'ndjson'],
  hardcoded: ['config', 'catalogs', 'source-dir', 'confidence', 'fix', 'extract', 'write', 'regenerate', 'strict', 'limit', 'json'],
  report: ['config', 'catalogs', 'source-dir', 'out', 'open', 'limit', 'json'],
  migrate: ['from', 'format', 'locale', 'out', 'notes', 'dry-run', 'json', 'ndjson'],
  'migrate-project': ['from', 'format', 'catalog-format', 'framework', 'config', 'catalogs', 'locale', 'source-dir', 'messages-object', 'message-id-map', 'custom-call', 'initial-locale-expression', 'strict', 'write', 'development', 'production', 'json', 'ndjson'],
  pseudo: ['config', 'catalogs', 'locale', 'from-locale', 'expansion', 'update', 'dry-run', 'json'],
  inspect: ['config', 'catalogs', 'id', 'limit', 'only', 'summary', 'json', 'ndjson'],
  schema: ['config', 'catalogs', 'schema-dir'],
  codemod: ['format', 'source-dir', 'messages-object', 'messages-import', 'messages-hook', 'move-type-import', 'message-id-map', 'custom-call', 'write', 'plan', 'strict', 'json', 'ndjson'],
  'apply-plan': ['from', 'json', 'ndjson'],
  capabilities: ['json'],
  'agent-guide': ['json'],
  explain: ['json'],
  mcp: ['config'],
  skills: ['target', 'skill', 'dry-run', 'json'],
};

/** Usage line and examples for each command's detailed help. */
const commandUsage: Readonly<Record<string, readonly [usage: string, examples: readonly string[]]>> = {
  generate: ['nordbeam-locale [generate] [options]', ['nordbeam-locale generate --production', 'nordbeam-locale generate --watch']],
  init: ['nordbeam-locale init [options]', ['nordbeam-locale init --framework next', 'nordbeam-locale init --framework tanstack-start', 'nordbeam-locale init --agent']],
  check: ['nordbeam-locale check [options]', ['nordbeam-locale check --strict --json', 'nordbeam-locale check --only FALLBACK_MESSAGE --limit all --json']],
  verify: ['nordbeam-locale verify [options]', ['nordbeam-locale verify --json', 'nordbeam-locale verify --summary --json']],
  export: ['nordbeam-locale export --locale <locale> [options]', ['nordbeam-locale export --locale fr --out fr.po']],
  import: ['nordbeam-locale import --locale <locale> --from <file.po> [options]', ['nordbeam-locale import --locale fr --from fr.po --dry-run']],
  rename: ['nordbeam-locale rename --id <old.id> --to <new.id> [options]', ['nordbeam-locale rename --id greeting --to home.greeting']],
  extract: ['nordbeam-locale extract --id <message.id> --message <text> [options]', ['nordbeam-locale extract --id cart.empty --message "Your cart is empty"']],
  prune: ['nordbeam-locale prune [options]', ['nordbeam-locale prune --dry-run --json']],
  doctor: ['nordbeam-locale doctor [options]', ['nordbeam-locale doctor --ndjson']],
  hardcoded: ['nordbeam-locale hardcoded [options]', ['nordbeam-locale hardcoded', 'nordbeam-locale hardcoded --fix --write', 'nordbeam-locale hardcoded --extract --source-dir app', 'nordbeam-locale hardcoded --strict --confidence high --json']],
  report: ['nordbeam-locale report [options]', ['nordbeam-locale report --open', 'nordbeam-locale report --source-dir app --out reports/i18n.html', 'nordbeam-locale report --json']],
  migrate: ['nordbeam-locale migrate --from <file> --format <format> [options]', ['nordbeam-locale migrate --from legacy.json --format i18next --out messages/en.json --dry-run', 'nordbeam-locale migrate --from src/i18n/en.ts --format module --out messages/en.json --notes messages.notes.json']],
  'migrate-project': ['nordbeam-locale migrate-project --from <dir> --format <format> [options]', ['nordbeam-locale migrate-project --from src/messages --format gettext --write']],
  pseudo: ['nordbeam-locale pseudo --locale <locale> [options]', ['nordbeam-locale pseudo --locale en-XA --expansion 0.3']],
  inspect: ['nordbeam-locale inspect [--json|--ndjson] [--id <id>] [options]', ['nordbeam-locale inspect --json', 'nordbeam-locale inspect --id checkout.pay']],
  schema: ['nordbeam-locale schema [options]', ['nordbeam-locale schema --schema-dir .nordbeam']],
  codemod: ['nordbeam-locale codemod --format <format> [options]', ['nordbeam-locale codemod --format react-intl --plan reviewed-plan.json']],
  'apply-plan': ['nordbeam-locale apply-plan --from <plan.json> [options]', ['nordbeam-locale apply-plan --from reviewed-plan.json --json']],
  capabilities: ['nordbeam-locale capabilities [--json]', ['nordbeam-locale capabilities --json']],
  'agent-guide': ['nordbeam-locale agent-guide [--json]', ['nordbeam-locale agent-guide']],
  explain: ['nordbeam-locale explain <CODE> [--json]', ['nordbeam-locale explain INVALID_ICU', 'nordbeam-locale explain USAGE --json']],
  skills: ['nordbeam-locale skills install [options]', ['nordbeam-locale skills install', 'nordbeam-locale skills install --target claude --skill nordbeam-locale --dry-run --json']],
  mcp: ['nordbeam-locale mcp [--config <file>]', ['nordbeam-locale mcp', 'claude mcp add nordbeam-locale -- npx nordbeam-locale mcp']],
};

const agentLine = 'For automation and agents: nordbeam-locale agent-guide prints the protocol guide; capabilities --json lists every command.';

/** Optimal-string-alignment Damerau-Levenshtein distance (adjacent transpositions count once). */
export function editDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) rows[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, rows[i - 2]![j - 2]! + 1);
      rows[i]![j] = value;
    }
  }
  return rows[a.length]![b.length]!;
}

/** Closest candidate within two edits and 40% of the typed length; undefined when nothing is close. */
export function suggest(typed: string, candidates: readonly string[]): string | undefined {
  const name = typed.replace(/^-+/, '');
  const limit = Math.min(2, 0.4 * name.length);
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = editDistance(name, candidate);
    if (distance < bestDistance) { best = candidate; bestDistance = distance; }
  }
  return best !== undefined && bestDistance <= limit ? best : undefined;
}

export function unknownCommandError(command: string): CliError {
  const near = suggest(command, commandNames);
  return new CliError('USAGE', `Unknown command ${JSON.stringify(command)}${near ? `, did you mean ${near}?` : '.'} Run nordbeam-locale --help.`, { command, validValues: commandNames, ...(near ? { suggestion: near } : {}) });
}

function printCommandHelp(command: string): void {
  const [usage, examples] = commandUsage[command]!;
  const description = Object.values(helpGroups).flat().find(([name]) => name === command)?.[1] ?? '';
  console.log(`nordbeam-locale ${command} — ${description}`);
  console.log(`\nUsage: ${usage}`);
  const flags = [...(commandOptions[command] ?? []), 'help'].map(name => {
    const [value, text] = optionHelp[name]!;
    return [`--${name}${value ? ` ${value}` : ''}`, text] as const;
  });
  const width = Math.max(...flags.map(([flag]) => flag.length));
  console.log('\nOptions:');
  for (const [flag, text] of flags) console.log(`  ${flag.padEnd(width)}  ${text}`);
  console.log('\nExamples:');
  for (const example of examples) console.log(`  ${example}`);
  console.log(`\n${agentLine}`);
}

export function printHelp(command?: string): void {
  if (command !== undefined && commandUsage[command]) {
    printCommandHelp(command);
    return;
  }
  if (command !== undefined) throw unknownCommandError(command);
  console.log('nordbeam-locale — typed, tree-shakeable ICU catalogs');
  console.log('Usage: nordbeam-locale <command> [options]');
  for (const [group, commands] of Object.entries(helpGroups)) {
    console.log(`\n${group}:`);
    for (const [name, summary] of commands) console.log(`  ${name.padEnd(16)} ${summary}`);
  }
  console.log('\nRun nordbeam-locale help <command> or <command> --help for command options. Global: --help, --version, --json, --ndjson.');
  console.log('Exit status: 0 success, 1 validation failure, 2 usage error, 3 input not found, 4 refused unsafe operation, 70 internal error. Explain any code with nordbeam-locale explain <CODE>.');
  console.log(agentLine);
}
