# Agent-first tooling

Nordbeam should be equally operable by a person, a shell-based coding agent, and an MCP client. The core rule is that agents orchestrate deterministic i18n operations; the compiler and migration engine do not embed an LLM.

## What agents get

Run `nordbeam-locale capabilities --json` from any directory to discover the versioned command contract, supported formats, access class, preview behavior, JSON/NDJSON support, output conventions, and recommended verification sequence. Run `nordbeam-locale agent-guide` for a compact instruction block suitable for repository agent guidance.

Exit status is stable and categorical: `0` success, `1` validation failure, `2` usage error, `3` input not found, `4` refused unsafe operation (a stale plan, an existing output file, a strict codemod refusal), and `70` internal error. Each failure with `--json` or `--ndjson` carries a specific `code` in `errors[]` (or in the final NDJSON event), plus structured fields such as `option`, `validValues`, `suggestion`, and project-relative `path`. `capabilities --json` publishes the same table in `exitCodes`.

`nordbeam-locale explain <CODE> [--json]` returns the severity, explanation, actionable fix, and docs anchor for any code the package emits; `docs/reference/errors.md` documents every code. Check and doctor diagnostics include the same `fix` and `docs` fields.

`verify --json` is the gate to run before finishing. It runs `check` and the freshness check, and exits `0` only when there are no errors and the generated output is fresh and unedited. Its failures use `GENERATED_STALE`, `GENERATED_MODIFIED`, or the check's own codes, each with a fix.

`check`, `doctor`, `generate`, `inspect`, and `verify` return a `summary` with error, warning, and per-code counts, cap each list at 50 rows (`--limit <n|all>`), and name the codes you want with `--only CODE[,CODE]`. Repeated `FALLBACK_MESSAGE` and `MISSING_MESSAGE` warnings for one locale and file become one row with a `count`. Paths are project-relative under one absolute `root`.

`inspect --json` returns a read-only snapshot of resolved configuration, locales and catalog counts, generated ownership-manifest completeness, detected Next/Vite integration, and diagnostics. Explicit `generate`, `init`, `schema`, and `export` commands now have JSON output without changing the historical bare generation command.

Long checks, inspection, generation/watch, catalog migrations, project migrations, codemods, and plan application accept `--ndjson`. A version event is always first; operation progress, diagnostics, changes, and a final result follow. Human diagnostics stay off stdout.

Codemods can write a source-bound plan with `--plan <new-file>`. The plan contains normalized operation data, an exact target allow-list, before/after SHA-256 state, replacement content, and a hash of the complete plan. `apply-plan --from <reviewed-plan>` preflights every target before staging any output and rejects stale, missing, unexpected, non-file, or root-mismatched targets. Node integrations use `nordbeam-locale/agent/plans`; event and inspection APIs live under `nordbeam-locale/agent/events` and `nordbeam-locale/agent/inspect`, keeping Node filesystem APIs out of the browser runtime entry.

Agent skills ship in the package so the instructions match the installed CLI: `nordbeam-locale skills install` and `init --agent` copy `nordbeam-locale` and `nordbeam-locale-migrate` into `.claude/skills/` and `.agents/skills/` without overwriting local edits, and the same skills install through the Claude Code plugin marketplace or `npx skills add nordbeam/locale`. See [agent](reference/agent.md#agent-skills) and the [skills README](../skills/README.md).

`capabilities` and `agent-guide` do not discover or load project configuration. Their metadata is exported from `nordbeam-locale/agent`, so wrappers cannot drift from the CLI. `nordbeam-locale mcp` serves the same operations to MCP clients over stdio; see [MCP](reference/mcp.md).

The safe local workflow is:

1. Inspect with `inspect --json` and `doctor --json`.
2. Preview any import, conversion, codemod, pseudo-locale, or full-project migration.
3. Reject collisions and surface every skipped construct or manual action.
4. Apply the same scoped command.
5. Verify with `check --json`, then the application's type-check, tests, or production build.
6. Before finishing, run `verify --json`. It exits `0` only when check passes and the generated output is fresh.

## Why this shape

Machine consumers must not scrape human help text. Versioned JSON and NDJSON follow established CLI automation practice; MCP provides interoperable typed tool discovery rather than replacing a good CLI. A plan/apply boundary is more important than an embedded chatbot because it gives every agent the same reviewable, stale-safe mutation protocol.
