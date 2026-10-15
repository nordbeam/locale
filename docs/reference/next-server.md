# Next server — `@nordbeam/locale/next/server`

Read the locale selected by the Nordbeam middleware from the request headers in
a Server Component or route handler.

```ts
import { getLocale } from '@nordbeam/locale/next/server';

const locale = await getLocale(routing);
```

`getLocale(routing?)` returns the locale string or `undefined`. It accepts a
locale list or an object with a `locales` array (for example the same routing
object passed to `createNextMiddleware`).

- With a list, it returns the header only when the value is one of the listed
  locales.
- Without a list, it returns the header only when the value is a canonical
  BCP 47 tag (`Intl.getCanonicalLocales(value)[0] === value`).

Pass the list in every route that the middleware matcher excludes, such as
`/api/*` or static routes. The middleware does not run there, so
`x-nordbeam-locale` is whatever the client sent, and it must not be trusted
without validation. Inside routes the middleware handled, the header is set
on every request and is safe to read; passing the list is still recommended.

`getDomain(routing?)` returns the domain the middleware matched, or `undefined`:

```ts
import { getDomain } from '@nordbeam/locale/next/server';

const domain = await getDomain(routing); // 'example.de', or undefined
```

With the routing, only one of its configured domains is returned, in lowercase.
Without it, any host-shaped value is returned. Pass the routing wherever
the middleware matcher excludes the route, as with `getLocale`, because the
header is client-controlled there.

Keep it request-local; do not store the result in module-global mutable state.
