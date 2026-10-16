# Package reference

Each public package export has a reference entry; related exports may share a
page. Examples show the stable import path; generated application modules under
`src/i18n` are described in the [guide](../GUIDE.md) and are not package exports.

## Runtime: `@nordbeam/locale`

What an application imports at runtime. A dependency, with no dependencies of its own.

| Entry | Reference |
| --- | --- |
| `@nordbeam/locale` | [core](index.md) |
| `@nordbeam/locale/react` | [React](react.md) |
| `@nordbeam/locale/react/rich` | [React rich](react-rich.md) |
| `@nordbeam/locale/vue` | [Vue](vue.md) |
| `@nordbeam/locale/svelte` | [Svelte](svelte.md) |
| `@nordbeam/locale/solid` | [Solid](solid.md) |
| `@nordbeam/locale/next` | [Next config](next.md) |
| `@nordbeam/locale/next/runtime` | [Next runtime](next-runtime.md) |
| `@nordbeam/locale/next/middleware` | [Next middleware](next-middleware.md) |
| `@nordbeam/locale/next/navigation` | [Next navigation](next-navigation.md) |
| `@nordbeam/locale/next/routing` | [Next routing](next-routing.md) |
| `@nordbeam/locale/next/server` | [Next server](next-server.md) |
| `@nordbeam/locale/tanstack-start` | [TanStack Start](tanstack-start.md) |
| `@nordbeam/locale/inspector` | [inspector](inspector.md) |

## Tooling: `nordbeam-locale`

The CLI and everything that runs at build, test or development time. A devDependency.

| Entry | Reference |
| --- | --- |
| `nordbeam-locale/project` (also `nordbeam-locale`) | [project](project.md) |
| `nordbeam-locale/compiler` | [compiler](compiler.md) |
| `nordbeam-locale/translations` | [translations](translations.md) |
| `nordbeam-locale/po` | [PO helpers](translations.md) |
| `nordbeam-locale/vite` | [Vite](vite.md) |
| `nordbeam-locale/next` | [Next config](next.md) |
| `nordbeam-locale/schema` | [schema](schema.md) |
| `nordbeam-locale/config` | [config](config.md) |
| `nordbeam-locale/pseudo` | [pseudo-localization](pseudo.md) |
| `nordbeam-locale/testing` | [testing](testing.md) |
| `nordbeam-locale/agent` | [agent protocol](agent.md) |
| `nordbeam-locale/agent/plans` | [agent plans](agent-plans.md) |
| `nordbeam-locale/agent/events` | [agent events](agent-events.md) |
| `nordbeam-locale/agent/inspect` | [agent inspect](agent-inspect.md) |
| `nordbeam-locale/mcp` | [MCP server](mcp.md) |

## Migration: `@nordbeam/locale-migrate`

Only while moving from another i18n library. A devDependency at the same version as `nordbeam-locale`.

| Entry | Reference |
| --- | --- |
| `@nordbeam/locale-migrate/codemods` | [codemods](codemods.md) |
| `@nordbeam/locale-migrate/project` | [project migration](migrate-project.md) |
| `@nordbeam/locale-migrate/next` | [Next migration](migrate-next.md) |
| `@nordbeam/locale-migrate/react` | [React migration](migrate-react.md) |
| `@nordbeam/locale-migrate/frameworks` | [framework migration](migrate-frameworks.md) |
| `@nordbeam/locale-migrate/catalog` | [catalog migration](../MIGRATION.md#migrating-an-existing-catalog) |

Command-line references:

- [Error and diagnostic codes](errors.md): every code, its exit status and its fix. `nordbeam-locale explain <CODE>` prints the same entry.
- [MCP server](mcp.md): `nordbeam-locale mcp` or `nordbeam-locale-mcp`, for coding agents.
