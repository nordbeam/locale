# Nordbeam Locale guide

This guide covers the features the [README](../README.md) leaves out: selection
and bundle boundaries, artifacts, the client and React adapters, translation
workflows, migrations, and tooling. Start with the README for install and
the framework path you need.

## Contents

- [Requirements and names](#requirements-and-names)
- [Configuration files](#configuration-files)
- [Vite selection](#vite-selection)
- [Scopes and named imports](#scopes-and-named-imports)
- [Generated artifacts](#generated-artifacts)
- [Shared literals](#shared-literals)
- [Source messages for rich text](#source-messages-for-rich-text)
- [Client and React](#client-and-react)
- [React Server Components](#react-server-components)
- [Next.js](#nextjs)
- [TanStack Start](#tanstack-start)
- [Translation workflow](#translation-workflow)
- [Notes about messages](#notes-about-messages)
- [Refactoring and project diagnostics](#refactoring-and-project-diagnostics)
- [Migration and codemods](#migration-and-codemods)
- [Persistent cache](#persistent-cache)
- [Pseudo-localization](#pseudo-localization)
- [Testing](#testing)
- [Development inspector and editor tooling](#development-inspector-and-editor-tooling)
- [Limits](#limits)
- [Verify this repository](#verify-this-repository)

## Requirements and names

Requirements: Node **22.12 or newer**, TypeScript **5.6 or newer**, and Vite
**6, 7, or 8** for the plugin. Generated modules target modern ESM environments
with native `Intl`.

The canonical names are `@nordbeam/locale`, the `nordbeam-locale` command,
`nordbeam-locale.config.json`, `nordbeamLocale()`, `withNordbeamLocale()`, and
the `.nordbeam-locale-manifest.json` output marker.

`init` creates `nordbeam-locale.config.json`, an English starter catalog, and
generated modules under `src/i18n`. Existing catalogs, configuration, application
files, scripts, and ignore rules are preserved. Edit the source catalogs, not
generated files, or configure different `catalogs` and `outDir` paths. Rerunning
`init` is safe for an existing project.

The package also exposes dependency-free schema builders for editor key
completion, config validation, and source-message hover metadata; see the
[editor guide](EDITOR.md). They are available from `@nordbeam/locale/schema` and
the main package for custom tooling, without adding anything to the runtime
bundle.

The same guide documents the opt-in development inspector, which can show
in-context key, locale, arguments, result, and timing data in a browser overlay.
It lives in a separate `@nordbeam/locale/inspector` entry and is never imported by
generated locale modules.

Add a message to `messages/en.json`:

```json
{
  "greeting": "Hello {name}!",
  "items": "{count, plural, =0 {Your basket is empty} one {# item} other {# items}}"
}
```

Generate and use the typed loader:

```sh
npx nordbeam-locale
```

```ts
import { loadLocale } from './i18n/index.js';

const { messages: m } = await loadLocale('en');
m.greeting({ name: 'Ada' }); // Hello Ada!
m.items({ count: 3 });       // 3 items
```

The locale, message IDs, and argument shapes come from your catalogs. Invalid
ICU, duplicate IDs, missing translations, and incompatible arguments fail with
the source JSON path, line, and a code frame. Run the strict check locally and
before a release:

```sh
npx nordbeam-locale check --strict
```

Add `messages/fr.json`, regenerate, and request French:

```json
{
  "greeting": "Bonjour {name} !",
  "items": "{count, plural, =0 {Votre panier est vide} one {# article} other {# articles}}"
}
```

```ts
const { messages } = await loadLocale('fr');
messages.greeting({ name: 'Ada' });
```

Nested JSON objects keep stable dotted IDs and also expose a typed property
view, so `messages.checkout.items()` and `messages['checkout.items']()` call the
same generated function. The namespace view is static generated code, not a
Proxy, and does not appear in `Object.keys(messages)`. Bracket access remains
available for IDs whose segments are not JavaScript identifiers. Locale files
are strict JSON and use canonical BCP 47 locale names.

Continue with the [cookbook](COOKBOOK.md) for common React recipes, the
[Next.js guide](NEXTJS.md) for App Router integration, or the
[package reference](reference/README.md) for every public entry point.

## Configuration files

The discovered configuration is ordinary JSON and can be checked into the
application:

```json
{
  "baseLocale": "en",
  "catalogs": "messages",
  "outDir": "src/i18n",
  "timeZone": "UTC"
}
```

Options passed directly to `nordbeamLocale({...})` take precedence over
discovery. The full option list is in [config](reference/config.md).

### Development and production output

Generated modules come in two modes. Development output checks arguments at
runtime: a missing or wrongly typed argument throws a `TypeError` that names the
message, such as `en:greeting: argument "name" must be string or number`.
Production output omits those guards and trusts the generated types. For one
`Hello {name}!` message the generated module is 457 bytes in development and 190
bytes in production.

The mode is chosen in this order:

1. `--development` or `--production` on the command line, or the matching
   `development` option in code.
2. `NODE_ENV=production` selects production output. Any other value, or an unset
   `NODE_ENV`, selects development output.

When `NODE_ENV` is unset and no flag is given, the CLI prints a notice that it
generated development output. Passing both flags is a usage error. Set
`NODE_ENV=production` or `--production` in production build scripts.

## Vite selection

Add the plugin to `vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import { nordbeamLocale } from '@nordbeam/locale/vite';

export default defineConfig({ plugins: [nordbeamLocale()] });
```

The plugin discovers `nordbeam-locale.config.json` at the Vite root. It generates
real modules and declarations before imports resolve and updates them during
catalog edits. In production, a local literal call such as this one is narrowed
to the messages it uses:

```ts
const { messages: m } = await loadLocale('fr');
m.greeting({ name: 'Ada' });
```

Keep using the generated `loadLocale` API while you are getting started. If the
Vite plugin cannot prove which messages a loader uses, it prints a warning with
the source location and the smallest safe remedy. At that point, add an explicit
selection at the boundary:

```ts
import { selectMessages } from './i18n/index.js';

const loadCheckout = selectMessages('greeting', 'items');
const { messages } = await loadCheckout('fr');
messages.items({ count: 2 });
```

Dynamic keys, enumeration, escaping a loaded result, and unsupported syntax
retain the safe full catalog. In Vite, recognized but unproven loader calls
produce a warning describing the fallback and remedy; a deliberate full-catalog
escape hatch remains available through the plugin options:

```ts
nordbeamLocale({ selectionFallback: 'off' }); // or 'error' in CI
```

Selection is optional for correctness. Outside Vite, use generated scopes or
named locale imports when you have a deliberate bundle boundary; a full
`loadLocale` catalog remains the simplest and safest default.

To let a router preload locale chunks, enable `preloadManifest: true`; the
plugin emits the `nordbeam-locale-preload.json` asset for client application
entries.

Options are described in [vite](reference/vite.md). Use `--watch` when Vite is not
part of the application; the Next wrapper starts its watcher during `next dev`.
Otherwise, run the generator once before type-checking. Generated files belong to
the configured output directory; do not hand-edit them. The writer repairs missing
owned files while preserving unrelated files, and failed catalog edits keep the
last successful generated output available for development.

## Scopes and named imports

For a fixed locale, import named messages directly:

```ts
import { greeting } from './i18n/locales/en.js';
greeting({ name: 'Ada' });
```

Scopes give a route or feature its own loader, with only the listed message IDs
or dotted prefixes. Declare them in configuration:

```json
{
  "scopes": {
    "site": ["greeting", "checkout.*"]
  }
}
```

Each scope is generated under `src/i18n/scopes/<name>/`, with its own
`index.js` that exports `locales` and `loadLocale`. Pattern and ID rules are
validated when the configuration is read; see [config](reference/config.md).
Use a scope when a bundle boundary is deliberate, such as a route group that
should load only its own messages.

### Scopes computed from code

A list of IDs goes stale as pages change. A scope can instead name the files
that render a part of the app, and take the messages those files and their
imports name:

```json
{
  "scopes": {
    "site": {
      "modules": ["src/routes/__root.tsx", "src/routes/index.tsx", "src/routes/pricing.tsx", "src/routes/blog.*.tsx"],
      "exclude": ["src/routeTree.gen.ts"],
      "messages": ["legal.*"]
    }
  }
}
```

The generator starts at the files that `modules` matches and follows their
static and dynamic imports through the app's own source: relative paths,
`tsconfig.json` `paths`, and `/src/...` paths. It never enters `node_modules`,
the generated output, or a file that `exclude` matches. Exclude a file that
imports far more than the scope needs, such as a generated route tree that
imports every route. A file contributes each message ID it names:

- in a string literal: `'pricing.title'`;
- in a property chain: `m.pricing.title()`, and `pricing.title()` after
  `const { pricing } = m`;
- in a template literal, as a pattern: `` `pricing.plan.${id}` `` takes every ID
  of that shape. The literal start must contain a dot.

`messages` adds IDs and `prefix.*` patterns the code does not name, such as IDs
read through a deeper alias (`const plan = m.pricing.plan; plan.title()`). The
scope is recomputed on every generation, and in a watch session when a file it
was computed from changes, so it follows the code. A module pattern that
matches no file fails generation with
[`SCOPE_MODULE_NOT_FOUND`](reference/errors.md#scope_module_not_found); modules
that name no message fail with [`EMPTY_SCOPE`](reference/errors.md#empty_scope).

The crawl reads text; it does not run or type-check the code, so it can take a
message the page never shows, which costs only bytes. A message it misses is a
bug on the page, so in development the scope's `loadLocale` checks every read:
reading a message that the catalog has and the scope left out logs
`Nordbeam Locale: message "…" is not in the "site" scope` to the console.
Production output has no check.

The TanStack Start adapter can load a scope's catalog for the pages it covers
and the full catalog for the rest; see
[Scopes in TanStack Start](reference/tanstack-start.md#scopes).

## Generated artifacts

The `artifacts` option controls which files are emitted:

- `"typed"` (default): loaders, declarations, and public named-import modules.
- `"runtime"`: omits declarations.
- `"loader"`: omits declarations and public named-import modules. Use it for
  compatibility bridges that only call `loadLocale`.
- `"loader-typed"`: omits the public named-import modules and keeps the aggregate
  `messages.d.ts` and the typed loader API.

## Shared literals

For large loader catalogs, set `"shareLiterals": true` to emit one shared
`internal/shared.js` module for identical plain-literal messages. It is disabled
by default to minimize first-load dependency edges; ICU and rich messages remain
locale-owned.

## Source messages for rich text

If an existing rich-text component needs the original ICU source, `includeSources`
can be `"rich"`, `"all"`, or an exact array of message IDs. The loaded locale then
includes a typed `sources` map beside `messages`; exact IDs are validated at
compile time. Prefer an exact list for migrated applications so ordinary text is
not shipped twice.

## Client and React

Load one locale during bootstrap, then read messages synchronously from an
isolated store. Locale changes remain explicit and request-safe:

```ts
import { createLocaleStore } from '@nordbeam/locale';
import { loadLocale } from './i18n/index.js';

const initial = await loadLocale('en');
const i18n = createLocaleStore({ initial, loadLocale });
i18n.getMessages().greeting({ name: 'Ada' });
await i18n.setLocale('fr');
i18n.getMessages().greeting({ name: 'Ada' }); // now French
```

There is no global current locale; create a store per browser application or
server request. `getMessages()` is synchronous after bootstrap and always
reflects the latest applied locale. `setLocale` returns `false` when a newer
request superseded it.

The optional React adapter keeps the same store and SSR snapshot contract:

```tsx
import { createReactI18n } from '@nordbeam/locale/react';
import { loadLocale } from './i18n/index.js';

const i18n = createReactI18n(loadLocale);
const initial = await loadLocale('en');

function Greeting() {
  const messages = i18n.useMessages();
  return <p>{messages.greeting({ name: 'Ada' })}</p>;
}

// Render <i18n.Provider initial={initial}>...</i18n.Provider>.
```

For React and SSR, declare an explicit `selectMessages` loader beside the
application entry so the server and client share the same selected contract.
The adapter supports React 18 and 19, hydration-safe snapshots, locale races,
and rich message slots.

For a server request, call `loadLocale` directly and pass its result to your
render tree. Do not put the current locale in module-global mutable state: two
requests must be able to render different locales concurrently. On the client,
serialize the initial snapshot into the page and construct the store once during
bootstrap. Keep the loader and the selected message contract shared by the
server and client entry points so hydration does not introduce a locale
waterfall.

For a client app or island, use the state-owning adapter. It caches one stable
resource per locale, deduplicates Strict Mode retries, and automatically keeps
the current language visible while a cold locale loads:

```tsx
import { createClientI18n } from '@nordbeam/locale/react';
import { loadLocale } from './i18n/index.js';

const i18n = createClientI18n(loadLocale);
const likelyLocales = ['fr'] as const;

function Greeting() {
  const { locale, messages: m, setLocale, pending } = i18n.useI18n();
  return <>
    <p lang={locale}>{m.greeting({ name: 'Ada' })}</p>
    <button aria-busy={pending} onClick={() => setLocale('fr')}>Français</button>
  </>;
}

function App() {
  return <i18n.Provider
    initialLocale="en"
    preload={likelyLocales}
    fallback={<p>Loading translations…</p>}
  >
    <Greeting />
  </i18n.Provider>;
}
```

`setLocale` commits cached locales directly and automatically uses a React
transition for cold locales, so application code needs no `useState`,
`startTransition`, or cache check. `pending` is available for progress UI.
`fallback` is rendered for the initial cold catalog; the provider owns the
Suspense boundary. The optional `preload` list begins likely follow-up imports
after hydration, without loading them during SSR. `preload(locale)`,
`isLoaded(locale)`, and `invalidate(locale)` remain available for advanced
intent prefetching and recovery. Rejected loads reach the nearest error boundary.

Large Vite applications can colocate a selected loader with each component.
Passing it to `useMessages` or `useI18n` gives that component a narrowed type and
a separate locale resource; the Vite transform emits only those messages:

```tsx
import { selectMessages } from './i18n/index.js';

const loadPrice = selectMessages('product.price', 'product.discount');

function Price() {
  const m = i18n.useMessages(loadPrice);
  return <p>{m.product.price({ amount: 20 })}</p>;
}
```

Keep the selected loader stable at module scope. Locale transitions wait for
all mounted component loaders, and `preload` follows those active selections
instead of pulling the complete catalog. The imperative forms accept the same
loader as a second argument: `i18n.preload('fr', loadPrice)` and
`i18n.isLoaded('fr', loadPrice)`.

React 18 and 19 share the same stable-thenable Suspense path, including webpack
and Turbopack prerendering. Create a factory per request if its loader captures
request-specific data. The lower-level `createSuspenseI18n` controlled adapter
remains available for router-owned locale state. `createReactI18n` remains the
fit for a fully preloaded snapshot or synchronous `renderToString` without
Suspense.

## React Server Components

Server Components can await generated loaders and render messages without a
client runtime. Import `rich` from its server-safe entry; `@nordbeam/locale/react`
is a client module because it contains providers and hooks:

```tsx
import { rich } from '@nordbeam/locale/react/rich';
import { loadLocale, type Locale } from './i18n/index.js';

export async function Page({ locale }: { locale: Locale }) {
  const { messages: m } = await loadLocale(locale);
  return <main>
    <h1>{m.greeting({ name: 'Ada' })}</h1>
    <p>{rich(m.welcome, {
      name: 'Ada',
      strong: children => <strong>{children}</strong>,
    })}</p>
  </main>;
}
```

Do not pass `LoadedLocale` or message functions to a Client Component. React
Flight only accepts serializable props, and generated catalogs intentionally
contain functions. Put the Suspense factory in a client module and pass only the
locale string across the boundary:

```tsx
// locale-provider.tsx
'use client';
import { type ReactNode } from 'react';
import { createClientI18n } from '@nordbeam/locale/react';
import { loadLocale, type Locale } from './i18n/index.js';

export const i18n = createClientI18n(loadLocale);

export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <i18n.Provider initialLocale={locale} fallback={<p>Loading translations…</p>}>
    {children}
  </i18n.Provider>;
}
```

The server can render `<LocaleProvider locale={locale}>…</LocaleProvider>`:
only the serializable locale crosses Flight, and the client provider loads its
own catalog. Server-rendered text outside that client boundary still ships zero
client JavaScript.

## Next.js

Wrap the Next configuration so catalogs and declarations exist before
compilation:

```js
// next.config.mjs
import { withNordbeamLocale } from '@nordbeam/locale/next';

export default withNordbeamLocale({ reactStrictMode: true });
```

For locale-prefixed URLs, use the Edge-safe middleware entry instead of a
framework pass-through. It preserves `always`, `as-needed`, and `never`
prefixes, locale cookies, language detection, canonical redirects, and internal
`[locale]` rewrites. The scaffolded matcher and its security meaning are covered in
the [Next.js guide](NEXTJS.md#the-middleware-matcher).

For locale-aware App Router navigation, create `Link`, `useRouter`,
`usePathname`, and `redirect` from `@nordbeam/locale/next/navigation`. In a
Server Component or route handler, `await getLocale()` from
`@nordbeam/locale/next/server` reads the locale header set by this middleware.
See the [Next package references](reference/next-navigation.md) and
[server reference](reference/next-server.md).

For a `[locale]` route, validate the string parameter and generate static locale
paths with the runtime-only entry:

```tsx
import { notFound } from 'next/navigation';
import { createNextI18n } from '@nordbeam/locale/next/runtime';
import { locales, loadLocale } from '@/i18n/scopes/site/index.js';

const i18n = createNextI18n({ locales, loadLocale });

export const dynamicParams = false;
export function generateStaticParams() { return i18n.generateStaticParams(); }

export default async function Page({ params }: PageProps<'/[locale]'>) {
  const { locale } = await params;
  if (!i18n.hasLocale(locale)) notFound();
  const { messages: m } = await i18n.loadLocale(locale);
  return <h1>{m.greeting({ name: 'Ada' })}</h1>;
}
```

Next does not run the Vite selection transform. Use configured scopes for
route/client locale chunks, or a named locale import for fixed-language static
content; runtime `selectMessages(...)` alone does not shrink a Next bundle.
Server Components can render message functions directly. Pass only serializable
values such as the validated locale string into Client Components, never a
loaded messages object. Schedule Suspense-backed client locale changes with
`startTransition`. The complete [Next.js guide](NEXTJS.md) covers the integration
and its locale-routing choices.

## TanStack Start

TanStack Start uses the Vite plugin and a router `rewrite` instead of a `[locale]`
route directory. Your routes stay unprefixed; the URL carries the locale prefix
and localized pathnames, and `Link` and `navigate` build them for the page's
locale. `nordbeam-locale init --framework tanstack-start` scaffolds the routing
and i18n modules and prints what to add to `vite.config.ts`, `src/start.ts`,
`src/router.tsx` and the root route.

The request middleware from `@nordbeam/locale/tanstack-start` shares its
redirect, cookie and `hreflang` rules with the Next.js middleware, so one routing
object means the same URLs in both. Messages load in the root route's
`beforeLoad`: the server renders translated HTML with `<html lang dir>`, the
browser requests each catalog once, and a locale switch loads its catalog before
the URL changes. The full setup, server function locale, limits and types are in
the [TanStack Start reference](reference/tanstack-start.md).

## Translation workflow

PO export/import is available without another runtime dependency:

```sh
npx nordbeam-locale export --locale fr --out translations/fr.po
npx nordbeam-locale import --locale fr --from translations/fr.po --dry-run
npx nordbeam-locale import --locale fr --from translations/fr.po
npx nordbeam-locale check --strict
```

Dry runs write nothing. The import validates IDs, ICU, and argument contracts
before committing a catalog update. The command reference is in
[translations](reference/translations.md).

## Notes about messages

Catalogs hold message text only. Context for a message, such as where it appears,
what an argument holds, or that legal reviews every change, goes in a notes file
shaped like a catalog:

```json
{
  "checkout": {
    "pay": "Button under the order summary. {amount} is formatted by the caller."
  }
}
```

Name it in the config with `"notes": "messages.notes.json"`, outside the catalog
directory. A note shows beside its message in editor hovers (`@remarks`) and
becomes `#.` comments in PO exports. `rename` moves a message's note with it, and
`check` warns with `UNKNOWN_NOTE` when a note names a message that is gone.
`migrate --notes` writes one from source comments and FormatJS or ARB descriptions.

## Refactoring and project diagnostics

The local CLI includes safe, reviewable catalog refactors. Rename updates the
base and translated catalogs and recognizable direct, bracket, and selection
calls in application source:

```sh
npx nordbeam-locale rename --id checkout.pay --to checkout.submit --source-dir src
npx nordbeam-locale extract --id checkout.cancel --message "Cancel"
npx nordbeam-locale prune --dry-run --source-dir src
npx nordbeam-locale doctor --source-dir src
npx nordbeam-locale schema
npx nordbeam-locale pseudo --locale en-XA --from-locale en --dry-run
```

`extract` validates the complete project before changing the base catalog.
`prune` is intentionally report-only and always requires `--dry-run`; dynamic
keys cannot be proven by a static scan and are called out in the report. Use
`--json` with `rename`, `extract`, `prune`, or `doctor` for editor and local
automation integrations. These commands never touch generated output.
`pseudo` expands visible text while preserving ICU placeholders and branches;
it creates only the explicit target locale and requires `--update` before an
existing target can be replaced.

### Project report

`report` writes one HTML page about the project's translations. The data and
the code are inside the file, and it loads nothing from the network.

```sh
npx nordbeam-locale report --open
npx nordbeam-locale report --source-dir app --out reports/i18n.html
npx nordbeam-locale report --json
```

The page shows:

- Coverage per locale: translated, the same as the base text, blank, and
  missing, with keys that exist only in a translation.
- Namespaces as a treemap, sized by message count and colored by untranslated or
  unused messages. Click a namespace to see its children.
- What each locale downloads: the generated catalog module that `loadLocale`
  fetches, raw, gzip and brotli, and the same for each scope.
- Scopes: how many messages each one takes and its share of the catalog.
- ICU features: how many messages use plurals, ordinals, selects, numbers, dates
  and tags.
- Source usage: which files reference which messages, unused messages, and IDs
  the source names that the catalog lacks. It uses the scan behind `doctor`, so a
  key assembled at runtime in a way it cannot see counts as unused. A file that
  names most of the catalog, such as a copy of it, is listed but not counted.
- Every `check` diagnostic, and a searchable table of all messages, filtered by
  status, locale, feature, scope or namespace. Clicking a chart filters the table.

The page is written to `nordbeam-locale-report.html` in the project root unless
`--out` names another file; `--out -` prints it. `--json` returns the same data
without writing a page (add `--out` to do both); its message and unused lists are
capped like other reports, with `--limit`. When the catalogs do not compile, the
report still covers them, without the sizes. Add the file to `.gitignore` if you
generate it in the project.

## Migration and codemods

`migrate` converts i18next, vue-i18n, next-intl, FormatJS, Lingui, Tolgee, ARB, YAML,
Android XML, Apple `.strings`/`.xcstrings`, PO/POT/MO, and Jed/json-gettext
catalogs. Multi-locale Tolgee and Apple string-catalog exports accept
`--locale`. Positional printf placeholders are converted to named ICU arguments
with review warnings. It reports interpolation, metadata, and ID/layout
limitations. It never rewrites source calls. Use `--dry-run --json` to inspect the
complete proposed catalog; output files are created exclusively and are never
overwritten.

```sh
npx nordbeam-locale migrate --from legacy/en.json --format i18next --out messages/en.json --dry-run
```

`migrate-project` orchestrates that work for a full application. It accepts one
catalog file (use `--locale`) or a directory whose files are named by locale,
validates every converted catalog and cross-locale argument contract, previews
source rewrites, and can scaffold `next` or `vite-react`. Preview is the default;
`--write` is required to create `messages-nordbeam`, generated modules,
config/framework files, and proven source-call rewrites. The report always lists
the remaining provider/import bindings for manual review. For source and catalog
formats that differ, pass `--catalog-format` with any format accepted by `migrate`.

```sh
npx nordbeam-locale migrate-project --from legacy/messages --format next-intl --framework next --source-dir src
npx nordbeam-locale migrate-project --from legacy/messages --format next-intl --framework next --source-dir src --write
npx nordbeam-locale migrate-project --from legacy/messages --format react-i18next --catalog-format next-intl --framework vite-react --initial-locale-expression locale --write
```

`codemod` rewrites recognized source calls:

```sh
npx nordbeam-locale codemod --format next-intl --source-dir src
npx nordbeam-locale codemod --format next-intl --source-dir src --write
npx nordbeam-locale codemod --format lingui --source-dir src --message-id-map source-to-id.json --json
```

Source migration parses JavaScript and TypeScript call spans before changing
them, accepts static quoted or template-literal keys, and reports dynamic keys
without guessing. Repeat `--custom-call translator` or
`--custom-call translator:namespace` for application-owned wrappers. When the
wrapper comes from a hook (`const t = useT()`), add `--messages-import <module>
--messages-hook useMessages`: each hook becomes `const m = useMessages()`. Complete
project runs also lower finite conditional keys and converge nested calls in one
reviewed operation. Every unresolved construct carries a stable diagnostic code
and a suggested action. When an application adapter deliberately exports an
incumbent formatter type, combine `--messages-import <specifier>` with the
repeatable `--move-type-import <ExportedType>` option; aliases and mixed imports
are preserved, and no type compatibility is guessed.

Complete project migration gates rewrites against the generated base-catalog
message IDs. Lingui source macros use an unambiguous source-text-to-ID map when
the catalog provides one or when `--message-id-map` supplies one. The JSON report
separates direct-only files from files that still require a legacy fallback; only
the latter should import a lazy compatibility boundary. Ambiguous source maps fail
before any write instead of selecting a fuzzy match. Framework planners remove
dead imports and report every provider, bootstrap, and server/client boundary
that still needs an owner.

Framework-aware migration handles the ordinary boundaries too. Next App Router
server routes receive validated locale loading and static params; existing Client
Components receive one Nordbeam hook, while their nearest conventional
`[locale]/layout` is wrapped with the generated client provider. Vite React roots
are wrapped when `--initial-locale-expression` identifies the existing locale
expression. The tool never guesses a locale or turns a Server Component into a
Client Component. Ambiguous providers, conditional hooks, dynamic IDs, and custom
roots stay unchanged with a precise skip reason.

The step-by-step process is in [MIGRATION](MIGRATION.md). The command references
are [migrate](reference/migrate-project.md), [migrate-react](reference/migrate-react.md),
[migrate-next](reference/migrate-next.md), [migrate-frameworks](reference/migrate-frameworks.md),
and [codemods](reference/codemods.md). Migration commands need
`@nordbeam/locale-migrate`.

## Persistent cache

Generation keeps an in-memory message cache for each process, sized by
`cache.maxMessageCacheBytes` (default 64 MiB). Watch mode and repeated builds reuse it.

```json
{
  "cache": { "maxMessageCacheBytes": 67108864 }
}
```

The opt-in on-disk cache is set with `persistentCache`. `true` stores the compiled
project under `node_modules/.cache/nordbeam-locale`; a string names another
directory. It is disabled by default. A cache hit restores the outputs without
compiling, and missing or modified generated files are rewritten from the cache.
Delete the cache directory to clear it. See [project](reference/project.md) and
[compiler](reference/compiler.md) for `createCompiler` and `createGenerator`.

## Pseudo-localization

Pseudo-locales expand visible text and mark it, so layout and truncation problems
show before translation. Generate one with the `pseudo` command shown in
[Refactoring and project diagnostics](#refactoring-and-project-diagnostics). For a
custom visual-test pipeline, the programmatic `pseudoLocalizeMessage` and
`pseudoLocalizeCatalog` helpers are exported from `@nordbeam/locale/pseudo`. See
[pseudo](reference/pseudo.md).

## Testing

For typed tests, bind the helper once to the generated message contract. This
keeps selectors refactorable and makes multi-locale snapshots concise without
adding anything to application bundles:

```ts
import { createMessageTestHelpers } from '@nordbeam/locale/testing';
import type { Messages, Locale } from './src/i18n/index.js';
import { locales, loadLocale } from './src/i18n/index.js';

const testI18n = createMessageTestHelpers<Messages>();
testI18n.keyFromSelector(m => m.product.price); // "product.price"
const rendered = await testI18n.localeMatrix(locales, loadLocale,
  messages => messages.product.price({ amount: 12 }));
```

## Development inspector and editor tooling

The development inspector and browser overlay are documented in the
[editor and in-context tooling guide](EDITOR.md). The programmatic API is in
[inspector](reference/inspector.md). The VS Code extension lives in
`editors/vscode`; run `npm run vscode:check` locally. It provides inline
base-locale translations, all-locale hover, extract and missing-key repair
actions, source-safe rename assistance, and local generated-type verification.

## Limits

- [Compiler and project generation](reference/compiler.md)
- [React and rich messages](reference/react.md)
- [Error codes and their fixes](reference/errors.md)
- [Package reference](reference/README.md)

The default object intentionally contains every message in a locale. Its loader
uses a private generated module, while selected Vite chunks or named imports can
avoid shipping unused messages. Dynamic usage and framework boundaries can
require explicit selections.

The compiler supports these ICU forms: plain text, interpolation, `select`,
plural and ordinal branches, number/date/time formatting, nested messages, and
typed rich slots. Unsupported ICU syntax is reported during generation rather
than interpreted at runtime, with a code from the
[error reference](reference/errors.md). Native `Intl` data,
time zones, and browser/server runtime versions still affect formatted output;
pin a time zone when deterministic output is required.

Inside a plural branch, `#` formats the count with the locale's number
formatting: `{n, plural, one {# item} other {# items}}` prints `1,000 items` in
English and `1.000 Artikel` in German. `{n}` inside the same branch interpolates
the raw value and prints `1000` in both. Use `#` for counts, and `{n}` only when
you want the unformatted number.

Selection is a performance tool, not a semantic requirement. A full catalog is
correct and useful for exploratory code, tests, and server boundaries, but it
loads every message in that locale. Inference only proves local literal usage;
passing a loader result to another function, retaining it, exporting it, or using
a dynamic key can make the safe result larger. Treat Vite warnings as a prompt to
add `selectMessages` at the boundary. This keeps the optimization explicit and
makes the generated TypeScript contract match the code that owns the loader.

## Verify this repository

```sh
npm ci
npm run check
npm run next:check:webpack
```

The repository checks cover the supported React, Next.js, TanStack Start, and
Vite integration paths. Neither command requires CI or a hosted deployment.
