# Next routing — `@nordbeam/locale/next/routing`

Localized pathnames for the App Router: `/about` is `/ueber-uns` in German and
`/blog/[slug]` is `/artikel/[slug]`, while the code keeps one internal route per
page. `defineRouting` validates a routing object once and gives it precise types.
The same object is passed to the middleware and to navigation.

The module is pure and Edge-safe: it imports no React, Next or Node modules.

```ts
// i18n/routing.ts
import { defineRouting } from '@nordbeam/locale/next/routing';

export const routing = defineRouting({
  locales: ['en', 'de', 'fr'],
  defaultLocale: 'en',
  localePrefix: 'as-needed',
  pathnames: {
    // A string applies to every locale. An object lists the localized
    // variants; a missing locale falls back to the internal pattern.
    '/about': { de: '/ueber-uns', fr: '/a-propos' },
    '/blog': { de: '/artikel', fr: '/blogue' },
    '/blog/[slug]': { de: '/artikel/[slug]', fr: '/blogue/[slug]' },
    '/docs/[...path]': { de: '/dokumente/[...path]' },
    '/shop/[[...category]]': { de: '/laden/[[...category]]' },
    '/pricing': '/preise',
  },
});
```

The internal keys are the route names in your code, and `app/[locale]/...` keeps
its own directory names. The values are what users see.

## Proxy

```ts
// proxy.ts
import { createNextMiddleware } from '@nordbeam/locale/next/middleware';
import { routing } from './i18n/routing';

export default createNextMiddleware(routing);

export const config = {
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
};
```

A request for `/de/ueber-uns` is rewritten to `/de/about`. `/de/about` redirects
to `/de/ueber-uns`. Paths that are not in `pathnames` behave as before. See
[next-middleware](./next-middleware.md) for the redirect and header rules.

## Navigation

```ts
// i18n/navigation.ts
import { createNextNavigation } from '@nordbeam/locale/next/navigation';
import { routing } from './routing';

export const { Link, redirect, permanentRedirect, usePathname, useRouter, getPathname } =
  createNextNavigation(routing);
```

Use the internal path, and the link is localized for the target locale:

```tsx
import { Link } from '@/i18n/navigation';

export function Nav({ posts }: { posts: { key: string; title: string }[] }) {
  return (
    <nav>
      <Link href="/about">About</Link>
      {posts.map(post => (
        <Link key={post.key} href={{ pathname: '/blog/[slug]', params: { slug: post.key } }}>
          {post.title}
        </Link>
      ))}
    </nav>
  );
}
```

On `/de/...` the first link is `/de/ueber-uns` and the posts are `/de/artikel/<key>`.
A `Link` with no `locale` prop uses the current locale.

## Language switcher

`usePathname()` returns the internal concrete path (`/blog/hello`), not the
template, so the switcher can pass it straight back to the router:

```tsx
'use client';
import { usePathname, useRouter } from '@/i18n/navigation';

export function LocaleSwitcher({ locales }: { locales: readonly string[] }) {
  const pathname = usePathname();
  const router = useRouter();
  return (
    <select
      defaultValue=""
      onChange={event => router.replace(pathname, { locale: event.target.value as never })}
    >
      {locales.map(locale => <option key={locale} value={locale}>{locale}</option>)}
    </select>
  );
}
```

On `/de/artikel/hello`, choosing `fr` navigates to `/fr/blogue/hello`. The
internal path is `/blog/hello` in both.

## Static params and sitemaps

Localized pathnames change the static segments only. A parameter value passes
through unchanged, so the slug of a post is the same in every locale. Keep a
stable key for each post and generate one page per locale and key. The
localized URLs come from `getPathname`:

```tsx
// app/[locale]/blog/[slug]/page.tsx
import { routing } from '@/i18n/routing';
import { getPosts } from '@/lib/posts';

export function generateStaticParams() {
  // The internal slug is the post key, so every locale gets the same param.
  return routing.locales.flatMap(locale => getPosts().map(post => ({ locale, slug: post.key })));
}
```

```ts
// app/sitemap.ts
import { getPathname } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';
import { getPosts } from '@/lib/posts';

export default function sitemap() {
  const base = 'https://example.com';
  return getPosts().flatMap(post =>
    routing.locales.map(locale => ({
      url: base + getPathname({ href: { pathname: '/blog/[slug]', params: { slug: post.key } }, locale }),
      alternates: {
        languages: Object.fromEntries(routing.locales.map(item => [
          item,
          base + getPathname({ href: { pathname: '/blog/[slug]', params: { slug: post.key } }, locale: item }),
        ])),
      },
    })),
  );
}
```

`getPathname` fills the localized pattern and the locale prefix, so each entry
is the URL the middleware serves for that page.

## Redirects

```tsx
import { redirect } from '@/i18n/navigation';

redirect('/about', 'de'); // /de/ueber-uns
redirect({ pathname: '/blog/[slug]', params: { slug: 'hello' } }, { locale: 'fr' }); // /fr/blogue/hello
```

## Param encoding

Params are encoded once, one segment at a time, with `encodeURIComponent`.
A decoded value is never decoded again, so these round-trip unchanged:

| Param value | Path segment |
| --- | --- |
| `a/b` | `a%2Fb` |
| `hello world` | `hello%20world` |
| `100%` | `100%25` |
| `café` | `caf%C3%A9` |

Catch-all params keep each array item as its own segment, so `['a', 'b/c']` is
`a/b%2Fc`.

## Pattern syntax

| Segment | Matches | Param type |
| --- | --- | --- |
| `about` | that text | none |
| `[slug]` | one segment | `string` |
| `[...path]` | one or more segments | `string[]` |
| `[[...path]]` | zero or more segments | `string[] \| undefined` |

Patterns start with `/`, have no trailing slash, and use each param name once.
A catch-all or optional catch-all must be the last segment. Every localized
variant must declare the same params, with the same kinds, as its internal pattern.

When two patterns could match the same path, the more specific one wins: static
segments before `[param]`, `[param]` before `[...catch-all]`, and then the
shorter pattern. Two patterns with the same shape in one locale are rejected at
`defineRouting`.

## Validation

`defineRouting` throws a `TypeError` for an invalid routing object: an empty
`locales` list, a `defaultLocale` that is not listed, duplicate locales, a bad
pattern, a variant for an unknown locale, mismatched params, or an ambiguous
pair. The middleware and navigation factories validate the same way.

## Types

- `defineRouting(routing)` returns the routing with its literal locales and pathname keys.
- `NextRouting<Locale, Pathnames>` is the routing type. `NextMiddlewareRouting`
  and `NextNavigationRouting` are aliases of it.
- `PathParams<Pattern>` gives the params of a pattern.
- `NextDomain` is one entry of `domains`.
- `getPathname({ href, locale, domain? }, routing)` is the pure form of the navigation
  `getPathname`, for code that does not use the factory. With `domain`, it
  follows that domain's rules, as described in [next-navigation](./next-navigation.md).
- `toInternalPath`, `toInternalPathAny` and `toExternalPath` map between
  internal and external paths for a locale.
- `domainRouting(routing, host)` is the routing a host is served with, or
  `undefined` for an unknown host. `servingDomain(routing, locale)` is the first
  domain that serves a locale.

## Domains

`domains` serves locales from their own hosts instead of, or as well as, a path
prefix. It works like next-intl's `domains`. Each host lists the locales it
serves, and its `defaultLocale` is the locale of its unprefixed paths:

```ts
// i18n/routing.ts
import { defineRouting } from '@nordbeam/locale/next/routing';

export const routing = defineRouting({
  locales: ['en', 'de', 'fr'],
  defaultLocale: 'en',
  localePrefix: 'as-needed',
  pathnames: {
    '/about': { de: '/ueber-uns', fr: '/a-propos' },
    '/blog/[slug]': { de: '/artikel/[slug]' },
  },
  domains: [
    // example.com serves English and French. Its unprefixed paths are English.
    { domain: 'example.com', defaultLocale: 'en', locales: ['en', 'fr'] },
    // example.de serves German only, so its unprefixed paths are German.
    { domain: 'example.de', defaultLocale: 'de', locales: ['de'] },
  ],
});
```

A domain is a host, with an optional port, and no protocol: `example.de` or
`localhost:3001`. Matching is case-insensitive. `locales` defaults to every
routing locale.

```ts
// proxy.ts
import { createNextMiddleware } from '@nordbeam/locale/next/middleware';
import { routing } from './i18n/routing';

export default createNextMiddleware(routing);

export const config = {
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
};
```

What the middleware does for a request on a configured host:

- The locale is resolved among that host's locales: the prefix, then the
  cookie, then `Accept-Language`, then the host's `defaultLocale`. A German
  cookie is ignored on `example.com`.
- The `localePrefix` mode applies per host. Under `as-needed`, the host's
  `defaultLocale` is unprefixed there: `example.de/ueber-uns` is German, and
  `example.com/about` is English.
- A prefixed locale that this host does not serve is redirected (307) to the
  first domain that serves it. The redirect keeps the page and the query, and
  uses the localized path for that locale and the request protocol.
  `example.com/de/ueber-uns?x=1` goes to `https://example.de/ueber-uns?x=1`.
  A redirect only ever names a configured domain.
- The `x-nordbeam-domain` header names the matched domain, or is empty. The
  middleware sets it on every path, so a client cannot spoof it.

A request on any other host, such as an unknown host or `localhost` during
development, uses the routing alone, exactly as it does without `domains`.

The middleware reads the host from the `host` header. Behind a reverse proxy
that sets `x-forwarded-host`, pass `trustForwardedHost` to read that header
first:

```ts
export default createNextMiddleware(routing, { trustForwardedHost: true });
```

Enable it only when the proxy overwrites `x-forwarded-host`. Otherwise any
client can choose its host.

Alternate links are absolute URLs. Each locale is on the first domain that
serves it, and `x-default` is the routing's `defaultLocale` on its domain. A
locale that no domain serves is left out of the alternates.

### Language switcher across domains

`router.replace` takes the locale and resolves the href against the current
host. A locale on another domain becomes an absolute URL, so the switch leaves
for that domain:

```tsx
'use client';
import { usePathname, useRouter } from '@/i18n/navigation';

export function LocaleSwitcher({ locales }: { locales: readonly string[] }) {
  const pathname = usePathname();
  const router = useRouter();
  return (
    <select
      defaultValue=""
      onChange={event => router.replace(pathname, { locale: event.target.value as never })}
    >
      {locales.map(locale => <option key={locale} value={locale}>{locale}</option>)}
    </select>
  );
}
```

On `example.de/ueber-uns`, choosing `fr` goes to `https://example.com/fr/a-propos`.
`usePathname()` is `/about` on both hosts, so the same switcher works everywhere.

### Testing domains locally

Map each domain to the loopback address. Then include the port in the domain,
because the `Host` header carries it. In development:

```txt
# /etc/hosts
127.0.0.1 example.com example.de
```

```ts
// i18n/routing.ts
const port = process.env.NODE_ENV === 'development' ? ':3000' : '';

export const routing = defineRouting({
  // ...
  domains: [
    { domain: `example.com${port}`, defaultLocale: 'en', locales: ['en', 'fr'] },
    { domain: `example.de${port}`, defaultLocale: 'de', locales: ['de'] },
  ],
});
```

Run `next dev -p 3000`, then open `http://example.com:3000` and
`http://example.de:3000`. The protocol is `http` for the redirects too, because
the request is `http`. A single domain can also use `localhost:<port>` with no
hosts entry: `{ domain: 'localhost:3001', defaultLocale: 'fr', locales: ['fr'] }`
and `next dev -p 3001`.

### Validation

`defineRouting` throws a `TypeError` when:

- two domains name the same host, in any case (`Example.com` and `example.com`);
- a domain is not a bare host: it has a protocol, a path, a query, `@`, or a space;
- a domain's `locales` are not unique routing locales, or are empty;
- a domain's `defaultLocale` is not in its `locales`.

Every routing locale is reachable. A locale no domain serves is still served on
hosts that are not configured, which is how `localhost` works during
development. It is not reachable on a configured host.
