# Editor support

Nordbeam Locale exposes two dependency-free JSON Schema builders:

- `catalogSchema(baseCatalog, locale)` describes the base catalog's nested keys
  and includes the source ICU text in `x-nordbeam` metadata for editor
  integrations.
- `configSchema` describes `nordbeam-locale.config.json`, including scopes, format
  overrides, caches, and artifact options.

The builders are editor metadata only and are not imported by the runtime.
Materialize both schemas whenever the base catalog changes:

```sh
npx nordbeam-locale schema
```

This refreshes `.nordbeam/catalog.schema.json` and
`.nordbeam/config.schema.json` without changing application bundles.

## VS Code

Build a schema file from `configSchema` and point your config at it (the
`$schema` field is accepted and ignored by the compiler):

```json
{
  "$schema": "./.nordbeam/config.schema.json",
  "baseLocale": "en",
  "catalogs": "messages",
  "outDir": "src/i18n"
}
```

Associate the catalog schema with all locale files from workspace settings:

```json
{
  "json.schemas": [
    {
      "fileMatch": ["/messages/.*\\.json$"],
      "url": "./.nordbeam/catalog.schema.json"
    }
  ]
}
```

The schema intentionally does not mark keys as required: translated catalogs may
be sparse and the compiler's fallback policy remains authoritative. Unknown keys
and malformed catalog shapes are still rejected by `nordbeam-locale check`.

For custom editors and other tools, the same builders are available without
reading generated files:

```ts
import { catalogSchema, configSchema } from '@nordbeam/locale/schema';

const schema = catalogSchema(baseCatalog, 'en');
```

`validateConfig(value, file)` is also exported from `@nordbeam/locale/config` for tools
that want the same actionable checks as the CLI without installing a JSON Schema
validator.

## In-context development inspector

The optional `@nordbeam/locale/inspector` entry instruments generated functions in a
development-only browser entrypoint. It is not imported by generated modules or
the normal runtime package:

```ts
import { createMessageInspector, mountInspectorOverlay } from '@nordbeam/locale/inspector';

const inspector = createMessageInspector({ locale: 'en' });
const messages = inspector.wrap(await loadLocale('en').then(result => result.messages));
mountInspectorOverlay(inspector);

messages.product.price({ amount: 12 });
```

The inspector records the canonical dotted key, locale, shallow argument context,
result or thrown error, call duration, and timestamp. It preserves both flat
bracket access and nested property access. Records are bounded (500 by default)
and subscribers are isolated from application errors, so an overlay cannot break
the page. Keep the import behind a development flag or dynamic import; production
builds that do not reference this entry pay zero bytes and zero call overhead.
