import { NextResponse, type NextRequest } from 'next/server.js';
import { compileRouting, type NextRouting } from './next-routing.js';
import {
  alternateLinkHeader,
  decideLocaleRequest,
  domainHeader,
  localeCookieAttributes,
  localeCookieName,
  localeHeader,
  normalizePathname,
  requestHost,
  shouldSetLocaleCookie,
} from './locale-request.js';

export type { NextLocaleCookieOptions, NextLocalePrefixMode } from './next-routing.js';

export type NextMiddlewareRouting<Locale extends string = string> = NextRouting<Locale>;

export interface NextMiddlewareOptions {
  /**
   * Read the request host from `x-forwarded-host` before `host`. Enable it only
   * behind a proxy that sets the header, because any client can send it otherwise.
   */
  readonly trustForwardedHost?: boolean;
}

/** Sets the locale and domain headers, overwriting any client-supplied value. An empty value means "none". */
function addLocaleHeader(request: NextRequest, locale: string, domain = ''): Headers {
  const headers = new Headers(request.headers);
  headers.set(localeHeader, locale);
  headers.set(domainHeader, domain);
  return headers;
}

/**
 * Creates a Next.js App Router middleware that preserves next-intl's locale
 * boundary semantics without shipping next-intl. It supports the three
 * locale-prefix modes, locale cookies, Accept-Language detection, internal
 * locale rewrites, default-locale canonical redirects, query strings, and
 * localized `pathnames`: a localized path is rewritten to its internal route,
 * and a request that names the page by another path is redirected to the
 * canonical localized path of the locale.
 *
 * With `domains`, a request on a configured host uses that host's locales and
 * default locale. A prefixed locale the host does not serve is redirected to
 * the host that does. Requests on other hosts use the routing itself.
 */
export function createNextMiddleware<const Locale extends string>(routing: NextMiddlewareRouting<Locale>, options: NextMiddlewareOptions = {}): (request: NextRequest) => NextResponse {
  compileRouting(routing);
  const cookie = localeCookieAttributes(routing);

  return request => {
    const decision = decideLocaleRequest({
      pathname: request.nextUrl.pathname,
      search: request.nextUrl.search,
      host: requestHost(request.headers, options.trustForwardedHost === true),
      cookie: request.cookies.get(cookie?.name ?? localeCookieName(routing))?.value,
      acceptLanguage: request.headers.get('accept-language'),
    }, routing, request.nextUrl.protocol);
    const { domain, scope, internal } = decision;
    const search = request.nextUrl.search;
    if (decision.locale === '') return NextResponse.next({ request: { headers: addLocaleHeader(request, '', domain) } });
    // A locale that belongs to another host leaves at once: no cookie, no alternates.
    if (decision.redirect?.origin) return NextResponse.redirect(new URL(decision.redirect.path, decision.redirect.origin));
    const { locale } = decision;
    const internalPath = `/${locale}${internal === '/' ? '' : internal}`;
    let response: NextResponse;
    if (decision.redirect) {
      response = NextResponse.redirect(new URL(decision.redirect.path, request.url));
    } else {
      const samePath = normalizePathname(request.nextUrl.pathname) === normalizePathname(internalPath);
      response = samePath
        ? NextResponse.next({ request: { headers: addLocaleHeader(request, locale, domain) } })
        : NextResponse.rewrite(new URL(`${internalPath}${search}`, request.url), { request: { headers: addLocaleHeader(request, locale, domain) } });
    }
    if (cookie) {
      const existing = request.cookies.get(cookie.name)?.value;
      if (shouldSetLocaleCookie({ existing, locale, acceptLanguage: request.headers.get('accept-language'), destination: request.headers.get('sec-fetch-dest') }, scope)) {
        const secure = request.nextUrl.protocol === 'https:';
        response.cookies.set(cookie.name, locale, { path: request.nextUrl.basePath || '/', ...(secure ? { secure } : {}), ...cookie });
      }
    }
    const links = alternateLinkHeader({ domain, internal, search, url: request.url, protocol: request.nextUrl.protocol }, routing);
    if (links) response.headers.set('Link', links);
    return response;
  };
}

export { localeHeader as NORDBEAM_LOCALE_HEADER };
