# Contributing to Nordbeam Locale

Thanks for helping. Bug reports, documentation fixes, reproductions, and pull
requests are all welcome. By participating you agree to follow the
[code of conduct](CODE_OF_CONDUCT.md).

## Before you start

- For a bug, open an issue with a minimal reproduction: the catalog, the
  config, the command or import you ran, and the output you expected.
- For a new feature, adapter, or public API, open an issue first so the design
  can be agreed before you write code.
- Security problems go through the [security policy](SECURITY.md), not public
  issues.

## Repository layout

| Path | Contents |
| --- | --- |
| `src/` | `nordbeam-locale`, the tooling: compiler, CLI, Vite and Next.js plugins, test helpers, agent tooling, MCP server |
| `packages/locale/` | `@nordbeam/locale`, the runtime: locale store, framework adapters, `rich()`, inspector |
| `packages/locale-migrate/` | `@nordbeam/locale-migrate`: catalog and source migrations, codemods |
| `skills/` | Agent skills that ship with `nordbeam-locale` |
| `editors/vscode/` | The VS Code extension |
| `examples/` | Vite, React SSR, and Next.js applications used by the integration checks |
| `test/` | `node:test` suites, run against the built `dist/` and `packages/*/dist/`; `test/integration/` holds the browser and framework checks, and `test/baselines/` earlier compiler builds that output is compared against |
| `docs/` | Guides and one reference page per public entry point |

## Development

Requirements: Node 22.12 or newer and npm.

```sh
npm ci
npm test            # build both packages, then run the unit and integration tests
```

`npm test` is the fast loop. Before opening a pull request that touches a
framework adapter, the Vite plugin, or generation, also run the integration
checks that CI runs:

```sh
npm run check       # npm test + Vite example + React SSR + Next.js (Turbopack, webpack, RTL, PPR)
npm run vscode:check
```

Tests import from `dist/`, so rebuild (`npm run build`) after changing `src/`
when you run a single file with `node --test test/<name>.test.mjs`.

## Conventions

- **Generated files are never edited by hand.** Change the compiler or the
  catalogs and regenerate.
- **Every diagnostic has a code.** A new error or warning code goes in
  `src/error-codes.ts` with an entry in `docs/reference/errors.md`; the
  registry tests fail otherwise.
- **Every public entry point has a reference page** in `docs/reference/`.
  Relative links in `README.md` and `docs/` are checked by
  `test/docs-links.test.mjs`.
- **Machine output is a contract.** Changes to `--json`/`--ndjson` envelopes,
  exit codes, or `capabilities --json` need tests and a note in
  `docs/reference/agent.md`.
- **The runtime stays small.** Keep Node built-ins and parsers out of the
  browser entry points, and keep `sideEffects: false` true.
- **Performance claims need evidence.** Don't add numbers to the docs without
  a reproducible measurement behind them.
- Match the style of the surrounding code. Commit messages follow
  [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`,
  `fix:`, `docs:`, `test:`, `chore:`).

## Pull requests

1. Fork and branch from `main`.
2. Add or update tests and docs with the change.
3. Run `npm test` (and `npm run check` for integration-affecting changes).
4. Add a line under "Unreleased" in [CHANGELOG.md](CHANGELOG.md) for
   user-visible changes.
5. Open the pull request and describe what changed and how you verified it.

## License

Nordbeam Locale is licensed under the [Apache License 2.0](LICENSE). Unless you
state otherwise, any contribution you submit for inclusion is licensed under
the same terms, as described in section 5 of the license.
