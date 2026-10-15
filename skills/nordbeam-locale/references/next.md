# Next.js App Router

Package entries: `@nordbeam/locale/next` (build wrapper), `/next/runtime` (route helper, Edge-safe), `/next/routing` (`defineRouting`), `/next/middleware` (`createNextMiddleware`), `/next/navigation` (`createNextNavigation`), `/next/server` (`getLocale`, `getDomain`), `@nordbeam/locale/react` (client adapter), `/react/rich` (rich text). The Vite plugin's selection transform does not run in Next.

## Setup

```sh
npx nordbeam-locale init --framework next
```

Creates, when missing: `next.config.mjs` (`withNordbeamLocale({})`), `src/i18n/next.ts` (`i18n = createNextI18n({ locales, loadLocale })`), `src/i18n/client.ts` (`'use client'`, `createClientI18n`), `src/i18n/provider.ts` (`NordbeamLocaleProvider`), `src/i18n/routing.ts` (`defineRouting`, `localePrefix: 'always'`), and the request file `proxy.ts` (`middleware.ts` before Next 16), written beside the `app` directory: `src/proxy.ts` (importing `./i18n/routing`) when the routes are in `src/app`, otherwise at the project root. Existing config and request files are preserved, so wire them by hand:

```js
// next.config.mjs (or wrap an existing config; async factories work too)
import { withNordbeamLocale } from '@nordbeam/locale/next';
export default withNordbeamLocale({ reactStrictMode: true });
```

```ts
// proxy.ts (middleware.ts on Next 15 and earlier) lives next to the app directory:
// at the project root, or inside src/ when the routes are in src/app
import { createNextMiddleware } from '@nordbeam/locale/next/middleware';
import { routing } from './src/i18n/routing';

export default createNextMiddleware(routing);

export const config = {
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
};
```

Init always writes the request file at the project root. If the app lives in `src/app`, move it to `src/` and fix the relative import (`./i18n/routing`), or Next ignores it. Keep the matcher exactly as scaffolded: it keeps `/api`, `/_next`, `/_vercel` and file-like paths out of locale routing. Changing it changes which routes get locale prefixes and rewrites.

`withNordbeamLocale` generates before builds and watches catalogs during `next dev`, so no separate watcher is needed. Pass overrides as the second argument when the config is not at the app root (`root`, `catalogs`, `outDir`, `baseLocale`).

## Routes: validate the locale segment, then load

```tsx
// app/[locale]/page.tsx
import { notFound } from 'next/navigation';
import { i18n } from '../../src/i18n/next';

export const dynamicParams = false;
export function generateStaticParams() { return i18n.generateStaticParams(); }

export default async function Page({ params }: PageProps<'/[locale]'>) {
  const { locale } = await params;
  if (!i18n.hasLocale(locale)) notFound();
  const { messages: m } = await i18n.loadLocale(locale);
  return <h1>{m.greeting({ name: 'Ada' })}</h1>;
}
```

The route param is a plain string until `hasLocale` narrows it. `generateStaticParams('lang')` supports a `[lang]` segment. Server Components call message functions directly and ship no client runtime for that text. Rich text in a Server Component: `import { rich } from '@nordbeam/locale/react/rich'`.

Layout with the document language and the client provider, so Client Components can use `useI18n`:

```tsx
// app/[locale]/layout.tsx
import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { i18n } from '../../src/i18n/next';
import { NordbeamLocaleProvider } from '../../src/i18n/provider';

export default async function LocaleLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!i18n.hasLocale(locale)) notFound();
  return <html lang={locale}><body><NordbeamLocaleProvider locale={locale}>{children}</NordbeamLocaleProvider></body></html>;
}
```

For right-to-left locales also set `dir` on `<html>` from the locale (for example via `new Intl.Locale(locale).maximize().script`).

## Client Components

```tsx
'use client';
import { i18n } from '../../src/i18n/client';

export function Counter() {
  const { messages: m, locale, setLocale, pending } = i18n.useI18n();
  return <button aria-busy={pending} onClick={() => setLocale('fr')}>{m.items({ count: 2 })}</button>;
}
```

- Pass only serialisable values across the Server to Client boundary, for example the locale string. Never pass `LoadedLocale`, a messages object, message functions or slot callbacks as props; React Flight rejects functions.
- `NordbeamLocaleProvider` (or `<i18n.Provider initialLocale={locale} preload={['fr']} fallback={...}>`) owns the client locale state and loads the client catalog itself.
- `setLocale` in this adapter is a client-state switch and returns nothing. For URL-based switching use the navigation helpers below.

## Locale-aware navigation

`init` does not create this file; add it once from the shared routing:

```ts
// src/i18n/navigation.ts
import { createNextNavigation } from '@nordbeam/locale/next/navigation';
import { routing } from './routing';

export const { Link, useRouter, usePathname, redirect, permanentRedirect, getPathname } = createNextNavigation(routing);
```

```tsx
<Link href="/" locale="de">Deutsch</Link>
```

A `Link` without `locale` uses the current locale. `usePathname()` returns the internal concrete path, which can be passed straight back: `router.replace(pathname, { locale: 'fr' })` is the whole language switcher. `redirect(href, locale)` always needs an explicit locale.

Localized URL paths and hosts are routing config, not code:

```ts
// src/i18n/routing.ts
export const routing = defineRouting({
  locales, defaultLocale: baseLocale, localePrefix: 'as-needed', // 'always' | 'as-needed' | 'never'
  pathnames: { '/about': { de: '/ueber-uns', fr: '/a-propos' }, '/blog/[slug]': { de: '/artikel/[slug]' } },
});
```

Keep `app/[locale]/about` as the internal route; users see `/de/ueber-uns`. Use `getPathname({ href, locale })` for sitemaps and `hreflang`. Full details for `pathnames`, `domains`, param encoding and sitemaps: https://github.com/nordbeam/locale/blob/main/docs/reference/next-routing.md and https://github.com/nordbeam/locale/blob/main/docs/reference/next-navigation.md

## Reading the locale on the server

```ts
import { getLocale } from '@nordbeam/locale/next/server';
import { routing } from '../../../src/i18n/routing';

const locale = await getLocale(routing); // undefined unless it is one of routing.locales
```

Always pass `routing` in route handlers and any path the matcher excludes: the middleware does not run there, so `x-nordbeam-locale` is whatever the client sent. Without an argument `getLocale()` accepts any canonical BCP 47 tag, which is only safe on routes the middleware handled.

## Bundle boundaries

Next does not prune by `selectMessages`. For a route-sized or client-sized chunk define scopes and import that loader:

```json
{ "scopes": { "checkout": ["checkout.*", "common.navigation"] } }
```

```ts
import { loadLocale, locales } from '../../src/i18n/scopes/checkout/index.js';
```

For fixed-language content import named messages (`import { greeting } from '../src/i18n/locales/en.js'`); unused named exports tree-shake. Use `createNextI18n({ locales, loadLocale })` from `/next/runtime` with a scope's `loadLocale` and `locales` to scope a route.

## Checks specific to Next

- `generate` and `check` are framework-independent; run them before `next build`. Build scripts must set `NODE_ENV=production` for production output.
- A 404 for every localized URL usually means the request file is not next to `app/` or the matcher was edited.
- Edge route handlers may import `@nordbeam/locale/next/runtime` and `/next/routing` (no Node or Next imports); `/next/middleware` is Edge-safe by design. The navigation and server entries use React and Next APIs.
- https://github.com/nordbeam/locale/blob/main/docs/NEXTJS.md has the middleware matcher security notes, Edge usage and verification commands.
