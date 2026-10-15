# Plain TypeScript or Node

No framework adapter is involved: generated modules are ordinary ESM that work in Node, workers, scripts and tests.

## Setup

```sh
npx nordbeam-locale init            # no --framework
```

Creates `nordbeam-locale.config.json`, `messages/en.json`, the generated modules in `src/i18n/` and the `i18n`, `i18n:watch`, `prebuild` package scripts. Run `npx nordbeam-locale --watch` (or `npm run i18n:watch`) during development when no bundler plugin regenerates for you.

## Load a locale and call messages

```ts
// app.mjs
import { loadLocale, locales, baseLocale } from './src/i18n/index.js';

const { messages: m } = await loadLocale('en');
console.log(m.greeting({ name: 'Ada' })); // Hello Ada!
console.log(m.items({ count: 1234 }));    // 1,234 items
```

- `loadLocale(locale)` is lazy: each locale is its own chunk and is loaded on demand. It resolves `{ locale, messages }`.
- Exports: `locales`, `baseLocale`, `loadLocale`, `selectMessages`, and the types `Locale`, `Messages`, `LoadedLocale`. `loadLocale` takes the `Locale` union, so validate untrusted input first: `locales.includes(value as Locale)`.
- With `NODE_ENV` unset the generated functions throw a `TypeError` naming the message when an argument is missing or of the wrong type (`en:greeting: argument "name" must be string or number`); production output omits those guards and relies on the types.
- Rich messages return an array of strings and whatever your callbacks return: `m.terms({ link: children => ({ tag: 'a', children }) })`.

## Per-request locale and a reusable store

There is no global current locale. For a server, call `loadLocale(requestLocale)` per request, or load once per locale and cache. For a client-style store with synchronous reads and async switches:

```ts
import { createLocaleStore } from '@nordbeam/locale';
import { loadLocale } from './i18n/index.js';

const i18n = createLocaleStore({ initial: await loadLocale('en'), loadLocale });
i18n.getMessages().greeting({ name: 'Ada' });
await i18n.setLocale('fr');   // false if a newer call superseded this one
```

Create one store per browser app or server request. `preload(locale)` fills the cache and `invalidate(locale?)` drops cached locales.

## Named imports and scopes

For a fixed language, import messages directly (tree-shakeable):

```ts
import { greeting } from './src/i18n/locales/en.js';
greeting({ name: 'Ada' });
```

For a feature or route bundle, declare scopes in `nordbeam-locale.config.json`:

```json
{ "scopes": { "site": ["greeting", "checkout.*"] } }
```

This generates `src/i18n/scopes/site/index.js` exporting `locales` and `loadLocale` for just those messages. Pattern rules are validated when the config is read.

## Config worth knowing

The accepted keys are `baseLocale`, `catalogs`, `outDir`, `missing` (`"fallback"` or `"error"`; `"error"` fails on untranslated keys without `--strict`), `formats` (named `number`, `date` and `time` styles from `Intl` options), `timeZone` (pin it for deterministic date/time output), `scopes`, `artifacts` (`typed` default, `runtime`, `loader`, `loader-typed`), `includeSources`, `shareLiterals`, `cache`, `persistentCache`, `selectionFallback`, `shareMessages`, `preloadManifest`, `staticLocale`, `lockedKeys` and `ignoredKeys`. An unknown key is `INVALID_CONFIG`. Full list: https://github.com/nordbeam/locale/blob/main/docs/reference/config.md The `schema` command writes JSON schemas so editors validate catalogs and the config.

## Tests

```ts
import { createMessageTestHelpers } from '@nordbeam/locale/testing';
import type { Messages } from './src/i18n/index.js';
import { locales, loadLocale } from './src/i18n/index.js';

const testI18n = createMessageTestHelpers<Messages>();
testI18n.keyFromSelector(m => m.product.price);   // "product.price"
const rendered = await testI18n.localeMatrix(locales, loadLocale, messages => messages.product.price({ amount: 12 }));
```

`keyFromSelector` keeps tests refactor-safe; `localeMatrix` exercises every locale. Use a fixed `timeZone` and stable dates for snapshots, and assert through message functions rather than snapshotting generated files.

## CI

```json
{
  "scripts": {
    "prebuild": "nordbeam-locale",
    "i18n:check": "nordbeam-locale check --strict",
    "build": "npm run i18n:check && tsc -b"
  }
}
```

Run `nordbeam-locale verify --json` in the verification job so stale or hand-edited generated output fails the build. Do not use `prepare` for generation: it runs on every install, including production installs without the CLI.
