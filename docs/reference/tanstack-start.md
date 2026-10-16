# TanStack Start — `@nordbeam/locale/tanstack-start`

Locale routing, detection and messages for TanStack Start (React). Your routes
stay one unprefixed tree: `/about` is the only route file. The URL carries the
locale (`/fr/a-propos`), and TanStack Router's `rewrite` maps it in both
directions, so every `<Link to="/about">` and `navigate()` call builds the
public URL for the page's locale on its own.

```bash
npm install @nordbeam/locale @tanstack/react-start @tanstack/react-router
npm install --save-dev nordbeam-locale
```

Tested with `@tanstack/react-start` 1.169 and `@tanstack/react-router` 1.170 on
Vite 8. The entry has no Node imports and no server-only imports, so it is safe
in the client bundle.

```ts
// src/i18n/routing.ts
import { defineRouting } from '@nordbeam/locale/tanstack-start';
import { baseLocale, locales } from './index';

export const routing = defineRouting({
  locales,
  defaultLocale: baseLocale,
  localePrefix: 'as-needed',
  pathnames: {
    '/about': { fr: '/a-propos' },
    '/blog/$slug': { fr: '/blogue/$slug' },
  },
});
```

```ts
// src/i18n/tanstack.ts
import { createTanStackStartI18n } from '@nordbeam/locale/tanstack-start';
import { loadLocale } from './index';
import { routing } from './routing';

export const i18n = createTanStackStartI18n({ routing, loadLocale });
```

```ts
// src/start.ts
import { createStart } from '@tanstack/react-start';
import { createLocaleFunctionMiddleware, createLocaleMiddleware } from '@nordbeam/locale/tanstack-start';
import { routing } from './i18n/routing';

export const startInstance = createStart(() => ({
  requestMiddleware: [createLocaleMiddleware(routing)],
  functionMiddleware: [createLocaleFunctionMiddleware()],
}));
```

```tsx
// src/router.tsx
import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import { i18n } from './i18n/tanstack';

export function getRouter() {
  return createRouter({ routeTree, scrollRestoration: true, ...i18n.routerOptions() });
}
```

```tsx
// src/routes/__root.tsx
import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import type { TanStackStartRouterContext } from '@nordbeam/locale/tanstack-start';
import { i18n } from '../i18n/tanstack';

export const Route = createRootRouteWithContext<TanStackStartRouterContext<(typeof i18n.locales)[number]>>()({
  beforeLoad: i18n.beforeLoad,
  shellComponent: ({ children }) => (
    <html {...i18n.useHtmlAttributes()}>
      <head><HeadContent /></head>
      <body>{children}<Scripts /></body>
    </html>
  ),
  component: () => <i18n.Provider><Outlet /></i18n.Provider>,
});
```

```tsx
// any route component
import { Link } from '@tanstack/react-router';
import { i18n } from '../i18n/tanstack';

function Page() {
  const { messages: m } = i18n.useI18n();
  return <>
    <h1>{m.title()}</h1>
    <Link to="/about">{m.about()}</Link>
    <i18n.LocaleLink locale="fr">Français</i18n.LocaleLink>
  </>;
}
```

`nordbeam-locale init --framework tanstack-start` writes `src/i18n/routing.ts`,
`src/i18n/tanstack.ts`, and the four files above when they do not exist. It
never edits an existing file; it prints a note for each one that still needs
wiring.

## How the pieces fit

| Piece | Runs | Job |
| --- | --- | --- |
| `createLocaleMiddleware(routing)` | server, every document request | Detects the locale, redirects to the canonical URL, writes the locale cookie and the `hreflang` `Link` header, and puts `locale` in the request context. |
| `routerOptions()` | server and browser | The router `rewrite` (public URL to route tree and back), the router context that holds its state, and the `hydrate` hook that loads the page's catalog before React hydrates. |
| `beforeLoad` on the root route | server and browser | Resolves the locale of the URL, loads its messages, and returns `{ locale }` as route context. |
| `Provider`, `useMessages`, `useI18n`, `useLocale` | render | Messages for the page's locale, from the existing React adapter. |
| `createLocaleFunctionMiddleware()` | browser | Sends the page locale with every server function call. |

The URL is the source of truth for the locale. The middleware and the rewrite
read it with the same rules, so they cannot disagree.

## Routing

`defineRouting(routing)` validates a routing object once and keeps its literal
locale types. It takes the same options as
[`@nordbeam/locale/next/routing`](next-routing.md): `locales`, `defaultLocale`,
`localePrefix` (`'always'`, `'as-needed'` or `'never'`, or `{ mode, prefixes }`),
`localeDetection`, `localeCookie`, `alternateLinks`, `pathnames`, `domains` and
`intlLocales`. `localePrefix` defaults to `'always'`, like the Next.js routing.
Pass the generated `intlLocales` when the config
[maps a locale code](next-routing.md#locale-codes-that-mean-another-language):
`Accept-Language`, `hreflang` and `<html lang>` then use the tag.

`pathnames` keys are TanStack Router route paths, not Next.js patterns:

| Segment | Matches | Param |
| --- | --- | --- |
| `about` | that text | none |
| `$slug` | one segment | `slug` |
| `$` | one or more segments | `_splat` |

Every localized variant must declare the same params as its route path. Optional
params (`{-$slug}`), and params with a prefix or suffix (`file{$name}.txt`), are
rejected with a `TypeError`, because they have no single localized form. Layout
and pathless route segments never appear in a URL, so they are not listed.

```ts
const routing = defineRouting({
  locales: ['en', 'de'],
  defaultLocale: 'en',
  pathnames: {
    '/blog/$slug': { de: '/artikel/$slug' },
    '/docs/$': { de: '/dokumente/$' },
    '/pricing': '/preise', // a string applies to every locale
  },
});
```

A locale without an entry keeps the route path. Params pass through
unchanged and are encoded once per segment; see the table in
[next-routing](next-routing.md#param-encoding). `domains` work as described in
[next-routing](next-routing.md#domains).

## Request middleware

`createLocaleMiddleware(routing, options?)` returns a global request middleware
for `createStart`. For a page request it:

1. Resolves the locale: URL prefix, then the locale cookie, then
   `Accept-Language`, then `defaultLocale`. With `localeDetection: false`, only
   the prefix counts.
2. Redirects (307) when the URL is not the canonical one for the `localePrefix`
   mode: `/en` to `/` under `as-needed`, `/` to `/en` under `always`, `/fr/about`
   to `/fr/a-propos` when `pathnames` localizes it, and so on. The query string
   is kept.
3. Writes the locale cookie (`NEXT_LOCALE` by default) on document requests when
   it disagrees with the locale.
4. Adds the `Link` response header with `rel="alternate"` for every locale and
   `x-default`, unless `alternateLinks` is `false` or the prefix mode is `never`.
5. Passes `{ locale, domain }` to the rest of the request as context.

These rules are the same code that the [Next.js middleware](next-middleware.md)
runs, so one routing object gives the same redirects, cookie and alternates in
both frameworks. See that page for the exact redirect table.

Options:

- `ignore(pathname)` returns `true` for requests the middleware leaves alone.
  The default skips `/api` and any path whose last segment has a file extension,
  such as `/favicon.ico`.
- `trustForwardedHost` reads the host from `x-forwarded-host` before `host`, for
  `domains` behind a proxy that sets it. Enable it only when the proxy overwrites
  the header.

Server function calls (`handlerType: 'serverFn'`) are never redirected. They get
`{ locale, domain }` from the `x-nordbeam-locale` header that
`createLocaleFunctionMiddleware()` sends, then from the `Referer` page, the
cookie and `Accept-Language`. An unknown header value is ignored.

## Server functions and loaders

Loaders and `beforeLoad` receive the locale as `context.locale`. Load messages
with `i18n.load`, which caches per locale:

```tsx
export const Route = createFileRoute('/blog/$slug')({
  loader: async ({ params, context }) => {
    const { messages } = await i18n.load(context.locale);
    return { title: messages.post({ slug: params.slug }) };
  },
});
```

Inside a server function, `getLocale()` returns the locale of the page that
called it:

```ts
import { createServerFn } from '@tanstack/react-start';
import { getLocale } from '@nordbeam/locale/tanstack-start';

const greet = createServerFn().handler(async () => {
  const { messages } = await i18n.load(getLocale() as 'en' | 'fr');
  return messages.greeting({ name: 'Server' });
});
```

`getLocale()` reads the request context on the server and returns `undefined`
when the request middleware did not run for that request, and outside a request,
such as in a queue consumer or at module scope. In the browser it
returns the locale of the current page. Narrow it to your locale type before
calling `i18n.load`, or validate it with `i18n.locales.includes`.

A loader that formats messages keeps its data when only the locale changes,
because the route path does not. The root `beforeLoad` therefore marks the
page's loaders invalid on a locale change, and the router runs them again. For a
moment the previous locale's strings stay on screen while the loaders run. Format
messages in components with `useMessages()` where you can; they update in the
same commit as the URL.

## Router

### `routerOptions()`

Spread it into `createRouter`. It returns `{ rewrite, context, hydrate }`: a
rewrite with its own state, the router context entry (`context.i18n`) that holds
that state, and the router's `hydrate` hook. Call it once per router, which
`getRouter()` already does for every request on the server. To add your own
context, merge it:

```ts
const options = i18n.routerOptions();
createRouter({ routeTree, ...options, context: { ...options.context, queryClient } });
```

TanStack awaits `hydrate` before React hydrates. It waits for the catalog named
by the `lang` of the server-rendered `<html>`; see
[Loading and hydration](#loading-and-hydration). If you pass your own `hydrate`,
call this one from it. Do the same for any subtree that you render in another
locale than the page:

```ts
const options = i18n.routerOptions();
createRouter({
  routeTree,
  ...options,
  hydrate: async () => {
    await Promise.all([options.hydrate(), i18n.load('en')]);
  },
});
```

The rewrite maps `/fr/a-propos` to the route `/about` and records the locale of
each URL it parses. The output direction builds `/about` as `/fr/a-propos`
for that locale. Under `domains`, a link to a locale that another domain serves
becomes an absolute URL, so TanStack renders a plain anchor and the click
leaves the application.

### `beforeLoad`

The root route's `beforeLoad`. It resolves the locale and loads its messages
before anything renders:

- With a prefix in the URL, the prefix names the locale.
- Without one, `as-needed` means the default locale. `always` and `never` use the
  locale the middleware detected on the server, and the router's current locale
  in the browser.

It returns `{ locale }`. The value is serialized in the dehydrated route state, so the
browser does not recompute it.

Pass it as it is: `beforeLoad: i18n.beforeLoad`. Its parameter type declares only
the options it needs, and leaves out `matches`, which TanStack types from the
registered router. Declaring `matches` made the root route's type depend on the
router, and TypeScript then reported `Route` and `getRouter` as circular
(TS7022, TS7023) when a file with a typed `Link` was checked first.

### `Provider`, `useHtmlAttributes`

`Provider` provides the page's messages to the tree and belongs in the root
route's `component`. It has its own `Suspense` boundary with an empty fallback.
The `hydrate` hook and the root `beforeLoad` load each catalog before it renders,
so the boundary does not suspend on the page's own locale.
`useHtmlAttributes()` returns `{ lang, dir }` for `<html>`: `lang` is the
locale's `intlLocales` tag (the locale itself when it has none), and `dir` is
`rtl` for right-to-left scripts. On a page of a [scope](#scopes) it adds
`data-nordbeam-locale-scope`, which tells the browser which catalog the page
needs. Use it in the `shellComponent`. It falls back to the
default locale when the root route failed before it resolved a locale.

### Hooks

`useMessages()`, `useLocale()` and `useI18n()` are the hooks of
[`createSuspenseI18n`](react.md), bound to your `loadLocale`. `useSetLocale()`
returns `setLocale(locale)`, described below.

## Links and switching

Use TanStack's own `Link`, `navigate` and `redirect` with route paths:

```tsx
<Link to="/blog/$slug" params={{ slug: 'hello' }}>Post</Link>
// /fr/blogue/hello on a French page
```

They are typed by your route tree and follow the page's locale. To link to a page
in another locale, use `LocaleLink` or `getPathname`.

`LocaleLink` renders a real `<a href>` to the current page in `locale`, with the
localized pathname, query and hash. Crawlers and middle clicks see a normal link.
A plain click switches without a document load. Use it for language switchers.

`useSetLocale()` returns `setLocale(locale)` for custom controls. It loads the
catalog first, writes the locale cookie, then pushes the new URL, so the page
changes language in one commit. Under `localePrefix: 'never'` the URL does not
change; `setLocale` writes the cookie and reloads the route data. A locale that
another domain serves is a full navigation to that domain.

`getPathname({ to, params?, search?, hash?, locale, domain? })` returns the full
external href for a route in a locale. Use it for sitemaps and `hreflang` values:

```ts
i18n.getPathname({ to: '/blog/$slug', params: { slug: 'hello' }, locale: 'fr' }); // '/fr/blogue/hello'
i18n.getPathname({ to: '/docs/$', params: { _splat: 'a/b' }, locale: 'de' });     // '/de/dokumente/a/b'
```

## Loading and hydration

On the server, the root `beforeLoad` awaits the catalog, so the first render has
its messages and the HTML is translated. The server never sends the messages to
the browser, because they are functions; the browser loads the chunk itself.
`routerOptions()` starts that request while the router is created, from the
`lang` of the server-rendered `<html>`, and its `hydrate` hook holds hydration
until the request completes. Each catalog is requested once per page load.

The browser can fetch that chunk before the entry runs. In a production build,
the Vite plugin gives the server build the client chunks of each locale's
catalog, and the `Provider` hints the page's chunks while rendering
(`ReactDOM.preload`), which React 19 writes into `<head>` as
`<link rel="preload" as="script" crossorigin fetchpriority="low">`. The hint is
low priority because a high one competes with the render-blocking CSS: measured
on a production site, a `modulepreload` hint made hydration 1.2 s earlier on a
slow 4G profile but delayed first paint by 1.1 s, while the low-priority hint
kept first paint unchanged and made hydration 0.1 to 0.3 s earlier. This needs
a client build and a server build in one `vite build` (Start builds the client
first), an absolute `base`, and React 19.
Development servers and `selectMessages(...)` loaders get no hint. The hint
travels on the generated `loadLocale`; a wrapper passes it on with
`Object.assign`:

```ts
import { loadLocale } from './index';

// A wrapper that also keeps each catalog for code outside React.
export const loaded = new Map();
const keepLoaded = Object.assign(
  (locale: Parameters<typeof loadLocale>[0]) => loadLocale(locale).then(result => { loaded.set(locale, result.messages); return result; }),
  loadLocale,
);
export const i18n = createTanStackStartI18n({ routing, loadLocale: keepLoaded });
```

Hydration must not reach the `Provider` before the catalog. The `Provider` would
suspend, React would keep the server HTML for the moment, and the first update
that reaches the boundary would make React replace that HTML with the empty
fallback until the catalog arrived. Any state set in an effect above the
`Provider` is such an update. The page goes blank between first paint and
hydration, and its largest paint moves to the moment the catalog arrives. Keep
`hydrate` in the router options, and render `<html {...i18n.useHtmlAttributes()}>`
so the browser knows which catalog the page needs.

The check at `test/integration/tanstack-start.mjs` asserts in Chrome that each
catalog is requested once, and that the server-rendered heading is still the
same element after hydration when its catalog arrives a second late.

A locale switch loads its catalog before the URL changes. Other locales are
fetched only when the user switches to them.

## Scopes

The catalog holds every message of the app, so a visitor who opens one public
page downloads the messages of the whole app before it hydrates. A
[scope](../GUIDE.md#scopes-computed-from-code) is a smaller catalog for part of
the app, and the adapter can load it for the pages it covers:

```json
{
  "scopes": {
    "site": {
      "modules": ["src/routes/__root.tsx", "src/routes/index.tsx", "src/routes/pricing.tsx"],
      "exclude": ["src/routeTree.gen.ts"]
    }
  }
}
```

```ts
// src/i18n/tanstack.ts
import { loadLocale } from './index';
import { loadLocale as loadSite } from './scopes/site/index';

export const i18n = createTanStackStartI18n({ routing, loadLocale, scopes: { site: loadSite } });
```

```tsx
// src/routes/pricing.tsx
export const Route = createFileRoute('/pricing')({
  staticData: { i18nScope: 'site' },
  component: Pricing,
});
```

A route takes a scope with `staticData: { i18nScope }`, and its child routes
take it too; the deepest route that names a scope decides, and a name missing
from `scopes` means the full catalog. The adapter adds `i18nScope` to TanStack's
`StaticDataRouteOption`. List the same route files in the scope's `modules`, so
the scope has the messages those pages read.

- The server renders every page with the full catalog. On a page of a scope it
  writes `data-nordbeam-locale-scope` on `<html>` through `useHtmlAttributes()`,
  and hints the scope's catalog chunks instead of the full catalog's.
- The browser loads the catalog that attribute names. Without the attribute,
  it loads the full catalog.
- A navigation to a page outside the scope, or of another scope, loads the full
  catalog in the root `beforeLoad` and renders the next page with it. The full
  catalog then serves every page, so the browser loads it at most once. A
  preload of such a page fetches it without changing the page on screen.
- A locale switch on a page of a scope loads the new locale's scope.
- In the browser, `load(locale)` returns the catalog in use, which on a page of
  a scope is the scope's. While that catalog is still loading, as in a
  `hydrate` hook of your own, it waits for it instead of loading the full one.

A page of a scope that reads a message outside it gets `undefined` and fails in
the browser, while the server, which uses the full catalog, renders it. In
development the `loadLocale` of a scope computed from code logs each such read; open
the scope's pages in development before you ship a change to its modules.
On Nordsynk's marketing pages, a scope computed from the 59 marketing route
files holds 2,717 of the app's 7,629 messages. It halved the catalog download
(135.7 to 68.2 KB brotli for Swedish) and made hydration 0.40 to 0.71 s earlier
on a slow 4G profile, with first paint unchanged (medians of 5 runs on 5 pages,
against the same build without `scopes`).

## Limitations

- **`{-$locale}` optional params are not used.** TanStack documents both a
  `{-$locale}` route and a `rewrite` for locale prefixes. The rewrite keeps your
  route tree, `Link` types and loaders free of a locale param, and it localizes
  pathnames, which an optional param cannot.
- **`router.navigate` between locales is a no-op.** The internal URL is the same
  in every locale, and the router skips a navigation to its current internal URL.
  `LocaleLink` and `setLocale` push the public URL on the router history instead.
  Use them for locale changes.
- **`domains` need the public host in the request URL.** The rewrite reads the
  host of the router's `origin`, which Start takes from the request URL. Behind a
  proxy that changes `Host`, pass the public `origin` to `createRouter` and set
  `trustForwardedHost` on the middleware.
- **Static prerendering and SPA mode have no request middleware.** Prefixed URLs
  still resolve through the rewrite, but redirects, detection and the cookie need a
  server. These modes are not covered by the check.
- **Link types are TanStack's.** Route paths are not checked against the keys of
  `pathnames`, so a typo in a `pathnames` key is not a type error. A key that
  matches no route simply never matches a URL.

## Types

- `defineRouting(routing)` returns the routing with its literal locales.
- `TanStackStartRouting<Locale, Pathnames>` is the routing type.
- `TanStackStartRouterContext<Locale>` is the root context to pass to
  `createRootRouteWithContext`; `TanStackStartRouterState<Locale>` is its entry.
- `TanStackStartMiddlewareOptions`, `TanStackStartI18nOptions` and
  `TanStackStartGetPathnameOptions` are the option types.
- `getLocaleDirection(locale)` returns `'ltr'` or `'rtl'`.
- `NORDBEAM_LOCALE_HEADER` is `x-nordbeam-locale`.
