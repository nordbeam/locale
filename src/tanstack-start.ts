import * as React from 'react';
import { createElement, useCallback, useMemo } from 'react';
import type { AnchorHTMLAttributes, ReactElement, ReactNode } from 'react';
import { createMiddleware, getGlobalStartContext } from '@tanstack/react-start';
import { useRouter, useRouterState } from '@tanstack/react-router';
import { createSuspenseI18n } from './react.js';
import type { LoadedLocale } from './index.js';
import {
  compileRouting,
  domainRouting,
  getPathname as corePathname,
  localePrefixConfig,
  matchLocalePrefix,
  toInternalPathAny,
  type NextRouting,
} from './next-routing.js';
import {
  alternateLinkHeader,
  cookieLocale,
  decideLocaleRequest,
  localeCookieAttributes,
  localeCookieName,
  localeHeader,
  normalizePathname,
  requestHost,
  resolveLocale,
  shouldSetLocaleCookie,
} from './locale-request.js';

export type { NextLocaleCookieOptions as TanStackStartLocaleCookieOptions, NextLocalePrefixMode as TanStackStartLocalePrefixMode, NextDomain as TanStackStartDomain } from './next-routing.js';
export { localeHeader as NORDBEAM_LOCALE_HEADER };

/**
 * The routing object shared by the request middleware and the router rewrite.
 * `pathnames` keys are TanStack Router route paths: `/blog/$slug` and the
 * splat `/docs/$` are supported. Optional params (`{-$slug}`) and params with
 * a prefix or suffix cannot be localized, and are rejected.
 */
export type TanStackStartRouting<Locale extends string = string, Pathnames = Readonly<Record<string, string | Partial<Record<Locale, string>>>>> =
  Omit<NextRouting<Locale, any>, 'pathnames'> & { readonly pathnames?: Pathnames };

/** Typed state the rewrite keeps for one router. Put it in the router context with `routerOptions()`. */
export interface TanStackStartRouterState<Locale extends string = string> {
  /** The locale of the page the router last parsed or committed. Output rewrites build links in this locale. */
  locale: Locale;
  /** The host of that page, used to pick the domain rules. */
  host: string | undefined;
  /**
   * Set by `Provider`. The router caches the URL of a link built from fixed props, and
   * internal URLs do not change with the locale, so the cache is dropped when the locale does.
   */
  refreshLinks?: () => void;
  /** The locale the root `beforeLoad` last resolved. Loaders are reloaded when it changes. */
  committed?: Locale;
}

export interface TanStackStartRouterContext<Locale extends string = string> {
  readonly i18n: TanStackStartRouterState<Locale>;
}

const splat = '_splat';

/** One TanStack path segment in the Next pattern syntax of the shared routing core. */
function coreSegment(segment: string, path: string): string {
  const param = segment.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
  if (param) return `[${param[1]}]`;
  if (segment === '$') return `[...${splat}]`;
  if (/[${}]/.test(segment)) {
    throw new TypeError(`Nordbeam pathname '${path}' uses '${segment}', but only '$name' and '$' segments can be localized.`);
  }
  return segment;
}

function corePattern(path: string): string {
  if (typeof path !== 'string' || !path.startsWith('/')) return path;
  return path === '/' ? '/' : `/${path.slice(1).split('/').map(segment => coreSegment(segment, path)).join('/')}`;
}

const coreRoutings = new WeakMap<object, NextRouting<any, any>>();

/** The routing in the pattern syntax of the shared core, compiled once per routing object. */
function coreRouting<Locale extends string>(routing: TanStackStartRouting<Locale, any>): NextRouting<Locale, any> {
  let value = coreRoutings.get(routing);
  if (!value) {
    const pathnames = routing.pathnames && Object.fromEntries(Object.entries(routing.pathnames as Record<string, string | Record<string, string>>).map(([key, variants]) => [
      corePattern(key),
      typeof variants === 'string' ? corePattern(variants) : Object.fromEntries(Object.entries(variants).map(([locale, pattern]) => [locale, corePattern(pattern)])),
    ]));
    value = { ...routing, pathnames } as NextRouting<Locale, any>;
    compileRouting(value);
    coreRoutings.set(routing, value);
  }
  return value;
}

/** Identity helper that validates a routing object once and keeps its literal locales. Throws a TypeError for an invalid routing. */
export function defineRouting<const Locale extends string, const Pathnames extends Readonly<Record<string, string | Partial<Record<NoInfer<Locale>, string>>>> = {}>(
  routing: TanStackStartRouting<Locale, Pathnames>,
): TanStackStartRouting<Locale, Pathnames> {
  coreRouting(routing);
  return routing;
}

const rtlScripts = new Set(['Adlm', 'Arab', 'Hebr', 'Mand', 'Nkoo', 'Rohg', 'Samr', 'Syrc', 'Thaa']);

/** `rtl` for locales written right to left, `ltr` otherwise. Used for `<html dir>`. */
export function getLocaleDirection(locale: string): 'ltr' | 'rtl' {
  try { return rtlScripts.has(new Intl.Locale(locale).maximize().script ?? '') ? 'rtl' : 'ltr'; }
  catch { return 'ltr'; }
}

function safeDecodeURI(value: string): string {
  try { return decodeURI(value); }
  catch { return value; }
}

function documentLocale<Locale extends string>(routing: NextRouting<Locale, any>): Locale | undefined {
  const lang = (globalThis as unknown as { readonly document?: { readonly documentElement: { readonly lang: string } } }).document?.documentElement.lang;
  return lang && routing.locales.includes(lang as Locale) ? lang as Locale : undefined;
}

function documentCookie(): { get: () => string; set: (value: string) => void } | undefined {
  const target = (globalThis as unknown as { document?: { cookie: string } }).document;
  return target ? { get: () => target.cookie, set: value => { target.cookie = value; } } : undefined;
}

function readCookie(header: string | null | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) {
      const value = part.slice(index + 1).trim();
      try { return decodeURIComponent(value); }
      catch { return value; }
    }
  }
  return undefined;
}

function serializeCookie(name: string, value: string, attributes: { readonly path?: string; readonly sameSite?: string; readonly maxAge?: number; readonly secure?: boolean; readonly httpOnly?: boolean }): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${attributes.path ?? '/'}`,
    ...(attributes.maxAge === undefined ? [] : [`Max-Age=${attributes.maxAge}`]),
    ...(attributes.sameSite ? [`SameSite=${attributes.sameSite[0]!.toUpperCase()}${attributes.sameSite.slice(1)}`] : []),
    ...(attributes.secure ? ['Secure'] : []),
    ...(attributes.httpOnly ? ['HttpOnly'] : []),
  ].join('; ');
}

export interface TanStackStartMiddlewareOptions {
  /**
   * Read the request host from `x-forwarded-host` before `host`. Enable it only
   * behind a proxy that sets the header, because any client can send it otherwise.
   */
  readonly trustForwardedHost?: boolean;
  /**
   * Requests this middleware leaves alone. The default skips `/api` and any
   * path whose last segment has a file extension, such as `/favicon.ico`.
   */
  readonly ignore?: (pathname: string) => boolean;
}

const defaultIgnore = (pathname: string): boolean => /^\/api(\/|$)/.test(pathname) || /\.[^/]+$/.test(pathname);

type RequestLocaleContext = { readonly locale: string | undefined; readonly domain: string | undefined };

/** The request context shape, widened so every branch of the middleware returns the same type. */
const locals = (locale: string | undefined, domain: string | undefined): RequestLocaleContext => ({ locale, domain });

/**
 * The locale a server function call was made in. The browser sends it in the
 * `x-nordbeam-locale` header (see `createLocaleFunctionMiddleware`); without
 * it, the page the call came from (`Referer`), the cookie, and Accept-Language
 * decide, in that order.
 */
function serverFnLocale<Locale extends string>(request: Request, routing: NextRouting<Locale, any>, options: TanStackStartMiddlewareOptions): { locale: Locale; domain: string | undefined } {
  const host = requestHost(request.headers, options.trustForwardedHost === true);
  const scope = domainRouting(routing, host) ?? routing;
  const sent = request.headers.get(localeHeader);
  if (sent && scope.locales.includes(sent as Locale)) return { locale: sent as Locale, domain: scope === routing ? undefined : host };
  const domain = scope === routing ? undefined : host;
  let pathname: string | undefined;
  const referer = request.headers.get('referer');
  if (referer) { try { pathname = normalizePathname(safeDecodeURI(new URL(referer).pathname)); } catch { /* an unparsable Referer carries no locale */ } }
  const prefixed = pathname === undefined ? undefined : matchLocalePrefix(pathname, scope, true);
  if (prefixed) return { locale: prefixed.locale, domain };
  // With `as-needed`, the middleware sends every other locale to a prefixed URL, so an unprefixed page is in the default locale.
  if (pathname !== undefined && localePrefixConfig(scope).mode === 'as-needed') return { locale: scope.defaultLocale, domain };
  const locale = resolveLocale({ pathname: '/', cookie: readCookie(request.headers.get('cookie'), localeCookieName(routing)), acceptLanguage: request.headers.get('accept-language') }, scope);
  return { locale, domain };
}

/**
 * Global request middleware: detects the locale (URL prefix, locale cookie,
 * Accept-Language, default locale), redirects to the canonical URL for the
 * `localePrefix` mode and the localized `pathnames`, keeps the locale cookie,
 * adds `hreflang` alternates as a `Link` header, and puts `locale` and
 * `domain` in the request context for server functions and `getLocale()`.
 *
 * Register it once in `src/start.ts`:
 * `createStart(() => ({ requestMiddleware: [createLocaleMiddleware(routing)] }))`.
 */
export function createLocaleMiddleware<const Locale extends string>(routing: TanStackStartRouting<Locale, any>, options: TanStackStartMiddlewareOptions = {}) {
  const core = coreRouting(routing);
  const cookie = localeCookieAttributes(core);
  const ignore = options.ignore ?? defaultIgnore;
  return createMiddleware({ type: 'request' }).server(async ({ request, pathname, next, handlerType }) => {
    if (handlerType === 'serverFn') {
      const { locale, domain } = serverFnLocale(request, core, options);
      return next({ context: locals(locale, domain) });
    }
    if (ignore(pathname)) return next({ context: locals(undefined, undefined) });
    const url = new URL(request.url);
    const acceptLanguage = request.headers.get('accept-language');
    const existing = readCookie(request.headers.get('cookie'), cookie?.name ?? localeCookieName(core));
    const decision = decideLocaleRequest({
      pathname: url.pathname,
      search: url.search,
      host: requestHost(request.headers, options.trustForwardedHost === true),
      cookie: existing,
      acceptLanguage,
    }, core, url.protocol);
    const { locale, domain, scope, internal } = decision;
    if (locale === '') return next({ context: locals(undefined, domain) });
    const headers = new Headers();
    // A locale that belongs to another host leaves at once: no cookie, no alternates.
    if (decision.redirect?.origin) {
      headers.set('location', new URL(decision.redirect.path, decision.redirect.origin).toString());
      return new Response(null, { status: 307, headers });
    }
    if (cookie && shouldSetLocaleCookie({ existing, locale, acceptLanguage, destination: request.headers.get('sec-fetch-dest') }, scope)) {
      headers.append('set-cookie', serializeCookie(cookie.name, locale, { path: '/', ...(url.protocol === 'https:' ? { secure: true } : {}), ...cookie }));
    }
    const links = alternateLinkHeader({ domain, internal, search: url.search, url: request.url, protocol: url.protocol }, core);
    if (links) headers.set('link', links);
    if (decision.redirect) {
      headers.set('location', new URL(decision.redirect.path, request.url).toString());
      return new Response(null, { status: 307, headers });
    }
    const { response } = await next({ context: locals(locale, domain) });
    const merged = new Headers(response.headers);
    for (const [name, value] of headers) {
      if (name === 'set-cookie') merged.append(name, value);
      else merged.set(name, value);
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: merged });
  });
}

let browserLocale: string | undefined;

/**
 * Global function middleware: sends the locale of the page with every server
 * function call, so the call formats messages in the locale the user sees even
 * when the call URL carries no locale. Register it in `src/start.ts`:
 * `createStart(() => ({ functionMiddleware: [createLocaleFunctionMiddleware()] }))`.
 */
export function createLocaleFunctionMiddleware() {
  return createMiddleware({ type: 'function' }).client(({ next }) => next(browserLocale ? { headers: { [localeHeader]: browserLocale } } : {}));
}

/**
 * The locale of the current request on the server, or of the page in the
 * browser. On the server it needs the request middleware, which puts the
 * locale in the request context. Call it in server functions and server
 * routes; loaders and `beforeLoad` receive the locale as `context.locale`.
 * Outside a request, such as in a queue consumer, it returns `undefined`.
 */
export function getLocale(): string | undefined {
  let context: { readonly locale?: unknown } | undefined;
  // On the server, Start throws when no request is running or its global middleware has not run yet.
  try { context = getGlobalStartContext() as { readonly locale?: unknown } | undefined; }
  catch { return undefined; }
  if (context === undefined) return browserLocale;
  return typeof context.locale === 'string' ? context.locale : undefined;
}

export interface TanStackStartGetPathnameOptions<Locale extends string> {
  /** A route path such as `/about` or `/blog/$slug`. */
  readonly to: string;
  readonly params?: Readonly<Record<string, string | undefined>>;
  readonly search?: Readonly<Record<string, string | number | boolean | null | undefined | readonly (string | number | boolean | null | undefined)[]>> | string;
  readonly hash?: string;
  readonly locale: Locale;
  /** The host to resolve against when `routing.domains` is set. */
  readonly domain?: string | null;
}

export interface TanStackStartI18nOptions<Locale extends string, Messages> {
  readonly routing: TanStackStartRouting<Locale, any>;
  /** The generated `loadLocale`, or a `selectMessages(...)` loader for the messages the app reads. */
  readonly loadLocale: (locale: Locale) => Promise<LoadedLocale<Locale, Messages>>;
}

/**
 * The options the root `beforeLoad` reads. `matches` is read but not declared: TanStack
 * types it as a union over every route of the registered router, so declaring it makes
 * TypeScript resolve the router while it is still inferring the root route. When a typed
 * `Link` is checked before the root route, that reports `Route` and `getRouter` as
 * circular (TS7022, TS7023).
 */
interface RootBeforeLoadOptions {
  readonly location: { readonly publicHref: string };
  readonly context: unknown;
  readonly preload?: boolean;
  /** The request middleware context. Start passes it as an option while server rendering. */
  readonly serverContext?: { readonly locale?: unknown };
}

type RootBeforeLoadMatches = readonly { invalid?: boolean; readonly routeId?: unknown }[];

/**
 * Locale handling for a TanStack Start application, built on the router
 * `rewrite`: pages keep one unprefixed route tree, the URL carries the locale
 * prefix and localized pathnames, and every `Link` and `navigate` call builds
 * the public URL for the current locale on its own.
 *
 * Messages load in the root `beforeLoad`, so the server renders translated
 * HTML, a locale switch loads its catalog before the URL changes, and the
 * browser hydrates the locale the server rendered.
 */
export function createTanStackStartI18n<const Locale extends string, Messages>(options: TanStackStartI18nOptions<Locale, Messages>) {
  const routing = options.routing;
  const core = coreRouting(routing);
  const config = localePrefixConfig(core);
  const react = createSuspenseI18n<Locale, Messages>(options.loadLocale);
  const cookie = localeCookieAttributes(core);

  function scopeFor(host: string | undefined | null): NextRouting<Locale, any> {
    return domainRouting(core, host) ?? core;
  }

  /** Records the locale of the page, and drops the router's cached link URLs when it changed. */
  function adopt(state: TanStackStartRouterState<Locale>, locale: Locale): void {
    if (state.locale === locale) return;
    state.locale = locale;
    state.refreshLinks?.();
  }

  function createRouterState(): TanStackStartRouterState<Locale> {
    const initial = documentLocale(core);
    return { locale: initial ?? core.defaultLocale, ...(initial ? { committed: initial } : {}), host: (globalThis as unknown as { location?: { host: string } }).location?.host };
  }

  /** A fresh rewrite for one router. It records the locale of each URL it parses, so links built later use it. */
  function createRewrite(state: TanStackStartRouterState<Locale>) {
    return {
      input: ({ url }: { url: URL }): URL => {
        const scope = scopeFor(url.host);
        const normalized = normalizePathname(url.pathname);
        const matched = matchLocalePrefix(safeDecodeURI(normalized), scope, true);
        const locale = matched?.locale
          ?? (config.mode !== 'as-needed' && scope.locales.includes(state.locale) ? state.locale : scope.defaultLocale);
        const prefixLength = matched ? matched.prefix.split('/').filter(Boolean).length : 0;
        const unprefixed = `/${normalized.split('/').filter(Boolean).slice(prefixLength).join('/')}`;
        url.pathname = toInternalPathAny(unprefixed, scope, locale) ?? unprefixed;
        adopt(state, locale);
        state.host = url.host;
        return url;
      },
      output: ({ url }: { url: URL }): URL => {
        const href = corePathname({ href: `${url.pathname}${url.search}${url.hash}`, locale: state.locale, domain: state.host }, core);
        return new URL(href, url.origin);
      },
    };
  }

  /**
   * The router's `hydrate` hook. TanStack awaits it before React hydrates, so the catalog
   * of the server-rendered page is in when hydration reaches the `Provider`. Were the
   * catalog still loading, the `Provider` would suspend, and the router's first update
   * would make React replace the server HTML with the empty fallback until it arrived.
   * A failed load is left to the `Provider`, which throws it to the error boundary.
   */
  async function hydrate(): Promise<void> {
    const locale = documentLocale(core);
    if (locale) await react.preload(locale).then(() => undefined, () => undefined);
  }

  /**
   * Options for `createRouter`: the rewrite, the router context that holds its
   * state, and the `hydrate` hook. Spread them in `getRouter()`, and merge your
   * own context: `createRouter({ routeTree, ...i18n.routerOptions() })`.
   */
  function routerOptions() {
    const state = createRouterState();
    // Start the browser's catalog request before hydration reaches the provider.
    if (documentLocale(core)) void react.preload(state.locale).catch(() => undefined);
    return { rewrite: createRewrite(state), context: { i18n: state } satisfies TanStackStartRouterContext<Locale>, hydrate };
  }

  function stateOf(context: unknown): TanStackStartRouterState<Locale> | undefined {
    return (context as { readonly i18n?: TanStackStartRouterState<Locale> } | undefined)?.i18n;
  }

  /**
   * The locale of a URL, without the framework. The prefix wins, then the
   * locale the server middleware detected (cookie, Accept-Language), then
   * the page the router is on, then the default locale.
   */
  function localeOf(publicHref: string, serverLocale: unknown, state: TanStackStartRouterState<Locale> | undefined): Locale {
    const scope = scopeFor(state?.host);
    const path = normalizePathname(safeDecodeURI(publicHref.split(/[?#]/)[0] || '/'));
    const matched = matchLocalePrefix(path, scope, true);
    if (matched) return matched.locale;
    if (config.mode === 'as-needed') return scope.defaultLocale;
    const detected = cookieLocale(typeof serverLocale === 'string' ? serverLocale : undefined, scope);
    if (detected) return detected;
    return state && scope.locales.includes(state.locale) ? state.locale : scope.defaultLocale;
  }

  /**
   * The root route's `beforeLoad`. It resolves the locale of the URL, loads its
   * messages, and returns `{ locale }` as route context for every route.
   * Navigation waits for the catalog, so a locale switch never shows a flash.
   */
  async function beforeLoad(options: RootBeforeLoadOptions): Promise<{ locale: Locale }> {
    const { location, context, preload, serverContext } = options;
    const matches = (options as { readonly matches?: RootBeforeLoadMatches }).matches ?? [];
    const state = stateOf(context);
    const locale = localeOf(location.publicHref, serverContext?.locale, state);
    if (state && !preload) {
      // Loaders can format messages, and a locale change does not change the internal URL, so
      // the router would keep their data. Marking the matches invalid reloads them in the new locale.
      if (state.committed !== undefined && state.committed !== locale) {
        for (const match of matches) if (match.routeId !== '__root__') match.invalid = true;
      }
      state.committed = locale;
      adopt(state, locale);
    }
    if (!preload && (globalThis as unknown as { document?: unknown }).document) browserLocale = locale;
    await react.preload(locale);
    return { locale };
  }

  /** The locale of the page being shown, from the root route's context. Falls back to the default locale when the root route failed to load. */
  function useCurrentLocale(): Locale {
    return useRouterState({ select: state => (state.matches[0]?.context as { locale?: Locale } | undefined)?.locale ?? core.defaultLocale }) as Locale;
  }

  /** The `lang` and `dir` attributes for `<html>`, for the root `shellComponent`. */
  function useHtmlAttributes(): { readonly lang: Locale; readonly dir: 'ltr' | 'rtl' } {
    const lang = useCurrentLocale();
    return { lang, dir: getLocaleDirection(lang) };
  }

  /** Provides the messages of the page's locale. Render it once, in the root route's component. */
  function Provider({ children }: { children?: ReactNode }): ReactElement {
    const locale = useCurrentLocale();
    const router = useRouter();
    const state = stateOf(router.options.context);
    if (state) state.refreshLinks = () => router.update(router.options);
    // The `hydrate` hook and the root `beforeLoad` load the catalog before anything renders
    // it, so this boundary only catches a catalog that was invalidated or never requested.
    return createElement(React.Suspense, { fallback: null }, createElement(react.Provider, { locale }, children));
  }

  /** The full external href for a route in `locale`: prefix, localized path, query and hash. Use it for `hreflang` links and sitemaps. */
  function getPathname({ to, params, search, hash, locale, domain }: TanStackStartGetPathnameOptions<Locale>): string {
    const pattern = corePattern(to);
    const filled = params && Object.fromEntries(Object.entries(params).map(([key, value]) => [key, key === splat && typeof value === 'string' ? value.split('/') : value]));
    return corePathname({ href: { pathname: pattern, params: filled, query: search, hash }, locale, domain }, core);
  }

  /** The public URL of the current page in `locale`, resolved against the current host. */
  function currentPageHref(router: ReturnType<typeof useRouter>, locale: Locale): string {
    return corePathname({ href: router.state.location.href, locale, domain: stateOf(router.options.context)?.host }, core);
  }

  function useLocaleSwitcher() {
    const router = useRouter();
    return useCallback(async (locale: Locale): Promise<void> => {
      if (!core.locales.includes(locale)) throw new RangeError(`Unsupported locale: ${locale}`);
      // Load first, so the page changes language in one commit.
      await react.preload(locale);
      const attributes = cookie && !cookie.httpOnly ? documentCookie() : undefined;
      attributes?.set(serializeCookie(cookie!.name, locale, { path: '/', maxAge: cookie!.maxAge, sameSite: cookie!.sameSite, ...(cookie!.secure === undefined ? {} : { secure: cookie!.secure }) }));
      const state = stateOf(router.options.context);
      if (state) adopt(state, locale);
      const target = currentPageHref(router, locale);
      // A locale on another domain leaves the application.
      if (/^[a-z][a-z\d+.-]*:/i.test(target)) (globalThis as unknown as { location: { assign(url: string): void } }).location.assign(target);
      // Without a locale in the URL (`never`), the URL stays and the page reloads its data in the new locale.
      else if (target === router.state.location.publicHref) await router.invalidate();
      // `router.navigate` compares internal URLs, which are the same in every locale, and would skip the push.
      else router.history.push(target);
    }, [router]);
  }

  /** The `setLocale(locale)` function of the current router. It loads the catalog, keeps the cookie, and navigates to the page in the new locale. */
  function useSetLocale(): (locale: Locale) => Promise<void> {
    return useLocaleSwitcher();
  }

  /**
   * A link to the current page in another locale, for language switchers. It
   * renders a real anchor, so crawlers and middle-click work, and a plain
   * click switches without a reload.
   */
  function LocaleLink({ locale, onClick, children, ...anchor }: { locale: Locale } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>): ReactElement {
    const router = useRouter();
    const switchLocale = useLocaleSwitcher();
    // Subscribes the link to navigation, so its href follows the page.
    const location = useRouterState({ select: state => state.location });
    const state = stateOf(router.options.context);
    const href = useMemo(() => corePathname({ href: location.href, locale, domain: state?.host }, core), [location.href, locale, state?.host]);
    return createElement('a', {
      ...anchor,
      href,
      hrefLang: locale,
      onClick: (event: React.MouseEvent<HTMLAnchorElement>) => {
        onClick?.(event);
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        void switchLocale(locale);
      },
    }, children);
  }

  return {
    routing,
    locales: core.locales,
    defaultLocale: core.defaultLocale,
    routerOptions,
    beforeLoad,
    Provider,
    LocaleLink,
    getPathname,
    useHtmlAttributes,
    useLocale: react.useLocale,
    useMessages: react.useMessages,
    useI18n: react.useI18n,
    useSetLocale,
    /** Loads and caches the messages of `locale`. Use it in loaders and server functions: `(await i18n.load(locale)).messages`. */
    load: react.preload,
    isLoaded: react.isLoaded,
    invalidate: react.invalidate,
    loadLocale: options.loadLocale,
  } as const;
}
