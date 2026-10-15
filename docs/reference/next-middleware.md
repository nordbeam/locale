# Next middleware — `@nordbeam/locale/next/middleware`

Use the Edge-safe middleware adapter for locale-prefixed URLs.

```ts
import { createNextMiddleware } from '@nordbeam/locale/next/middleware';

export default createNextMiddleware({
  locales: ['en', 'fr'], defaultLocale: 'en', localePrefix: 'as-needed',
});

// Run only on page and route-handler requests. Without a matcher the middleware
// also sees /api, /_next/static/*, and /favicon.ico, and redirects them.
export const config = {
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
};
```

Use the matcher above (or an equivalent) in every app. Without it, `/api/*`,
`/_next/static/*`, `/favicon.ico` and other static assets are treated as
unprefixed pages. With `localePrefix: 'always'` they are redirected to a
locale-prefixed URL; with `as-needed` they are rewritten to `/<locale>/...`.
Either way API calls and asset loading break.

The scaffolded matcher excludes a first segment that starts with `api`, `_next`,
or `_vercel` (a prefix match, so `/apiary` is excluded too) and any path that
contains a dot. Locale-prefixed API paths such as `/fr/api` are not excluded.
Routes that the matcher excludes do not run the middleware and get no locale
header, so a client-supplied `x-nordbeam-locale` reaches them unchanged. Read it
only through `getLocale(routing)` in [next-server](./next-server.md). The full
matcher discussion is in the [Next.js guide](../NEXTJS.md#the-middleware-matcher).

- `createNextMiddleware(routing, options?)` — returns a Next request handler.
- `NextMiddlewareOptions` — `trustForwardedHost`, described in [Domains](#domains).
- `NextMiddlewareRouting` and `NextLocaleCookieOptions` — routing types. The
  middleware's routing is the same `NextRouting` object that
  [next-routing](./next-routing.md) defines, so one `routing` serves the
  middleware and navigation.
- `NextLocalePrefixMode` — `always`, `as-needed`, or `never`.
- `NORDBEAM_LOCALE_HEADER` — header name set for downstream server helpers.
- `x-nordbeam-domain` — the matched domain, or empty. Set on every path, like
  `x-nordbeam-locale`, so a client value is overwritten.

## Locale cookie

`localeCookie` defaults to the `NEXT_LOCALE` cookie with `Path=/`,
`SameSite=lax`, and `Max-Age=31536000` (one year). The cookie is marked
`Secure` when the request URL is `https:`. Any value you pass in `localeCookie`
overrides these defaults, including `secure: false` on an https site.

## Accept-Language negotiation

When there is no prefix and no locale cookie, the middleware reads
`Accept-Language`:

- Entries are ordered by q-value, highest first; equal q-values keep their
  order in the header.
- A q-value must match the RFC 9110 grammar (`0` to `1` with up to three
  decimals). Entries with an invalid q-value, or with `q=0`, are ignored.
- `*` selects `defaultLocale`.
- Each tag is tried in order: an exact case-insensitive match first, then the
  same language, script and region after likely-subtag expansion (`zh-HK` and
  `zh-Hant` select a `zh-Hant` locale such as `zh-TW`; `zh` selects `zh-Hans`
  such as `zh-CN`), then the same language and script, then the same language
  (`en-AU` selects the first `en-*` locale in `locales`).
- Malformed tags are skipped. When nothing matches, `defaultLocale` is used.

## Canonical prefixes

Prefixes are matched case-insensitively, but only the canonical spelling is
served. `/EN/about?x=1` redirects to `/en/about?x=1`.

Redirect and rewrite targets are built from the raw request path, so an
encoded character such as `%2541` is never decoded twice.

## Localized pathnames

With `pathnames` in the routing (see [next-routing](./next-routing.md)), the
middleware maps each request path to its internal route:

- `/de/ueber-uns` for a `/about` route localized to `de` is rewritten to
  `/de/about`. The query string is kept.
- `/de/about`, or another locale's path such as `/fr/a-propos`, is redirected
  to the canonical localized path, `/de/ueber-uns` (307, query kept).
- A redirect that adds or changes a locale prefix goes to the target locale's
  localized path. A prefix-less localized path (`/ueber-uns`, resolved to `de`
  by cookie or `Accept-Language`) redirects to `/de/ueber-uns`.
- The `as-needed` default locale stays unprefixed: `/en/ueber-uns` redirects to
  `/about`.
- `Link` alternates list each locale's localized path: for `/fr/a-propos` the
  `hreflang="de"` entry is `/de/ueber-uns`, and `x-default` is the default
  locale's path.
- Paths that are not in `pathnames` behave exactly as before.

## Domains

With `domains` in the routing (see [next-routing](./next-routing.md#domains)),
the middleware first picks the host the request came for. The host is the
`host` header, or the first `x-forwarded-host` entry when `trustForwardedHost`
is `true`. It is matched case-insensitively against the configured domains.

On a configured host:

- The locale comes from the prefix, the cookie, `Accept-Language` or the host's
  `defaultLocale`, and only among the host's locales.
- A prefixed locale that the host does not serve is redirected (307) to the
  absolute URL on the first domain that serves it. The path is localized for
  that locale, the query is kept, and the request protocol is used.
- Alternate links are absolute, with each locale on its first serving domain.
  `x-default` is the routing's `defaultLocale` on its domain.

On any other host the routing is used as it is without domains. An unknown
`Host` never produces a redirect to a host outside the configured list.

Redirects on hosts that are not configured still use the request URL, as they
do without `domains`. Configure your hosts at the proxy, and do not rely on the
`Host` header to pick a domain you did not configure.

Localized paths are matched and produced per segment. A decoded value such as
`a/b` in `/artikel/a%2Fb` stays one segment, and encoded characters are never
decoded twice.
