# Next.js integration

Status: Next.js App Router is a supported integration. The examples exercise
the build, server, client, and middleware boundaries documented here.

## Build configuration

`@nordbeam/locale/next` is a build-only entry. It resolves static or asynchronous Next
configuration, reads `nordbeam-locale.config.json`, generates typed ESM, and then
returns the original Next configuration unchanged:

```js
import { withNordbeamLocale } from '@nordbeam/locale/next';

export default withNordbeamLocale({
  reactStrictMode: true,
});
```

Pass generation overrides as the second argument when the config file is not at
the application root:

```js
import { fileURLToPath } from 'node:url';

export default withNordbeamLocale(nextConfig, {
  root: fileURLToPath(new URL('.', import.meta.url)),
  catalogs: 'translations',
  outDir: 'src/i18n',
  baseLocale: 'en',
});
```

Next permits an asynchronous top-level configuration function. The adapter does
not install webpack plugins or Turbopack loaders: Turbopack does not support
webpack plugins, its loader API is partial, and custom webpack configuration is
outside Next's semver guarantees. Ordinary generated ESM keeps both build paths
on the same behavior. In development, `withNordbeamLocale` starts the catalog
watcher inside `next dev`, so a second terminal is not required. Catalog errors
retain their JSON location and the last successful generated output remains
available until repair. Use the standalone `nordbeam-locale --watch` command only
when Next is not starting the generator for you.

## Locale middleware

Use the separate runtime entry when URLs are localized. It is suitable for a
Next proxy or middleware and keeps locale routing independent of `next-intl`:

```ts
import { createNextMiddleware } from '@nordbeam/locale/next/middleware';

const routing = {
  locales: ['en', 'fr'],
  defaultLocale: 'en',
  localePrefix: 'as-needed',
} as const;

export default createNextMiddleware(routing);
```

`localePrefix` accepts `always`, `as-needed`, or `never`, plus custom prefix
objects. Locale detection checks a configurable cookie (default
`NEXT_LOCALE`) and `Accept-Language`; set `localeDetection: false` to use only
the URL and default locale. Query strings, canonical redirects, internal
`[locale]` rewrites, locale request headers, and alternate/x-default links are
preserved. A migrated conventional `next-intl/middleware` proxy is rewritten
in place to this helper automatically (no second request file is added);
unusual middleware composition is reported for manual review.

### The middleware matcher

`init --framework next` writes `proxy.ts` (`middleware.ts` before Next 16) with
this matcher, and it should stay as scaffolded. Next only loads the file from the
folder that holds `app/`, so it goes in `src/` for a `src/app` project (with
imports relative to `src/`) and at the project root otherwise. An existing
`proxy` or `middleware` file in that folder is preserved:

```ts
export const config = {
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
};
```

Next matches the request pathname against this pattern. Testing the pattern
directly against sample paths gives:

- Excluded: a first segment that starts with `api`, `_next`, or `_vercel`. The
  check is a prefix match, so `/api`, `/api/users`, `/apiary`, and `/_next/static/x.js`
  are all excluded.
- Excluded: any path containing a dot anywhere, such as `/favicon.ico` or
  `/blog/v1.2`.
- Included: everything else, including `/`, `/en/about`, `/apps`, and
  locale-prefixed API paths such as `/fr/api/users`.

**Security meaning.** When the middleware passes a request on, it sets
`x-nordbeam-locale` and `x-nordbeam-domain` on that request, overwriting any value
the client sent. Requests the matcher excludes do not run the middleware, so no
header is set on them. A client can send `x-nordbeam-locale` directly, and the
value reaches the route unchanged. A route handler therefore must not trust it
as-is. Pass the routing to `getLocale`, which accepts only the configured
locales:

```ts
// app/api/locale/route.ts
import { getLocale } from '@nordbeam/locale/next/server';
import { routing } from '../../../src/i18n/routing';

export async function GET() {
  const locale = await getLocale(routing); // undefined for any other value
  return Response.json({ locale: locale ?? routing.defaultLocale });
}
```

`getLocale()` without an argument accepts any canonical BCP 47 tag, so it is
only safe on routes the middleware has already validated. Keep the excluded
paths to static assets and API routes. If you change the matcher, check which
routes it newly covers, because those routes then receive locale prefixes and
rewrites.

## App Router locale routes

Prefer a URL locale segment such as `app/[locale]`. The generated locale is a
string at the route boundary, so validate it before loading:

```tsx
import { notFound } from 'next/navigation';
import { createNextI18n } from '@nordbeam/locale/next/runtime';
import { locales, loadLocale } from '@/i18n/scopes/site/index.js';

const i18n = createNextI18n({ locales, loadLocale });

export const dynamicParams = false;
export function generateStaticParams() {
  return i18n.generateStaticParams();
}

export default async function Page({ params }: PageProps<'/[locale]'>) {
  const { locale } = await params;
  if (!i18n.hasLocale(locale)) notFound();
  const { messages: m } = await i18n.loadLocale(locale);
  return <h1>{m.title()}</h1>;
}
```

`generateStaticParams('lang')` supports a `[lang]` segment. Leave it out for
request-time rendering. The helper has no Node or Next imports, so it can be
used in Node, Edge, and client graphs.

## Bundle boundaries

The Vite-only inference and virtual projection transform does not run in Next.
For a route-sized dynamic locale chunk, define a compiler scope:

```json
{
  "baseLocale": "en",
  "scopes": {
    "checkout": ["checkout.*", "common.navigation"]
  }
}
```

```ts
import { loadLocale } from '@/i18n/scopes/checkout/index.js';
```

For fixed-language content, import named messages from
`i18n/locales/en.js`; Next can tree-shake unused named exports. The runtime
`selectMessages(...)` helper selects keys after the full catalog has loaded
when no build transform is present, so it is not a Next bundle-size boundary.

Server Components can call generated message functions and send only their
rendered result. React Flight requires Client Component props to be serializable,
therefore do not pass `LoadedLocale`, a messages object, or slot callbacks from
a Server Component. Pass the validated locale string and let a deeply placed
client provider load its configured scope.

For a client-side locale switch, use `createClientI18n`. Its provider owns the
locale and automatically keeps revealed content visible while a cold catalog
loads:

```tsx
const i18n = createClientI18n(loadLocale);

function LocaleButton() {
  const { setLocale, pending } = i18n.useI18n();
  return <button aria-busy={pending} onClick={() => setLocale('fr')}>Français</button>;
}
```

For likely follow-up locales, pass `preload` to the client provider.
The provider begins those imports after hydration, keeping server rendering
locale-scoped while removing the network round trip from a later switch:

```tsx
const likelyLocales = ['fr', 'ar'] as const;

<i18n.Provider initialLocale={locale} preload={likelyLocales}>
  {children}
</i18n.Provider>
```

This is opt-in because every preloaded locale adds its catalog chunk to the
initial client transfer. For larger locale sets, call `i18n.preload(locale)` on
intent (for example focus or pointer entry) instead. The provider detects the
warm cache and commits the later `setLocale(locale)` synchronously; cold changes
are transitioned automatically. Use the lower-level `createSuspenseI18n` only
when a router or another store must own the locale state.

`useMessages(selectedLoader)` and `useI18n(selectedLoader)` also accept a stable
loader created with `selectMessages(...)`. This gives each component a narrowed
message type and an independent Suspense resource. Under Vite, literal
selections become separate message chunks. In Next.js, prefer generated scopes
for route/client boundaries because the Next integration does not claim Vite's
per-call selection transform.

Nested catalog paths are available as typed property calls in server and client
code: `messages.product.price({ amount: 20 })`. The canonical dotted ID remains
available as `messages['product.price']`, and both references are the same
formatter. Namespace aliases are generated statically and require no Proxy or
client runtime package.

## Verification

The checked application in `examples/next` covers:

- static generation for English, French, and Arabic;
- dynamic SSR with concurrent locales;
- an Edge runtime route that imports only `@nordbeam/locale/next/runtime`;
- rich output in a Server Component;
- locale-only props crossing the Client Component boundary;
- real Chrome hydration and an interactive locale switch with no browser errors;
- invalid locale 404s;
- a fixed-locale named import;
- an unused translation sentinel absent from browser chunks.

Run both supported bundlers:

```sh
npm run next:check
npm run next:check:webpack
```

For the Edge integration:

```sh
npm run next:check:edge
```

Run the real-browser direction and locale-switch check with:

```sh
npm run next:rtl:check
```

The generated runtime is intentionally dependency-light.

Design references: [Next internationalization](https://nextjs.org/docs/app/guides/internationalization),
[Server and Client Components](https://nextjs.org/docs/app/getting-started/server-and-client-components),
[`generateStaticParams`](https://nextjs.org/docs/app/api-reference/functions/generate-static-params),
[async Next configuration](https://nextjs.org/docs/app/api-reference/config/next-config-js),
[Turbopack limitations](https://nextjs.org/docs/app/api-reference/turbopack), and
[custom webpack configuration](https://nextjs.org/docs/pages/api-reference/config/next-config-js/webpack).
