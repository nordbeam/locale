# Development inspector — `@nordbeam/locale/inspector`

Inspect message keys, locales, arguments, results, errors, and call durations in
a development-only overlay.

```ts
import { createMessageInspector, mountInspectorOverlay } from '@nordbeam/locale/inspector';
```

- `createMessageInspector(options?)` — create a bounded inspection recorder.
- `mountInspectorOverlay(inspector, options?)` — mount the browser overlay.
- `MessageInspection`, `MessageInspector`, `MessageInspectorOptions`, and
  overlay/handle types describe the API.

Keep this entry behind a development import or flag.
