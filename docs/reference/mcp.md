# MCP server

`nordbeam-locale-mcp` runs Nordbeam Locale as a [Model Context Protocol](https://modelcontextprotocol.io) server over stdio. Coding agents such as Claude Code call its tools to check catalogs, inspect a message, explain a diagnostic code or rename a message, instead of parsing CLI output.

The server speaks newline-delimited JSON-RPC 2.0 on stdin and stdout. Diagnostics go to stderr. It has no dependencies beyond the package itself.

## Setup

Claude Code:

```sh
claude mcp add nordbeam-locale -- npx nordbeam-locale-mcp
```

Any client that reads an `mcpServers` object:

```json
{
  "mcpServers": {
    "nordbeam-locale": {
      "command": "npx",
      "args": ["nordbeam-locale-mcp"]
    }
  }
}
```

The server works on the project in its current directory. Pass `--root <dir>` to choose another project root, and `--config <file>` to use a configuration file other than the one discovered under the root. Relative `--config` paths resolve against the root. Each tool call reads the configuration again, so edits apply without restarting the server.

`nordbeam-locale mcp` starts the same server from the main CLI, for example `claude mcp add nordbeam-locale -- npx nordbeam-locale mcp`. It accepts `--config`; the project root is the current directory.

## Tools

Every tool returns structured content. The text content holds the same JSON, for clients that read text only. File paths are relative to the project root, with forward slashes.

| Tool | Read-only | Inputs | Output |
| --- | --- | --- | --- |
| `check` | yes | `limit` (default 20) | `ok`, `errorCount`, `warningCount`, first `errors` and `warnings` |
| `generate` | no (idempotent) | none | `changed` paths, `count`, `warnings` |
| `inspect_project` | yes | none | `ok`, `config`, `locales`, `messageCount`, per-locale counts, `generated`, `freshness` |
| `inspect_message` | yes | `id` (required) | `present`, `missing`, `untranslated`, `arguments`, `export`, and each locale's source and position |
| `explain_code` | yes | `code` (required) | `severity`, `explanation`, `fix`, `docs`, `exitCode` when set |
| `rename_message` | no (destructive) | `from`, `to` (required), `regenerate` (default `true`) | `locales`, `changed` paths, `regenerated`, `generated`, `stale`, `next` |
| `find_unused` | yes | `limit` (default 50) | `ok`, `unused` IDs, `unusedCount`, `unknownReferences`, `unknownReferenceCount` |
| `find_hardcoded` | yes | `limit` (default 50), `high` (default `false`) | `ok`, `sourceFiles`, `summary` counts, `findings` with `file`, `line`, `column`, `text`, `confidence`, `where`, `reason`, `catalog`, `translations`, and `findingCount` |

`find_hardcoded` needs the optional dependency `oxc-parser`; without it the call fails with `TEXT_SCANNER_UNAVAILABLE`. It only reads. To change source, run `nordbeam-locale hardcoded --fix` or `--extract`, which preview until `--write`.

A diagnostic in `check`, `find_unused` or a failure carries `code`, `message`, `locale`, `messageId`, `file`, `line`, `column`, `hint`, `fix` and `docs` where they apply. `fix` and `docs` come from the [error code registry](errors.md).

Tool calls take only the arguments listed above. An unknown argument is an error.

## Errors

There are two kinds of failure.

- A tool failure is a normal result with `isError: true`. Its content is `{ code, message, fix?, docs? }`, and extra fields such as `suggestions` for `explain_code` or `errors` for a compile failure. Examples are an unknown message ID (`UNKNOWN_MESSAGE_ID`), a rename onto an existing ID (`MESSAGE_ALREADY_EXISTS`), an unreadable configuration (`INVALID_CONFIG`) and an unknown code given to `explain_code` (`USAGE`). Catalog problems do not set `isError`: `check` returns `ok: false` with its diagnostics.
- A protocol problem is a JSON-RPC error: `-32700` for a line that is not JSON, `-32600` for an invalid request, `-32601` for an unknown method, and `-32602` for an unknown tool or arguments that fail the input schema.

A bad line never stops the server. Requests are answered in the order they arrive. The server exits with status 0 when stdin closes.

## Compatibility

The server accepts protocol versions `2025-06-18`, `2025-03-26` and `2024-11-05`, and answers with the version the client asked for when it is one of these. Other versions get `2025-06-18`.
