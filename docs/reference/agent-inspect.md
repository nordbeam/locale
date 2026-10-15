# Agent inspection — `@nordbeam/locale/agent/inspect`

This entry re-exports project inspection helpers for local automation.

```ts
import { inspectProject } from '@nordbeam/locale/agent/inspect';
```

Inspection is read-only: it resolves configuration, locales, catalog counts,
generated ownership, framework detection, and diagnostics.

`inspectProject(options, configFile)` also reports:

- `freshness.status`: `fresh`, `stale` (an input changed), `modified` (a
  generated file was edited by hand), `missing` (a generated file is absent) or
  `unknown` (an old manifest without recorded inputs).
- `freshness.staleReason` names the catalog, options or compiler that changed.
  `freshness.modifiedFiles` names the edited output files. Each item has a
  `next` command, `nordbeam-locale`, which regenerates the output.
- Each catalog's `untranslatedCount` counts base-locale IDs that are missing from
  the catalog or blank in it. `missingCount` counts only the absent ones.

The CLI shapes this result for `inspect --json` and `verify --json`: the same
data, with a `summary`, capped lists, and paths relative to one absolute `root`.
`inspectProject` itself keeps absolute paths and full lists.

`inspectMessage(options, id)` describes one message: which locales have it and
which are missing or untranslated, its arguments and their types, each locale's
source text, the line and column of each entry in its catalog file, and the
access expression in the generated module.
