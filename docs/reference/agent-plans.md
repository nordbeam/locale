# Agent plans — `@nordbeam/locale/agent/plans`

This entry re-exports the plan parser and application API from the core plan
module. Use it when an automation needs a reviewable write plan.

```ts
import { parsePlan, applyPlan, serializePlan } from '@nordbeam/locale/agent/plans';
```

Plan application is explicit and should be kept separate from read-only
inspection in automation.

## Applying a plan

`applyPlan` returns an `ApplyResult`:

| Field | Meaning |
| --- | --- |
| `planHash` | Hash of the plan that was applied. |
| `status` | `"applied"` when files were written. `"already-applied"` when every target already held its planned content, so nothing was written. |
| `changed` | Paths written by this call. Empty for `already-applied`. |
| `rolledBack` | Always `false` on success. |

Re-applying a plan is therefore safe: a second run reports `already-applied`
and does not touch any file.

A plan is rejected with `STALE_PLAN` when a target differs from its planned
before-content. Its message names every file that does not match. When some
targets already hold the planned content and others do not, the message starts
with `Plan is partially applied; already at planned content: …` and lists the
files that differ. Nothing is written in either case. Plans that have never
been applied keep the same errors as before (`MISSING_TARGET`,
`UNEXPECTED_TARGET`, and `STALE_PLAN`).
