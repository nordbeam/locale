# Agent protocol — `nordbeam-locale/agent`

The agent entry describes the local CLI's machine-readable capabilities.

```ts
import { getAgentCapabilities, getAgentGuide } from 'nordbeam-locale/agent';
```

- `agentProtocolVersion` — current protocol version.
- `catalogMigrationFormats` and `sourceCodemodFormats` — supported format lists.
- `getAgentCapabilities()` — structured command capabilities.
- `getAgentGuide()` — human-readable automation guidance.
- `exitCodes` on the capabilities result — the stable process exit statuses:
  `0` success, `1` validation failure, `2` usage error, `3` input not found,
  `4` refused unsafe operation, `70` internal error. `failure` is an alias of
  `validation`. See [error codes](errors.md) for the per-code table.
- `AgentAccess`, `AgentCommandCapability`, and `AgentCapabilities` — protocol
  types.

## Agent skills

The package ships two [Agent Skills](https://agentskills.io/specification) in its
`skills/` directory, so the instructions always match the installed CLI:
`nordbeam-locale` (setup, catalogs, ICU, the generated API, the
check/generate/verify loop) and `nordbeam-locale-migrate` (moving from another
i18n library). The [skills README](../../skills/README.md) lists the three ways to
install them: the Claude Code plugin marketplace (`/plugin marketplace add
nordbeam/locale`), `npx skills add nordbeam/locale`, and the commands below.

```sh
nordbeam-locale skills install [--target claude|agents|all] [--skill <name>] [--dry-run] [--json]
nordbeam-locale init --agent
```

- `--target claude` writes `.claude/skills/<name>/` (Claude Code). `agents` writes
  `.agents/skills/<name>/`, the cross-client location that Codex, Cursor, GitHub
  Copilot, Gemini CLI, OpenCode and other clients read. `all` (the default) writes
  both. `--skill` is repeatable and limits the install to named skills; an unknown
  name is a `USAGE` error (exit 2) with `validValues`. `--dry-run` reports what
  would change and writes nothing. The command works without a configuration and
  uses the current directory (or the directory of `--config`) as the project root.
- `init --agent` runs the same install after writing the `AGENTS.md` block, which
  points agents at the skills. Its JSON result gains `agentSkills`, the same
  `skills` array described below.
- The JSON result is `{ ok, root, dryRun, version, totals, skills[] }`. `totals`
  counts files as `created`, `updated`, `unchanged`, `skipped`, `removed`. Each
  `skills[]` entry has `skill`, `target`, `directory`, an `action`
  (`created`, `updated`, `unchanged` or `skipped`), `counts`, and `files[]` with a
  per-file `action` and, for skipped files, a `reason`.
- Local edits are never overwritten. Each skill directory holds a
  `.nordbeam-skill.json` record with the SHA-256 of every file the CLI wrote. A
  later install replaces a file only when it is still byte-identical to that
  record (for example after upgrading `nordbeam-locale`) and removes a file the
  new version no longer ships only under the same condition. Any other differing
  file is `skipped` with a reason and exits 0. A skill directory that is a symbolic
  link, as `npx skills` creates, is skipped as a whole.
- The files in each skill's `evals/` directory are maintainer test cases. They are
  not published in the package and not installed into projects.

## Unreleased

`protocolVersion` stays `1`. The additions are backward compatible.

Additive:

- `inspect --scope <name> [--id <message-id>]`: the `inspectScope` result (see
  [agent inspection](agent-inspect.md)) as `{ root, scope, kind, modules?,
  exclude?, patterns, messageCount, share, fileCount?, files?,
  withoutDynamicImports?, message? }`, with `truncated.files` when `--limit`
  capped `files`. An unknown scope is `USAGE` (exit 2) with `validValues` and a
  `suggestion`. `--scope` does not stream NDJSON.
- `verify` and `inspect` accept `--development` and `--production`. Without them
  (and without a `NODE_ENV` of `production` or `development`) output generated in
  either mode is fresh; `freshness.mode` names the mode of fresh output. A stale
  `next` command carries `--production` when production output was asked for.
- `report --json`: each computed scope also has `files` (source files its crawl
  read), `dynamicFiles` (those reached through a dynamic `import()`) and, when it
  follows dynamic imports, `withoutDynamicImports`.
- `init --json` results may carry `notes`: lint and format configs that init does
  not edit and what to add to them. `updated` also lists the `.eslintignore`,
  `.prettierignore`, `.oxlintrc.json` and `.oxfmtrc.json` files that gained the
  generated directory.
- `inspect --id`: an argument that only the config declares (the `arguments`
  key) is listed with `declared: true`.
- New codes: `doctor` reports the `QUOTED_RUN_APOSTROPHE` warning; `check`,
  `generate` and `verify` report `INVALID_DECLARED_ARGUMENT`,
  `UNKNOWN_INTL_LOCALE` and `INVALID_INTL_LOCALE` errors; `migrate-project`
  reports the `LINGUI_PO_QUOTES`, `LINGUI_OBSOLETE_INCLUDED`,
  `LINGUI_WHITESPACE_TRIMMED`, `LINGUI_SOURCE_ID_TEXT`, `MIGRATION_TEXT_CHANGED`
  and `MIGRATION_ID_RENAMED` warnings. `capabilities` lists the `lingui-po`
  catalog format.
- `migrate-project` results add `renamedIds` and `catalogs[].format`. A run
  that cannot convert its catalogs fails with `COMMAND_FAILED` as `errors[0]`,
  followed by one error per failing message with `code` (such as
  `MIGRATION_INVALID_ICU` or `UNKNOWN_ARGUMENT`), `locale`, `file` and
  `messageId`.

Changed:

- The CLI ships in the `nordbeam-locale` package, apart from the
  `@nordbeam/locale` runtime. `capabilities --json` reports
  `product: "nordbeam-locale"` (it was `"@nordbeam/locale"`), and the skills
  manifest records `package: "nordbeam-locale"`. The agent APIs are imported
  from `nordbeam-locale/agent`, `/agent/plans`, `/agent/events` and
  `/agent/inspect`.
- `init` `notes` start with what to install: `npm install @nordbeam/locale@<version>`
  when a framework scaffold imports the runtime and `package.json` does not list
  it, and `npm install --save-dev nordbeam-locale@<version>` when it does not
  list the tooling.
- `init` writes `"prebuild": "nordbeam-locale --production"` (it was
  `nordbeam-locale`, which generated development output with argument guards
  before a production build).
- Migration warnings that concern many messages come once per code and
  catalog: `MIGRATION_ID_RENAMED`, `MIGRATION_METADATA_DROPPED`,
  `DOTTED_SOURCE_ID`, `PO_FUZZY_SKIPPED`, `PO_UNTRANSLATED_SKIPPED` and the
  `LINGUI_*` warnings. Each carries `count` and `messageIds` (every ID, not
  capped), and `MIGRATION_ID_RENAMED` also carries `renamed`, an object from old
  ID to new ID. Earlier versions emitted one warning per message for some of
  these codes.

## Changes in 0.2

`protocolVersion` stays `1`. The additions are backward compatible; the path,
list-size and init changes below are the ones an existing script may notice.

Additive:

- `summary` on `check`, `doctor`, `generate`, `inspect` and `verify`:
  `{ errors, warnings, byCode }`. With `--only`, it counts the selected codes.
- `root` (absolute) on every result, the base for all other paths.
- `truncated: { errors?, warnings?, ... }` when a list was capped.
- `--limit <n|all>` (default 50 rows per list), `--only CODE[,CODE...]` (unknown
  codes are `USAGE` with a suggestion) and `--summary` (summary, `ok`, `root` and
  the first five errors).
- Grouped warning rows: three or more `FALLBACK_MESSAGE` or `MISSING_MESSAGE`
  warnings with the same code, locale and file become one row:
  `{ code, locale, file, count, messageIds, message, fix, docs }`. `messageIds`
  lists 10 IDs unless `--limit` is given.
- `verify` command: `{ ok, summary, freshness, errors }`. It exits `0` only when
  check has no errors and the generated output is fresh. New codes:
  `GENERATED_STALE` and `GENERATED_MODIFIED`.
- `inspect --id <message-id>`: the `inspectMessage` result, with project-relative
  paths. An unknown ID is `UNKNOWN_MESSAGE_ID` (exit 1) with a `suggestion`.
- `init --agent`: writes the agent block to `AGENTS.md` (and to `CLAUDE.md` when
  it exists). It works on an existing configuration and changes nothing else.
- `capabilities --json`: each command lists its `options`, and `conventions.reports`
  describes the shape above. `inspect` human output (without `--json`) is new.

Changed (not additive):

- Paths in JSON and NDJSON are project-relative with forward slashes. This covers
  `file`, `catalogFiles`, `catalogs[].file`, `config.file`, `generated.*`,
  `changed` and `init` results. The absolute path is now the top-level `root`.
  `config.root` is removed from `inspect`.
- NDJSON `diagnostic` events omit `path` when the project root is known. Use
  `file`.
- Lists in `check`, `doctor`, `generate`, `inspect` and `verify` are capped at 50
  rows by default. Read `truncated`, narrow with `--only`, or pass `--limit all`
  for every row. The per-message `FALLBACK_MESSAGE` and `MISSING_MESSAGE` warnings
  are now rows grouped by locale and file.
- `init` adds `"prebuild": "nordbeam-locale"` (or appends to an existing
  `prebuild`) instead of `"prepare"`. `prepare` runs on every `npm install`,
  including production installs that omit devDependencies. A `prepare` that already
  runs the CLI is still recognized and nothing is duplicated.
- `init` no longer reports `CONFIG_EXISTS` for `init --agent`; the flag works
  with an existing configuration.
