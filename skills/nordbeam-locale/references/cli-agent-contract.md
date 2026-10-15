# CLI contract for agents

The CLI is deterministic and local-only; it embeds no LLM. The authoritative, version-matched contract is the CLI itself, so when this file and the CLI disagree, trust the CLI:

```sh
npx nordbeam-locale capabilities --json   # every command, options, access class, preview support, exit codes, protocolVersion
npx nordbeam-locale agent-guide           # the operating protocol as text (add --json for a document)
npx nordbeam-locale help <command>        # options and examples for one command
npx nordbeam-locale explain <CODE> --json # severity, explanation, fix and docs for any diagnostic code
```

`capabilities` and `agent-guide` need no project configuration. Check `protocolVersion` (currently `1`) once and stop if it is not one you understand.

Install the package before the first `npx nordbeam-locale ...`: `npm install @nordbeam/locale`. Without a local install, `npx` looks up an unrelated unscoped package named `nordbeam-locale` on the registry and fails or runs the wrong thing.

## Envelope and exit status

With `--json`, stdout is exactly one JSON document and human text stays on stderr. Every result has `version: 1` and `ok`. Failures are `ok: false` with `errors[]` whose entries carry a stable `code` plus `message`, `fix`, `docs` and, where known, `file`, `line`, `column`, `frame`, `option`, `validValues`, `suggestion`.

| Exit | Meaning | Typical codes |
| --- | --- | --- |
| 0 | Success | |
| 1 | Validation failure: catalogs have errors, or a command could not proceed | `INVALID_ICU`, `UNKNOWN_ARGUMENT`, `MISSING_MESSAGE` (strict), `GENERATED_STALE`, `GENERATED_MODIFIED`, `COMMAND_FAILED` |
| 2 | Usage error: unknown command or option, missing or conflicting flags | `USAGE`, `UNKNOWN_FORMAT` |
| 3 | An input path does not exist | `FILE_NOT_FOUND`, `MIGRATE_PACKAGE_MISSING` |
| 4 | Refused an unsafe operation; nothing was written | `STALE_PLAN`, `FILE_EXISTS`, `CONFIG_EXISTS`, `MESSAGE_ALREADY_EXISTS`, `UNRESOLVED_MIGRATION_CONSTRUCT` |
| 70 | Internal error: report the command and its output | `INTERNAL_ERROR` |

Read the status and the `code` together: the status is the category, the code the cause. `--json` is only accepted with an explicit command: `nordbeam-locale generate --json` works, bare `nordbeam-locale --json` is a usage error. `--json` and `--ndjson` cannot be combined.

## Reports: check, doctor, generate, inspect, verify

Result fields: `root` (absolute project root; every other path is project-relative with forward slashes), `ok`, `summary` (`{ errors, warnings, byCode }`), `errors[]`, `warnings[]`, and `truncated` when a list was capped.

- Lists show 50 rows. Raise with `--limit <n|all>`, filter with `--only CODE[,CODE]` (unknown codes are a usage error with a suggestion), or reduce to `summary`, `ok`, `root` and the first five errors with `--summary`.
- Three or more `FALLBACK_MESSAGE` or `MISSING_MESSAGE` warnings for one locale and file collapse into one row `{ code, locale, file, count, messageIds, message, fix, docs }`; `--limit` widens `messageIds`.
- `check` never writes. `--strict` turns missing translations into errors.
- `verify` is `check` plus a freshness check of generated output and returns `freshness.status` (`fresh`, `stale`, `modified`, `missing`, `unknown`). Exit 0 only if both pass. `GENERATED_STALE` means run `generate`; `GENERATED_MODIFIED` means someone edited a generated file: move the change into the catalog and regenerate.
- `inspect --json` is a read-only snapshot (config, catalogs with counts, generated ownership, detected integrations, diagnostics). `inspect --id <message-id> --json` describes one message across locales: present, missing, untranslated, arguments, and the file/line/column of each locale's source; an unknown ID is `UNKNOWN_MESSAGE_ID` with a `suggestion`.
- `doctor --json` adds source-usage findings such as `UNUSED_MESSAGE`, scanning `--source-dir` (default `src`). `prune --dry-run --json` lists base messages with no statically recognisable reference and never deletes; dynamic keys cannot be proven by a static scan, so review before removing anything.
- `report --json` returns translation coverage per locale (`translated`, `same`, `blank`, `missing`, `extra`, `coverage`), `namespaces`, `scopes`, ICU `features`, `usage` (`used`, `unused`, `topFiles`, `unknown`, `copies`), generated catalog `sizes` per locale and scope (raw, gzip, brotli; `sizes.available` is false with a `reason` when the project does not compile), `diagnostics` and one `messages` row per ID. `messages`, `usage.unused` and the diagnostic lists are capped by `--limit`. Without `--json`, or with `--out <file>`, it writes a self-contained HTML page (default `nordbeam-locale-report.html`); `--open` opens it. It changes nothing else.
- `hardcoded --json` lists UI text in the source that is not a catalog message: `findings[]` with `file`, `line`, `column`, `text`, `kind`, `where`, `confidence` (`high` or `medium`), `reason` and, for inline translations, `translations` per locale. `summary` counts findings, high and medium ones, text already in the catalog, and files per area; `learned` lists positions that receive messages elsewhere; `ignored` counts what was left out and why. `--confidence high` reports only high-confidence findings. `--strict` exits 1 when any finding remains. It needs the optional dependency `oxc-parser`; without it the command fails with `TEXT_SCANNER_UNAVAILABLE`.

## Commands that change files

| Command | Effect | Preview |
| --- | --- | --- |
| `init [--framework F] [--agent] [--catalogs D] [--base-locale L] [--out-dir D]` | Creates missing config, catalogs, scaffolds, scripts and generated output; never replaces a file | none needed: idempotent |
| `generate [--production\|--development] [--watch]` | Writes generated modules; watch mode needs `--ndjson`, not `--json` | none: idempotent |
| `extract --id <id> --message <text> [--locale L] [--regenerate]` | Adds one message to a catalog (base by default); validates the whole project first | none: immediate write, check the diff |
| `rename --id <old> --to <new> [--source-dir D] [--regenerate]` | Renames a key in all catalogs and recognisable source references | none: immediate write, check the diff |
| `export --locale L [--out <new-file>]` | PO export; JSON output embeds the PO unless `--out` creates a new file | `--out` refuses an existing file |
| `import --locale L --from <po> [--dry-run] [--strict]` | Merges a reviewed PO into one catalog | `--dry-run` |
| `pseudo --locale en-XA [--from-locale L] [--expansion N] [--update] [--dry-run]` | Creates a pseudo-locale; `--update` replaces an existing one | `--dry-run` |
| `schema [--schema-dir D]` | Writes editor JSON schemas (default `.nordbeam`) | none: idempotent |
| `skills install` | Installs the bundled agent skills into the project | `--dry-run` |
| `hardcoded --fix\|--extract [--write] [--regenerate]` | `--fix` replaces hardcoded text with a catalog message that renders the same, adding the translator hook and its import where the file already calls hooks; `--extract` also adds new base messages (high confidence by default) | without `--write`: `plan` lists `edits`, `messages` and `skipped` with a reason each |

`rename`, `extract` and `hardcoded --write` report `stale: true` with `next: "nordbeam-locale generate"` unless `--regenerate` is passed. After `extract`, other locales still lack the key: translate them, or accept `FALLBACK_MESSAGE` warnings.

Migration commands (`migrate`, `migrate-project`, `codemod`, `apply-plan`) are covered in the `nordbeam-locale-migrate` skill and need `@nordbeam/locale-migrate` at the same version.

## NDJSON

`--ndjson` (check, doctor, generate, inspect, migrate, migrate-project, codemod, apply-plan; required for `generate --watch`) streams one JSON event per line. The first line is `{"type":"version","protocol":"nordbeam.i18n","version":1,"events":[...]}`; then `progress`, `diagnostic` and `change` events; the last event is `final` with `status` (`succeeded` or `failed`) and the full `result` or `error`. Use it for long runs and watch mode; read the `final` event for the outcome.

## Plans

Hash-bound plans make bulk source edits reviewable: `codemod ... --plan <new-file> --json` writes a plan (target allow-list, before and after SHA-256, replacement content, plan hash) without touching the sources; `apply-plan --from <plan> --json` validates every target and writes all or none. A second apply reports `status: "already-applied"`. A concurrent edit makes the plan stale (`STALE_PLAN`, exit 4) before anything is written; regenerate the plan, never edit it by hand.

## MCP

```sh
claude mcp add nordbeam-locale -- npx nordbeam-locale mcp
```

Other clients: `{ "mcpServers": { "nordbeam-locale": { "command": "npx", "args": ["nordbeam-locale-mcp"] } } }`. The stdio server works on the current directory (`--root <dir>` and `--config <file>` override). Tools: `check`, `generate`, `inspect_project`, `inspect_message`, `explain_code`, `rename_message`, `find_unused`. A tool failure is a normal result with `isError: true` and `{ code, message, fix?, docs? }`; catalog problems come back as `ok: false` from `check`. Reads are read-only; `generate` is idempotent; `rename_message` is destructive. MCP covers the edit loop; use the CLI for `init`, `verify` and migrations.

## Recommended agent protocol

1. `capabilities --json` once; `inspect --json` and `doctor --json` to learn the project.
2. Preview whatever supports a preview and surface skipped constructs and collisions to the user.
3. Apply, then `check --json`, then the project's own type-check, tests or build.
4. `verify --json` before finishing; fix by editing catalogs or source, never generated files.
