# Next navigation — `@nordbeam/locale/next/navigation`

Create locale-aware App Router navigation primitives with a routing policy
shared by links, hooks, and redirects.

```ts
import { createNextNavigation } from '@nordbeam/locale/next/navigation';
const { Link, useRouter, usePathname, redirect, permanentRedirect, getPathname } = createNextNavigation(routing);
```

The returned surface mirrors the common `next-intl` navigation shape. `Link`,
`useRouter`, `redirect` and `permanentRedirect` accept a locale override.
`createNavigation` is an alias.

## Internal paths

Hrefs are internal paths: the route as your code names it, such as `/about`
or `/blog/hello`. With `pathnames` in the routing, every href is localized for
the target locale, so `/about` becomes `/de/ueber-uns` in German. Plain
strings keep working. The object form names a pattern and its params:

```tsx
<Link href={{ pathname: '/blog/[slug]', params: { slug: 'hello' }, query: { tab: 'all' } }}>Post</Link>
// German: /de/artikel/hello?tab=all
```

With `pathnames`, `pathname` is one of its keys and `params` is typed from the
pattern: `[slug]` takes a string, `[...path]` a string array, and an optional
catch-all can be left out. Unknown keys and wrong params are type errors.
Without `pathnames`, the object form takes any `pathname` and `params`.

`usePathname()` returns the internal concrete path, not the template:
`/de/artikel/hello` is `/blog/hello`. This differs from next-intl, which
returns the template `/blog/[slug]`. A concrete path is what you need for a
language switcher, because it can be passed back to the router:

```tsx
const pathname = usePathname(); // '/blog/hello'
router.replace(pathname, { locale: 'de' }); // /de/artikel/hello
```

`getPathname({ href, locale, domain? })` returns the full external href for a locale,
with its prefix, localized path, query and hash. Use it for `<a href>`,
sitemaps and `hreflang` values.

With `domain`, the href follows that domain's prefix rules. A locale the domain
does not serve gets the absolute URL on the domain that serves it, with `https`,
or `http` for a localhost domain. A domain that is not configured is ignored:

```ts
const { getPathname } = createNextNavigation(routing); // routing from next-routing.md

getPathname({ href: '/about', locale: 'fr', domain: 'example.com' }); // '/fr/a-propos'
getPathname({ href: '/about', locale: 'de', domain: 'example.com' }); // 'https://example.de/ueber-uns'
getPathname({ href: '/about', locale: 'en', domain: 'example.de' }); // 'https://example.com/about'
```

Sitemap entries use this to list each locale on its own domain.

### Current host

On a routing with `domains`, `Link`, `useRouter().push`, `replace` and
`prefetch` need the host the page is on, to know which domain's rules apply.
The host is only known in the browser. So the first render, which the server
also produces, uses the prefixed form that every host can serve:

- Server render and hydration: `/de/ueber-uns`. This is the same on every host,
  so the markup matches the server.
- After mount, on `example.de`: `/ueber-uns`. This is read with
  `useSyncExternalStore`, so React updates the link once the page is running.

Trade-off: until the page mounts, a link to the domain's default locale is
prefixed. It still works, because the middleware redirects it to the unprefixed
form on that domain, and a crawler reads the prefixed form. A link to a locale
another domain serves is `/fr/...` before mount, and a redirect takes the
visitor to that domain. Clicks made before hydration take that extra hop. After
mount, the link is the direct URL.

Routings without `domains` render exactly as before.

`redirect` and `permanentRedirect` take the same arguments: the href and
either a locale or `{ locale }`. A root-relative path without a locale prefix
still needs an explicit locale.

`Link` is safe in Server and Client Components: the factory can be imported from
a shared server module, and only the locale-aware anchor runs on the client. It
accepts the usual anchor attributes (`className`, `onClick`, `target`, ...) and
the Next `Link` props (`prefetch`, `scroll`, ...).

`redirect(href, locale)` always takes an explicit locale. Pass `false` to keep
the href exactly as written, or `{ locale }` as the object form. A root-relative
path that has no locale prefix throws a `TypeError` when the locale is missing,
because there is no current request locale to fall back on.

Hrefs are localized only when they are root-relative paths such as `/about`.
Relative (`about`), hash-only (`#top`), query-only (`?page=2`), absolute
(`https://…`), protocol-relative (`//…`) and `URL` hrefs are passed through
unchanged. Query values that are `undefined` or `null` are omitted.

A href that starts with a locale prefix, such as `/de/ueber-uns`, is read as a
path in that locale and mapped back to its internal route before it is
localized for the target.

`locale={false}` keeps the href as written. A pattern object is still filled
from its params, but no locale prefix or localized segment is added.
