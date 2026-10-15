# Development inspector — `@nordbeam/locale/inspector`

Inspect message keys, locales, arguments, results, errors, and call durations in
a development-only overlay, and find text on the page that no message rendered.

```ts
import { createMessageInspector, mountInspectorOverlay, scanRenderedText } from '@nordbeam/locale/inspector';

const inspector = createMessageInspector({ locale });
const m = inspector.wrap(messages);
mountInspectorOverlay(inspector);
```

- `createMessageInspector(options?)` — create a bounded inspection recorder.
  `wrap(messages, locale?)` returns messages that record each call.
  `renderedTexts()` returns the distinct texts the wrapped messages returned.
- `mountInspectorOverlay(inspector, options?)` — mount the browser overlay. Its
  **Find hardcoded text** button runs `scanRenderedText` on the page, lists the
  results, outlines each element, and scrolls to one when you click it.
  `options.text` passes options to the check.
- `scanRenderedText(inspector, options?)` — return the text on the page, and in
  `placeholder`, `title`, `alt`, `aria-label` and `aria-description` attributes
  and button values, that no wrapped message rendered: `{ text, element,
  attribute?, path }`. Text that does not read as UI copy (numbers, code, URLs,
  names), the inspector's own overlay, and elements marked `translate="no"`,
  `class="notranslate"`, `data-nordbeam-locale-ignore`, `hidden`, or inside
  `code`, `pre` and `textarea` are skipped. `options.root` picks the subtree,
  `options.attributes` the attributes, and `options.ignore` takes strings or
  regular expressions to accept.
- `MessageInspection`, `MessageInspector`, `MessageInspectorOptions`,
  `RenderedTextFinding`, `RenderedTextOptions`, and the overlay and handle types
  describe the API.

The check reads the DOM as it is, so open each screen, menu and dialog before
running it. It complements `nordbeam-locale hardcoded`, which reads the source
and cannot see text that arrives at runtime.

Keep this entry behind a development import or flag.
