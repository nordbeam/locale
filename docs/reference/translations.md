# PO translations — `@nordbeam/locale/translations`

This entry exports dependency-free PO transport helpers.

```ts
import { exportPo, importPo } from '@nordbeam/locale/translations';
```

- `TranslationOptions` and `ImportPoOptions` — locale and project inputs.
- `ExportPoResult` and `ImportPoResult` — transport result types.
- `exportPo(options)` — produce UTF-8 ICU-in-PO text.
- `importPo(options)` — validate and merge reviewed translations.
- `serializePo(options)` and `mergePo(options)` — pure in-memory PO
  serialization and merge helpers, also available from
  `@nordbeam/locale/po`; they do not read or write files.

With a configured [notes file](../GUIDE.md#notes-about-messages), `exportPo`
writes each message's note as `#.` comments above its entry, and `serializePo`
does the same with its `notes` option. Imports skip them.

Use `--dry-run` in the CLI or equivalent options before committing a catalog.
`exportPo` and `importPo` are the file-backed project workflow; use the pure
helpers when a worker or service owns storage separately.
