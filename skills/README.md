# Nordbeam Locale agent skills

Two [Agent Skills](https://agentskills.io/specification) that teach coding agents (Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, OpenCode and other Agent Skills clients) to use Nordbeam Locale correctly the first time: the right setup per framework, valid ICU messages, the generated typed API, and the check, generate, verify loop.

| Skill | Use it for |
| --- | --- |
| [`nordbeam-locale`](nordbeam-locale/SKILL.md) | Everyday work in a project that uses Nordbeam Locale: setup for Vite + React, Next.js, Vue, Svelte, Solid and plain TypeScript/Node, editing catalogs, ICU syntax, calling messages, locale switching and routing, diagnostics with `explain`, the JSON and exit-code contract, MCP. |
| [`nordbeam-locale-migrate`](nordbeam-locale-migrate/SKILL.md) | Moving an existing app from i18next, react-i18next, next-i18next, next-intl, FormatJS, react-intl, Lingui, vue-i18n, svelte-i18n, typesafe-i18n, Tolgee, Transloco, ngx-translate or a PO, ARB, YAML, Android or Apple catalog to Nordbeam Locale, with the preview, review, apply, verify protocol. |

Each skill is a `SKILL.md` with a trigger description plus `references/` files that the agent reads only when needed (one per framework or source library). The descriptions make the skills fire for i18n, translation, locale and plural tasks in projects that use Nordbeam Locale, and for moving off another i18n library, without firing in projects that use a different library.

## Install

Pick one path. All three install the same files.

### 1. Claude Code plugin marketplace

```sh
/plugin marketplace add nordbeam/locale
/plugin install nordbeam-locale@nordbeam
```

The marketplace is named `nordbeam` and its plugin `nordbeam-locale` exposes both skills. Skills of a plugin are namespaced in Claude Code (for example `/nordbeam-locale:nordbeam-locale`). Update with `/plugin marketplace update nordbeam`.

### 2. `npx skills` (any agent)

```sh
npx skills add nordbeam/locale
npx skills add nordbeam/locale --skill nordbeam-locale   # only one
```

The [`skills` CLI](https://github.com/vercel-labs/skills) finds `skills/*/SKILL.md` in this repository and installs them for the agents it detects: `.claude/skills/` for Claude Code, `.agents/skills/` for Codex, Cursor, Copilot, Gemini CLI, OpenCode and others. Add `-g` to install for your user instead of the project.

### 3. From the npm package (version-matched)

The skills ship inside `nordbeam-locale`, the CLI package, so the copy in a project always matches the CLI version installed there:

```sh
npx nordbeam-locale init --agent          # AGENTS.md block + skills (works on an existing config too)
npx nordbeam-locale skills install        # skills only; add --dry-run to preview
npx nordbeam-locale skills install --target claude --skill nordbeam-locale
```

Files go to `.claude/skills/<name>/` (Claude Code) and `.agents/skills/<name>/` (the cross-client convention read by Codex, Cursor, Copilot, Gemini CLI, OpenCode and others). Cursor also reads `.claude/skills/`. Installation never overwrites local edits: each skill directory carries a `.nordbeam-skill.json` ownership record with the hash of every file written, and a later `skills install` (or `init --agent`) after upgrading the package only replaces files that are still byte-identical to what it wrote. Everything else is reported as `skipped` with a reason, and a skill directory that is a symbolic link (for example one created by `npx skills`) is left alone. Run `skills install` again after upgrading `@nordbeam/locale` to refresh the skills.

## Layout

```
skills/
  nordbeam-locale/
    SKILL.md                      workflow, rules, framework chooser (kept short)
    references/                   vite-react, next, tanstack-start, vue, svelte, solid, node,
                                  icu-messages, cli-agent-contract, troubleshooting
    evals/                        evals.json (task prompts + expectations), trigger-evals.json
  nordbeam-locale-migrate/
    SKILL.md                      preview, review, apply, verify protocol
    references/                   one file per source library, catalog-formats,
                                  skipped-constructs, finishing
    evals/
```

`evals/` is for maintainers: it is not published in the npm package and not copied into projects. `evals.json` follows the skill-creator format (`prompt`, `expected_output`, `expectations`); `trigger-evals.json` lists realistic prompts that should and should not trigger the skill, for tuning the descriptions.

## Maintaining the skills

- Every command, option, import path and code sample is checked against the real CLI and package exports by `test/skills.test.mjs` (also: frontmatter parses as strict YAML, `name` matches the directory, descriptions stay within 1024 characters, `SKILL.md` stays under 500 lines, relative links resolve, the marketplace manifest lists both skills, and `evals/` is not packed).
- When a CLI command, flag, scaffold or API changes, update the matching reference file in the same change. Prefer pointing at `nordbeam-locale capabilities --json` and `explain` over copying lists that can drift.
- To add a framework, add `references/<framework>.md` and one row to the framework table in `nordbeam-locale/SKILL.md`; to add a source library, add `references/<library>.md` and one row to the table in `nordbeam-locale-migrate/SKILL.md`.
- Keep descriptions free of `: ` and ` #` sequences: several skill loaders parse the frontmatter with strict YAML.
- Validate the Claude Code marketplace with `claude plugin validate .`.
