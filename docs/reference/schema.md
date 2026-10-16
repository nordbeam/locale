# JSON schemas — `nordbeam-locale/schema`

Build editor schemas without importing a JSON Schema runtime.

```ts
import { catalogSchema, configSchema } from 'nordbeam-locale/schema';
```

- `catalogSchema(catalog, baseLocale?)` — schema for nested catalog keys.
- `configSchema` — schema for `nordbeam-locale.config.json`.
- `JsonSchema` — schema object type.

The CLI materializes these with `nordbeam-locale schema`; see [Editor support](../EDITOR.md).
