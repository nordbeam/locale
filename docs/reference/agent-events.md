# Agent events — `nordbeam-locale/agent/events`

This entry re-exports the NDJSON event constructors and the stdout writer used
by the CLI's machine-readable mode. Pass `--ndjson` to a command to receive its
run as an event stream on stdout. Human logs and warnings stay on stderr.

```ts
import { createStdoutNdjsonWriter, progressEvent } from 'nordbeam-locale/agent/events';
```

## Stream rules

- Each line of stdout is one JSON object, serialized with keys sorted
  alphabetically and terminated by `\n`.
- The first line is always a `version` event. It is written once per writer.
- Every event carries `version: 1`, `type`, and, when the CLI emits it,
  `operationId`. The `operationId` is a UUID shared by every event of one
  operation. Watch mode starts a new `operationId` for each rebuild.
- Events are ordered: `progress` (start), then `diagnostic` and `change` events,
  then `progress` (completed), then exactly one `final`.
- `timestamp` (RFC 3339 string) and `sequence` (non-negative safe integer) can
  be supplied by callers of the constructors. The CLI does not set them.
- Optional fields are omitted when unset.
- Consumers should ignore unknown fields and unknown event types. The `version`
  event lists the event types a stream may contain.

## Event types

### `version`

The first record of every stream.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `version` | `1` | yes | Event protocol version. |
| `type` | `"version"` | yes | |
| `protocol` | string | yes | `"nordbeam.i18n"`. |
| `events` | `["progress", "diagnostic", "change", "final"]` | yes | Event types that may follow. |

### `progress`

Coarse progress for an operation. The CLI emits a start event with
`completed: 0, total: 1` and a completed event with `completed: 1, total: 1`.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `version` | `1` | yes | |
| `type` | `"progress"` | yes | |
| `operationId` | string | yes | Non-empty. |
| `timestamp` | string | no | |
| `sequence` | integer ≥ 0 | no | |
| `phase` | string | no | The command name, for example `"check"` or `"apply-plan"`. |
| `completed` | number ≥ 0 | yes | Must not exceed `total` when `total` is set. |
| `total` | number ≥ 0 | no | |
| `message` | string | no | Human-readable status. |
| `details` | JSON value | no | Free-form extra data. |

### `diagnostic`

One compiler, validation, or planning message. Commands with a `result.errors`
or `result.warnings` array emit one diagnostic event per item.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `version` | `1` | yes | |
| `type` | `"diagnostic"` | yes | |
| `operationId` | string | yes | |
| `timestamp` | string | no | |
| `sequence` | integer ≥ 0 | no | |
| `severity` | `"info"` \| `"warning"` \| `"error"` | yes | Defaults to `"info"` in the constructor. |
| `message` | string | yes | Non-empty. May contain newlines. |
| `code` | string | no | Stable machine code such as `INVALID_ICU` or `STALE_PLAN`. |
| `path` | string | no | Absolute source path. The CLI omits it when the project root is known, because `file` then carries the project-relative path. |
| `file` | string | no | Path relative to the project root, with forward slashes. Present only when the root is known. |
| `line` | integer ≥ 1 | no | When `file` is set, the line in that file. Otherwise the line inside the ICU message. |
| `column` | integer ≥ 1 | no | Same source as `line`. |
| `messageId` | string | no | The catalog key that failed, for example `"cart.total"`. |
| `locale` | string | no | Locale of the catalog that failed. |
| `hint` | string | no | Suggested fix. |
| `details` | JSON value | no | Free-form extra data. |

### `change`

One entry from a command's `changed` result array. A command that wrote nothing
emits no `change` events.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `version` | `1` | yes | |
| `type` | `"change"` | yes | |
| `operationId` | string | yes | |
| `timestamp` | string | no | |
| `sequence` | integer ≥ 0 | no | |
| `action` | `"add"` \| `"update"` \| `"remove"` | yes | |
| `key` | string | no | The changed file path, relative to the project root. |
| `locale` | string | no | |
| `before` | JSON value | no | Prior state, when the emitter supplies it. |
| `after` | JSON value | no | New state, when the emitter supplies it. |

### `final`

Exactly one per operation, last in the stream. The process exit code is `0` for
`succeeded` and `1` for `failed`.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `version` | `1` | yes | |
| `type` | `"final"` | yes | |
| `operationId` | string | yes | |
| `timestamp` | string | no | |
| `sequence` | integer ≥ 0 | no | |
| `status` | `"succeeded"` \| `"failed"` \| `"cancelled"` | yes | |
| `summary` | string | no | For example `"check failed"`. |
| `result` | JSON value | no | The command's result fields, the same data `--json` prints. `ok` appears inside it for commands that report it. |
| `error` | `{ code?: string, message: string }` | no | Set when the command threw. |

A `failed` final event has either `result` (the command ran and reported
`ok: false`) or `error` (the command threw). It never has both.

## `final` and `--json`

`final.result` carries the same payload that `--json` prints, so an agent can
read either format and get the same data.

| Outcome | `--json` stdout | `--ndjson` final event |
| --- | --- | --- |
| Success | `{"version":1,"ok":true, ...result}` | `status: "succeeded"`, `result` = the result fields |
| Command reports `ok: false` (for example `check` with invalid catalogs) | `{"version":1,"ok":false, ...result}` | `status: "failed"`, `result` = the result fields, no `error` |
| Command throws | `{"version":1,"ok":false,"errors":[{"code","message",...}]}` | `status: "failed"`, `error: { code, message }`, no `result` |

Differences to keep in mind:

- `--json` puts `version` and `ok` at the top level. The NDJSON `final` event
  puts `status` at the top level and omits both.
- `--json` lists problems in `errors` and `warnings`. The NDJSON stream emits
  each of them as a `diagnostic` event before `final`. The `final` result still
  contains the same arrays, so read `diagnostic` events for streaming and
  `final.result` for the complete picture.
- For `check`, `doctor`, `generate`, `inspect` and `verify`, `final.result` is the
  same summarized result as `--json`: `summary`, lists capped at 50 rows, and
  project-relative paths under one `root`. See [agent protocol](agent.md#changes-in-02).
- A thrown error appears in `--json` as `errors[0]`. In NDJSON it appears as
  `final.error`, and it is also emitted as one or more `diagnostic` events before
  `final`.
- `error.code` is the first diagnostic's code when the error is a compile error,
  so `INVALID_ICU` is reported as itself and not as `CLI_ERROR`. Plan errors use
  their own codes, such as `STALE_PLAN`. Any other thrown error uses `CLI_ERROR`.

## Examples

Abbreviated transcripts. `operationId` values are replaced with `op-1` and the
plan hash with `<planHash>`. Long `error.message` and `result` values are
shortened, so fields may be omitted here.

### Success: applying a plan

```json
{"events":["progress","diagnostic","change","final"],"protocol":"nordbeam.i18n","type":"version","version":1}
{"completed":0,"message":"Operation started.","operationId":"op-1","phase":"apply-plan","total":1,"type":"progress","version":1}
{"action":"update","key":"generated/a.ts","operationId":"op-1","type":"change","version":1}
{"completed":1,"message":"Operation completed.","operationId":"op-1","phase":"apply-plan","total":1,"type":"progress","version":1}
{"operationId":"op-1","result":{"changed":["generated/a.ts"],"planHash":"<planHash>","rolledBack":false,"status":"applied"},"status":"succeeded","summary":"apply-plan completed","type":"final","version":1}
```

### Success: re-applying an applied plan

The targets already hold their planned content, so nothing is written and no
`change` events are emitted.

```json
{"events":["progress","diagnostic","change","final"],"protocol":"nordbeam.i18n","type":"version","version":1}
{"completed":0,"message":"Operation started.","operationId":"op-1","phase":"apply-plan","total":1,"type":"progress","version":1}
{"completed":1,"message":"Operation completed.","operationId":"op-1","phase":"apply-plan","total":1,"type":"progress","version":1}
{"operationId":"op-1","result":{"changed":[],"planHash":"<planHash>","rolledBack":false,"status":"already-applied"},"status":"succeeded","summary":"apply-plan completed","type":"final","version":1}
```

### Failure: a compile error

`generate` stops on an invalid ICU message. The diagnostic carries the catalog
location, and `final.error.code` keeps the ICU code.

```json
{"events":["progress","diagnostic","change","final"],"protocol":"nordbeam.i18n","type":"version","version":1}
{"completed":0,"message":"Operation started.","operationId":"op-1","phase":"generate","total":1,"type":"progress","version":1}
{"code":"INVALID_ICU","column":41,"file":"messages/en.json","hint":"Close the argument with }. To display a literal brace, quote it with ICU apostrophes.","line":1,"locale":"en","message":"An ICU argument is missing its closing brace.","messageId":"bad","operationId":"op-1","severity":"error","type":"diagnostic","version":1}
{"error":{"code":"INVALID_ICU","message":"messages/en.json:1:41\n[INVALID_ICU] en:bad: An ICU argument is missing its closing brace.\n…"},"operationId":"op-1","status":"failed","summary":"generate failed","type":"final","version":1}
```

### Failure: a stale plan

The catalog changed after the plan was reviewed. Nothing is written.

```json
{"events":["progress","diagnostic","change","final"],"protocol":"nordbeam.i18n","type":"version","version":1}
{"completed":0,"message":"Operation started.","operationId":"op-1","phase":"apply-plan","total":1,"type":"progress","version":1}
{"code":"STALE_PLAN","message":"Target changed after planning: generated/a.ts.","operationId":"op-1","severity":"error","type":"diagnostic","version":1}
{"error":{"code":"STALE_PLAN","message":"Target changed after planning: generated/a.ts."},"operationId":"op-1","status":"failed","summary":"apply-plan failed","type":"final","version":1}
```

### Failure: a check that reports problems

`check` completed and found an error, so it reports `ok: false` in `result`
rather than throwing. The error also appears as a `diagnostic` event.

```json
{"events":["progress","diagnostic","change","final"],"protocol":"nordbeam.i18n","type":"version","version":1}
{"completed":0,"message":"Operation started.","operationId":"op-1","phase":"check","total":1,"type":"progress","version":1}
{"code":"INVALID_ICU","column":41,"file":"messages/en.json","line":1,"locale":"en","message":"An ICU argument is missing its closing brace.","messageId":"bad","operationId":"op-1","severity":"error","type":"diagnostic","version":1}
{"completed":1,"message":"Operation completed.","operationId":"op-1","phase":"check","total":1,"type":"progress","version":1}
{"operationId":"op-1","result":{"errors":[{"code":"INVALID_ICU","file":"/abs/project/messages/en.json","line":1,"column":41,"locale":"en","messageId":"bad","message":"An ICU argument is missing its closing brace."}],"locales":["en","fr"],"messageCount":3,"ok":false,"warnings":[]},"status":"failed","summary":"check failed","type":"final","version":1}
```

## Programmatic use

```ts
import { createStdoutNdjsonWriter, diagnosticEventFrom, finalErrorFrom, finalEvent } from 'nordbeam-locale/agent/events';

const writer = createStdoutNdjsonWriter(process.stdout);
const operationId = crypto.randomUUID();
try {
  await writer.emit(diagnosticEventFrom(diagnostic, { operationId, severity: 'error', root: projectRoot }));
  await writer.emit(finalEvent({ operationId, status: 'failed', error: finalErrorFrom(error, 'CLI_ERROR') }));
} finally {
  await writer.flush();
}
```

Constructors validate their input and throw `TypeError` or `RangeError` for
invalid values. `diagnosticEventFrom` builds an event from a compiler
`Diagnostic`, so location and message identity fields are not copied by hand.
`finalEvent` given a `CompileError` as `error` already uses its first
diagnostic's code.
