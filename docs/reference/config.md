# Configuration — `@nordbeam/locale/config`

Use these helpers when embedding discovery or validation in local tooling.

```ts
import {
  discoverConfig, readConfig, validateConfig, resolveKeyPolicy,
} from '@nordbeam/locale/config';
```

- `configName` — `nordbeam-locale.config.json`.
- `legacyConfigName` — bounded `nordbeam-i18n.config.json` and
  `fasti18n.config.json` fallbacks; new projects should use `configName`.
- `validateConfig(value, file?)` — assert and report valid config shape.
- `discoverConfig(root)` — locate the current config.
- `readConfig(file, required?)` — read and validate config values.
- `notes` — a JSON file of [notes about messages](../GUIDE.md#notes-about-messages),
  shaped like a catalog, relative to the config and outside the catalog
  directory.
- `lockedKeys` and `ignoredKeys` — exact IDs or dotted `prefix.*` patterns for
  source-verbatim and excluded messages; overlap is rejected during validation.
- `resolveKeyPolicy(id, options)` — return the validated lock/ignore decision
  for a message ID.
