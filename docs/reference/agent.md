# Agent protocol — `@nordbeam/locale/agent`

The agent entry describes the local CLI's machine-readable capabilities.

```ts
import { getAgentCapabilities, getAgentGuide } from '@nordbeam/locale/agent';
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
  record (for example after upgrading `@nordbeam/locale`) and removes a file the
  new version no longer ships only under the same condition. Any other differing
  file is `skipped` with a reason and exits 0. A skill directory that is a symbolic
  link, as `npx skills` creates, is skipped as a whole.
- The files in each skill's `evals/` directory are maintainer test cases. They are
  not published in the package and not installed into projects.

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
