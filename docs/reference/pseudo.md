# Pseudo-localization — `nordbeam-locale/pseudo`

Expand visible text for layout and localization QA while preserving ICU shape.

```ts
import { pseudoLocalizeMessage, pseudoLocalizeCatalog } from 'nordbeam-locale/pseudo';
```

- `pseudoLocalizeMessage(source, { expansion? })` — transform one ICU message.
- `pseudoLocalizeCatalog(catalog, { expansion? })` — transform a catalog.

The CLI writes a target locale only with an explicit update option.
