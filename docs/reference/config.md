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
- `intlLocales` — the BCP 47 tag that `Intl` formats a locale with, by locale
  code, for a code that means another language to `Intl`: `{ "se": "sv" }`
  keeps the `se` catalog and formats it as Swedish. See
  [locale codes that mean another language](../GUIDE.md#locale-codes-that-mean-another-language).
- `notes` — a JSON file of [notes about messages](../GUIDE.md#notes-about-messages),
  shaped like a catalog, relative to the config and outside the catalog
  directory.
- `scopes` — loaders for parts of the catalog, by name. A scope is a nonempty
  array of IDs and dotted `prefix.*` patterns, or `{ modules, exclude?, dynamicImports?, messages? }`
  to take the messages that the files `modules` matches, and their imports, name.
  `dynamicImports: false` stops the crawl at dynamic `import()` calls.
  See [scopes computed from code](../GUIDE.md#scopes-computed-from-code);
  `nordbeam-locale inspect --scope <name>` shows what a scope's crawl reached.
- `arguments` — arguments a message takes beyond those its base text uses, by
  message ID, so translations may use them: `{ "pricing.subtitle": { "price":
  "value" } }`. Each argument is `"value"`, `"number"` or `"date"`. See
  [arguments only a translation uses](../GUIDE.md#arguments-only-a-translation-uses).
- `text` — how `hardcoded` and `doctor` find UI text outside the catalog:
  `exclude` (globs of source files to skip), `ignore` (exact text or
  `/regular expressions/` to accept as is), and `attributes` and `calls` (more
  attributes and functions whose value is UI text). See
  [hardcoded text](../GUIDE.md#hardcoded-text).
- `lockedKeys` and `ignoredKeys` — exact IDs or dotted `prefix.*` patterns for
  source-verbatim and excluded messages; overlap is rejected during validation.
- `resolveKeyPolicy(id, options)` — return the validated lock/ignore decision
  for a message ID.
