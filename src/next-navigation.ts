import React from 'react';
import type { LinkProps as NextLinkProps } from 'next/link.js';
import {
  permanentRedirect as nextPermanentRedirect,
  redirect as nextRedirect,
  usePathname as useNextPathname,
  useRouter as useNextRouter,
} from 'next/navigation.js';
import { hrefScope, NextNavigationClientLink, useCurrentHost } from './next-navigation-client.js';
import {
  compileRouting,
  getPathname,
  isRouteHref,
  localize,
  stripLocalePrefix,
  toInternalPathAny,
  type NextPathnameHref,
  type NextPathnamesInput,
  type NextRouting,
  type NextRoutingHref,
} from './next-routing.js';

export type { NextLocaleCookieOptions, NextLocalePrefixMode, NextPathParams, NextPathnameHref, NextPathnamesInput, NextQuery, PathParams } from './next-routing.js';

export type NextNavigationRouting<Locale extends string = string, Pathnames extends NextPathnamesInput<Locale> = NextPathnamesInput<Locale>> = NextRouting<Locale, Pathnames>;

type NextLinkHref = NextLinkProps['href'];
/** Without typed pathnames every Next href is accepted. With them, plain strings and the pattern object form are typed. */
export type NextNavigationHref<Pathnames = NextPathnamesInput> = string extends keyof Pathnames
  ? NextLinkHref
  : string | URL | NextPathnameHref<Pathnames>;
type NextLinkAnchorProps = Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, keyof NextLinkProps>;
export type NextNavigationLinkProps<Locale extends string = string, Pathnames extends NextPathnamesInput<Locale> = NextPathnamesInput<Locale>> = Omit<NextLinkProps, 'href' | 'locale'> & NextLinkAnchorProps & React.RefAttributes<HTMLAnchorElement> & { href: NextNavigationHref<Pathnames>; locale?: Locale | false };
export interface NextNavigationOptions<Locale extends string = string> {
  readonly locale?: Locale | false;
  readonly scroll?: boolean;
}
export type NextNavigationRedirectLocale<Locale extends string = string> = Locale | false | { readonly locale: Locale | false };

function pathnameOf(href: NextRoutingHref): string {
  if (typeof href === 'string') return href.match(/^[^?#]*/)![0];
  if (href instanceof URL) return href.pathname;
  return href.pathname ?? '';
}

/** Create the locale-aware navigation primitives used by Next App Router.
 * The returned Link and hooks mirror next-intl's navigation surface while
 * keeping the routing policy in one typed object. Hrefs are internal paths:
 * with `pathnames`, they are localized for the target locale on the way out. */
export function createNextNavigation<const Locale extends string, const Pathnames extends NextPathnamesInput<Locale> = NextPathnamesInput<Locale>>(routing: NextNavigationRouting<Locale, Pathnames>) {
  compileRouting(routing);
  // No hooks here: this also runs in Server Components. The client component
  // reads the pathname and performs the locale-aware href resolution.
  function Link(props: NextNavigationLinkProps<Locale, Pathnames>) {
    return React.createElement(NextNavigationClientLink, { ...props, routing } as NextNavigationLinkProps<Locale> & { routing: NextRouting<Locale> });
  }
  /** The internal concrete path: the locale prefix and any localized segments are mapped back. */
  function usePathname(): string {
    const pathname = useNextPathname();
    const stripped = stripLocalePrefix(pathname ?? '/', routing);
    return toInternalPathAny(stripped.path, routing, stripped.locale) ?? stripped.path;
  }
  function useRouter() {
    const router = useNextRouter();
    const pathname = useNextPathname();
    const scope = hrefScope(routing, useCurrentHost());
    const resolve = (href: NextNavigationHref<Pathnames>, locale: Locale | false | undefined) => localize(href as NextRoutingHref, locale, pathname, scope.routing, scope.domain) as never;
    return {
      ...router,
      push: (href: NextNavigationHref<Pathnames>, options?: NextNavigationOptions<Locale>) => router.push(resolve(href, options?.locale), { scroll: options?.scroll }),
      replace: (href: NextNavigationHref<Pathnames>, options?: NextNavigationOptions<Locale>) => router.replace(resolve(href, options?.locale), { scroll: options?.scroll }),
      prefetch: (href: NextNavigationHref<Pathnames>, options?: NextNavigationOptions<Locale>) => router.prefetch(resolve(href, options?.locale)),
    };
  }
  /**
   * The full external href for an internal href in `locale`, e.g. for `<a href>`, sitemaps or `hreflang`.
   * With `domain`, a locale that another host serves gets that host's absolute URL.
   */
  function getPathnameFor({ href, locale, domain }: { readonly href: NextNavigationHref<Pathnames>; readonly locale: Locale; readonly domain?: string }): string {
    const localized = localize(href as NextRoutingHref, locale, null, routing, domain);
    return typeof localized === 'string' ? localized : getPathname({ href: localized, locale, domain }, routing);
  }
  function checkedLocale(href: NextNavigationHref<Pathnames>, options: NextNavigationRedirectLocale<Locale>): Locale | false | undefined {
    const locale = typeof options === 'object' ? options.locale : options;
    // Without a Next request there is no current locale to fall back on, so a
    // route that is not already locale-prefixed must name its locale.
    if (locale === undefined && isRouteHref(href as NextRoutingHref) && !stripLocalePrefix(pathnameOf(href as NextRoutingHref), routing).locale) {
      throw new TypeError(`Nordbeam redirect('${pathnameOf(href as NextRoutingHref)}') needs a locale: pass it as the second argument, or use a path that already starts with a locale.`);
    }
    return locale;
  }
  function redirect(href: NextNavigationHref<Pathnames>, options: NextNavigationRedirectLocale<Locale>): never {
    return nextRedirect(localize(href as NextRoutingHref, checkedLocale(href, options), null, routing) as never);
  }
  function permanentRedirect(href: NextNavigationHref<Pathnames>, options: NextNavigationRedirectLocale<Locale>): never {
    return nextPermanentRedirect(localize(href as NextRoutingHref, checkedLocale(href, options), null, routing) as never);
  }
  return { Link, useRouter, usePathname, redirect, permanentRedirect, getPathname: getPathnameFor } as const;
}

/** Alias matching next-intl's factory name for straightforward migrations. */
export const createNavigation = createNextNavigation;
export default createNextNavigation;
