/**
 * Framework-agnostic request routing shared by the Next.js middleware and the
 * TanStack Start request middleware. Pure and Edge-safe: it reads only the
 * values the caller extracted from the request, and it returns a decision that
 * each framework turns into its own response type.
 */
import {
  compileRouting,
  domainRouting,
  joinPath,
  localePrefixConfig,
  matchLocalePrefix,
  originOf,
  prefixOf,
  servingDomain,
  toExternalPath,
  toInternalPathAny,
  type NextRouting,
} from './next-routing.js';

export const localeHeader = 'x-nordbeam-locale';
export const domainHeader = 'x-nordbeam-domain';
export const defaultLocaleCookie = 'NEXT_LOCALE';
export const defaultLocaleCookieMaxAge = 31536000;

export function normalizePathname(pathname: string): string {
  const value = pathname.replace(/\\/g, '%5C').replace(/[\t\n\r]/g, '').replace(/\/+/g, '/');
  if (value.length > 1 && value.endsWith('/')) return value.slice(0, -1);
  return value || '/';
}

/** Accept-Language ranges in preference order. Malformed or out-of-range q-values and q=0 are dropped. */
function acceptedLanguageRanges(header: string | null | undefined): string[] {
  return (header ?? '').split(',').flatMap((part, index) => {
    const [range = '', ...parameters] = part.split(';').map(item => item.trim());
    const weight = parameters.find(parameter => /^q=/i.test(parameter));
    const quality = weight === undefined ? 1 : /^q=(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/i.test(weight) ? Number(weight.slice(2)) : 0;
    return range && quality > 0 ? [{ range: range.toLowerCase(), quality, index }] : [];
  }).sort((left, right) => right.quality - left.quality || left.index - right.index).map(({ range }) => range);
}

/** Maximized language, script and region (`zh-HK` becomes `zh-Hant-HK`); undefined for malformed tags. */
function likelyTag(tag: string): Intl.Locale | undefined {
  try { return new Intl.Locale(tag).maximize(); }
  catch { return undefined; }
}

function negotiate<Locale extends string>(range: string, routing: NextRouting<Locale, any>): Locale | undefined {
  const exact = routing.locales.find(locale => locale.toLowerCase() === range);
  if (exact) return exact;
  const wanted = likelyTag(range);
  if (!wanted) return undefined;
  const candidates = routing.locales.flatMap(locale => {
    const tag = likelyTag(locale);
    return tag ? [{ locale, tag }] : [];
  });
  const find = (test: (tag: Intl.Locale) => boolean) => candidates.find(({ tag }) => test(tag))?.locale;
  return find(tag => tag.language === wanted.language && tag.script === wanted.script && tag.region === wanted.region)
    ?? find(tag => tag.language === wanted.language && tag.script === wanted.script)
    ?? find(tag => tag.language === wanted.language);
}

/** The best routing locale for an Accept-Language header, or undefined when none matches. `*` accepts the default locale. */
export function acceptLanguageLocale<Locale extends string>(header: string | null | undefined, routing: NextRouting<Locale, any>): Locale | undefined {
  for (const range of acceptedLanguageRanges(header)) {
    if (range === '*') return routing.defaultLocale;
    const locale = negotiate(range, routing);
    if (locale) return locale;
  }
  return undefined;
}

/** The locale cookie name: the configured one, or `NEXT_LOCALE`. */
export function localeCookieName(routing: NextRouting<any, any>): string {
  return typeof routing.localeCookie === 'object' && routing.localeCookie.name ? routing.localeCookie.name : defaultLocaleCookie;
}

/** The cookie attributes the middleware writes, or undefined when `localeCookie` is false. `name` is always set. */
export function localeCookieAttributes(routing: NextRouting<any, any>) {
  if (routing.localeCookie === false) return undefined;
  return {
    name: localeCookieName(routing),
    sameSite: 'lax' as const,
    maxAge: defaultLocaleCookieMaxAge,
    ...(typeof routing.localeCookie === 'object' ? routing.localeCookie : {}),
  };
}

/** A cookie value only counts when it names a routing locale. */
export function cookieLocale<Locale extends string>(value: string | undefined, routing: NextRouting<Locale, any>): Locale | undefined {
  return value && routing.locales.includes(value as Locale) ? value as Locale : undefined;
}

/** Prefix, then cookie, then Accept-Language, then the default locale. With `localeDetection: false`, only the prefix counts. */
export function resolveLocale<Locale extends string>(
  input: { readonly pathname: string; readonly cookie?: string | undefined; readonly acceptLanguage?: string | null | undefined },
  routing: NextRouting<Locale, any>,
): Locale {
  const matched = matchLocalePrefix(input.pathname, routing, true);
  if (matched) return matched.locale;
  if (routing.localeDetection !== false) {
    const cookie = cookieLocale(input.cookie, routing);
    if (cookie) return cookie;
    const accepted = acceptLanguageLocale(input.acceptLanguage, routing);
    if (accepted) return accepted;
  }
  return routing.defaultLocale;
}

/** The lowercase request host. Only the first `x-forwarded-host` entry is used, and only when trusted. */
export function requestHost(headers: { get(name: string): string | null }, trustForwardedHost: boolean): string | undefined {
  const forwarded = trustForwardedHost ? headers.get('x-forwarded-host') : null;
  return (forwarded || headers.get('host') || '').split(',')[0]!.trim().toLowerCase() || undefined;
}

export interface LocaleRequest {
  /** The raw, percent-encoded request pathname. */
  readonly pathname: string;
  /** The request query including `?`, or ''. */
  readonly search: string;
  readonly host: string | undefined;
  readonly cookie: string | undefined;
  readonly acceptLanguage: string | null | undefined;
}

/** A redirect target: the path with its query, resolved against `origin` when set and against the request URL otherwise. */
export interface LocaleRedirect {
  readonly path: string;
  readonly origin?: string;
}

export interface LocaleDecision<Locale extends string> {
  /** Empty when the path could not be decoded and the request passes through. */
  readonly locale: Locale | '';
  /** The configured host the request arrived on. */
  readonly domain: string | undefined;
  /** The routing the request is served with: the domain's view, or the routing itself. */
  readonly scope: NextRouting<Locale, any>;
  /** The unprefixed internal path of the page, without the query. */
  readonly internal: string;
  /** Set when the request must move to its canonical URL. */
  readonly redirect?: LocaleRedirect;
}

/**
 * Decides what a request for `pathname` means: its locale, its internal path,
 * and the canonical redirect when the URL is not the one the prefix mode and
 * the localized pathnames call for. The decision is the same for every
 * framework, so the Next.js proxy and the TanStack Start middleware agree.
 */
export function decideLocaleRequest<Locale extends string>(request: LocaleRequest, routing: NextRouting<Locale, any>, protocol: string): LocaleDecision<Locale> {
  const config = localePrefixConfig(routing);
  // Only a configured host is a domain. Any other host, including a spoofed one, uses the routing itself.
  const scoped = domainRouting(routing, request.host);
  const domain = scoped ? request.host : undefined;
  const scope: NextRouting<Locale, any> = scoped ?? routing;
  // Matching uses the decoded path. Redirect targets use the raw path so an
  // encoded character such as %25 is never decoded a second time.
  let pathname: string;
  try { pathname = normalizePathname(decodeURI(request.pathname)); }
  catch { return { locale: '', domain, scope, internal: request.pathname }; }
  const rawSegments = normalizePathname(request.pathname).split('/').filter(Boolean);
  const search = request.search;
  const named = matchLocalePrefix(pathname, routing, true);
  const namedHost = domain && named && !scope.locales.includes(named.locale) ? servingDomain(routing, named.locale) : undefined;
  if (named && namedHost) {
    // The locale belongs to another host: keep the page and the query, and move to that host's localized path.
    const prefixSegments = named.prefix.split('/').filter(Boolean);
    const unprefixed = `/${rawSegments.slice(prefixSegments.length).join('/')}`;
    const internal = toInternalPathAny(unprefixed, routing, named.locale) ?? unprefixed;
    const path = joinPath(prefixOf(domainRouting(routing, namedHost)!, named.locale), toExternalPath(internal, named.locale, routing));
    return { locale: named.locale, domain, scope, internal, redirect: { path: `${path}${search}`, origin: `${protocol}//${namedHost}` } };
  }
  const locale = resolveLocale({ pathname, cookie: request.cookie, acceptLanguage: request.acceptLanguage }, scope);
  const matched = matchLocalePrefix(pathname, scope, true);
  const defaultLocale = locale === scope.defaultLocale;
  const prefixSegments = matched ? matched.prefix.split('/').filter(Boolean) : [];
  const unprefixed = `/${rawSegments.slice(prefixSegments.length).join('/')}`;
  const canonicalPrefix = matched !== undefined && prefixSegments.every((segment, index) => rawSegments[index] === segment);
  const unprefixedRouting = config.mode === 'never' || (config.mode === 'as-needed' && defaultLocale);
  const hasPrefix = matched !== undefined;
  // Unlisted paths are their own internal route, so they keep today's behavior.
  const internal = toInternalPathAny(unprefixed, scope, locale) ?? unprefixed;
  const canonical = toExternalPath(internal, locale, scope);
  const to = (path: string): LocaleDecision<Locale> => ({ locale, domain, scope, internal, redirect: { path: `${path}${search}` } });
  if (hasPrefix && config.mode === 'never') return to(joinPath('', canonical));
  if (hasPrefix && config.mode === 'as-needed' && defaultLocale) return to(joinPath('', canonical));
  if (matched && !canonicalPrefix) return to(joinPath(prefixOf(scope, locale), canonical));
  if (!hasPrefix && !unprefixedRouting) return to(joinPath(prefixOf(scope, locale), canonical));
  if (canonical !== unprefixed) return to(joinPath(prefixOf(scope, locale), canonical));
  return { locale, domain, scope, internal };
}

/** Whether the locale cookie should be written: only for document requests, and only when it disagrees with the locale or an unset cookie would not be reproduced by Accept-Language. */
export function shouldSetLocaleCookie<Locale extends string>(
  input: { readonly existing: string | undefined; readonly locale: Locale; readonly acceptLanguage: string | null | undefined; readonly destination: string | null },
  scope: NextRouting<Locale, any>,
): boolean {
  const accepted = acceptLanguageLocale(input.acceptLanguage, scope);
  const destinationIsDocument = input.destination == null || input.destination === 'document';
  const { existing, locale } = input;
  return destinationIsDocument && Boolean((existing && existing !== locale) || (!existing && accepted !== locale));
}

/**
 * The `Link` header that lists every locale of the page as an alternate, or
 * undefined when `alternateLinks` is off, the prefix mode is `never`, or there
 * is nothing to list. On a domain, each locale is an absolute URL on the first
 * domain that serves it, and a locale no domain serves is left out.
 */
export function alternateLinkHeader<Locale extends string>(
  input: { readonly domain: string | undefined; readonly internal: string; readonly search: string; readonly url: string; readonly protocol: string },
  routing: NextRouting<Locale, any>,
): string | undefined {
  compileRouting(routing);
  if (routing.alternateLinks === false || localePrefixConfig(routing).mode === 'never' || routing.locales.length <= 1) return undefined;
  const { domain, internal, search } = input;
  // Each alternate names the same internal page in its own localized path.
  const alternate = (item: Locale): string | undefined => {
    const itemHost = domain ? servingDomain(routing, item) : undefined;
    if (domain && !itemHost) return undefined;
    const path = `${joinPath(prefixOf(itemHost ? domainRouting(routing, itemHost)! : routing, item), toExternalPath(internal, item, routing))}${search}`;
    return itemHost ? new URL(path, originOf(itemHost, input.protocol)).toString() : new URL(path, input.url).toString();
  };
  const links = routing.locales.flatMap(item => {
    const url = alternate(item);
    return url ? [`<${url}>; rel="alternate"; hreflang="${item}"`] : [];
  });
  const fallback = alternate(routing.defaultLocale);
  if (fallback) links.push(`<${fallback}>; rel="alternate"; hreflang="x-default"`);
  return links.length ? links.join(', ') : undefined;
}
