# TanStack Start (React)

Package entry: `@nordbeam/locale/tanstack-start` (no Node or server-only imports, safe in the client bundle). Tested with `@tanstack/react-start` 1.169 and `@tanstack/react-router` 1.170 on Vite 8. Routes stay one unprefixed tree (`/about` is the only route file); the locale prefix and localized pathnames live in a TanStack Router `rewrite`, so `<Link to="/about">` becomes `/fr/a-propos` on a French page without a locale route param.

## Setup

```sh
npm install @nordbeam/locale @tanstack/react-start @tanstack/react-router
npx nordbeam-locale init --framework tanstack-start
```

Init writes, when missing: `src/i18n/routing.ts`, `src/i18n/tanstack.ts`, `src/start.ts`, `src/router.tsx`, `src/routes/__root.tsx`, and `vite.config.ts` only when the Vite plugins it needs are declared. In a verified run with just `@tanstack/react-start` and `vite` declared it printed a note instead of a Vite config: install `@vitejs/plugin-react`, then put `nordbeamLocale()` from `@nordbeam/locale/vite`, `tanstackStart()` from `@tanstack/react-start/plugin/vite` and `viteReact()` in the plugins. Init never edits an existing file; it prints what to add for each one you already have.

The pieces, as scaffolded:

```ts
// src/i18n/routing.ts
import { defineRouting } from '@nordbeam/locale/tanstack-start';
import { baseLocale, locales } from './index';

export const routing = defineRouting({
  locales,
  defaultLocale: baseLocale,
  localePrefix: 'as-needed',            // 'always' | 'as-needed' | 'never'
  pathnames: { '/about': { fr: '/a-propos' }, '/blog/$slug': { fr: '/blogue/$slug' } },
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
// src/start.ts: global request middleware (detection, redirects, cookie, hreflang Link header)
import { createStart } from '@tanstack/react-start';
import { createLocaleFunctionMiddleware, createLocaleMiddleware } from '@nordbeam/locale/tanstack-start';
import { routing } from './i18n/routing';

export const startInstance = createStart(() => ({
  requestMiddleware: [createLocaleMiddleware(routing)],
  functionMiddleware: [createLocaleFunctionMiddleware()],   // sends the page locale with server function calls
}));
```

```tsx
// src/router.tsx: the rewrite, its state, and the hydrate hook
export function getRouter() {
  return createRouter({ routeTree, scrollRestoration: true, ...i18n.routerOptions() });
}
// to add your own context: const options = i18n.routerOptions(); createRouter({ routeTree, ...options, context: { ...options.context, queryClient } })
// your own hydrate must call the locale one: hydrate: async () => { await options.hydrate(); /* yours */ }
```

```tsx
// src/routes/__root.tsx
export const Route = createRootRouteWithContext<TanStackStartRouterContext<(typeof i18n.locales)[number]>>()({
  beforeLoad: i18n.beforeLoad,                         // resolves the locale, loads its messages, returns { locale }
  shellComponent: RootDocument,                        // <html {...i18n.useHtmlAttributes()}> gives lang and dir
  component: () => <i18n.Provider><Outlet /></i18n.Provider>,
});
```

Call `i18n.routerOptions()` once per router, and keep its `hydrate`: it holds React hydration until the page's catalog (from `<html lang>`) is in. Without it the `Provider` suspends mid-hydration, and the first update above it (any effect that sets state) makes React replace the server HTML with an empty fallback until the catalog arrives. Pass `beforeLoad: i18n.beforeLoad` as is; no wrapper or return annotation is needed. `pathnames` keys are TanStack route paths (`/blog/$slug`, `/docs/$` with param `_splat`), every variant must declare the same params, and optional params (`{-$slug}`) or prefixed/suffixed params are rejected with a `TypeError`. A key that matches no route silently never matches, and keys are not type-checked against the route tree.

## Components, links, switching

```tsx
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

- Use TanStack's own `Link`, `navigate` and `redirect` with route paths; they follow the page's locale. `router.navigate` between locales is a no-op (the internal URL is unchanged), so switch locale with `i18n.LocaleLink` (a real `<a href>` to the current page in that locale) or `i18n.useSetLocale()` (`setLocale(locale)` loads the catalog, writes the cookie, then pushes the URL).
- `i18n.getPathname({ to, params?, search?, hash?, locale, domain? })` returns the external href, for sitemaps and `hreflang`: `i18n.getPathname({ to: '/blog/$slug', params: { slug: 'hello' }, locale: 'fr' })` is `/fr/blogue/hello`.
- Hooks `useMessages()`, `useLocale()`, `useI18n()` come from the Suspense React adapter; prefer `useMessages()` in components so text changes in the same commit as the URL.
- RTL: `i18n.useHtmlAttributes()` returns `{ lang, dir }`, with `dir="rtl"` for right-to-left scripts. `getLocaleDirection(locale)` is exported.

## Loaders and server functions

`beforeLoad` and loaders get `context.locale`. Load messages with the caching `i18n.load`:

```tsx
export const Route = createFileRoute('/blog/$slug')({
  loader: async ({ params, context }) => {
    const { messages } = await i18n.load(context.locale);
    return { title: messages.post({ slug: params.slug }) };
  },
});
```

```ts
import { createServerFn } from '@tanstack/react-start';
import { getLocale } from '@nordbeam/locale/tanstack-start';

const greet = createServerFn().handler(async () => {
  const { messages } = await i18n.load(getLocale() as 'en' | 'fr');   // or validate with i18n.locales.includes
  return messages.greeting({ name: 'Server' });
});
```

`getLocale()` returns the locale of the page that called the server function, and `undefined` if the request middleware did not run. Server function calls are never redirected by the middleware. When only the locale changes, loaders are re-run, and for a moment the previous strings show; format messages in components where possible.

## Middleware options and limits

- `createLocaleMiddleware(routing, { ignore, trustForwardedHost })`: `ignore(pathname)` skips requests (default skips `/api` and paths with a file extension); `trustForwardedHost` reads `x-forwarded-host` for `domains` behind a proxy that overwrites it.
- Locale resolution order: URL prefix, locale cookie (`NEXT_LOCALE` by default), `Accept-Language`, `defaultLocale` (`localeDetection: false` uses the prefix only). It redirects (307) to the canonical URL for the `localePrefix` mode and localized pathname, keeping the query.
- Static prerendering and SPA mode have no request middleware: prefixed URLs still resolve through the rewrite, but redirects, detection and the cookie need a server. The `{-$locale}` optional-param approach is intentionally not used.
- Reduce client bundles with configured `scopes` and a scope's `loadLocale`; `selectMessages` pruning is a Vite-plugin feature.

Full reference: https://github.com/nordbeam/locale/blob/main/docs/reference/tanstack-start.md (routing options are the same as https://github.com/nordbeam/locale/blob/main/docs/reference/next-routing.md).
