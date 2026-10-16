'use client';
import React from 'react';
import NextLink from 'next/link.js';
import type { LinkProps as NextLinkProps } from 'next/link.js';
import { usePathname as useNextPathname } from 'next/navigation.js';
import { localePrefixConfig, localize, type NextRouting } from './next-routing.js';
import type { NextNavigationLinkProps } from './next-navigation.js';

function subscribe(): () => void {
  return () => {};
}

function currentHost(): string {
  return (globalThis as unknown as { readonly location: { readonly host: string } }).location.host;
}

function serverHost(): undefined {
  return undefined;
}

/** The page's host. It is undefined while server rendering and hydrating, so the first render matches the server, then it is the real host after mount. */
export function useCurrentHost(): string | undefined {
  return React.useSyncExternalStore<string | undefined>(subscribe, currentHost, serverHost);
}

const prefixedRoutings = new WeakMap<object, NextRouting<any, any>>();

/** The routing with every locale prefixed and no domains. It is the server-agreed form of a domain link, which any host can serve. */
function prefixedRouting<Locale extends string>(routing: NextRouting<Locale, any>): NextRouting<Locale, any> {
  let value = prefixedRoutings.get(routing);
  if (!value) {
    value = { ...routing, domains: undefined, localePrefix: { mode: 'always', prefixes: localePrefixConfig(routing).prefixes } };
    prefixedRoutings.set(routing, value);
  }
  return value;
}

/** The routing and domain that resolve an href: the current host when it is known, or the prefixed form until then. Routings without domains are unchanged. */
export function hrefScope<Locale extends string>(routing: NextRouting<Locale, any>, host: string | undefined): { readonly routing: NextRouting<Locale, any>; readonly domain?: string } {
  if (!routing.domains?.length) return { routing };
  return host === undefined ? { routing: prefixedRouting(routing) } : { routing, domain: host };
}

/** Client half of the navigation `Link`. The server-safe factory passes its
 * plain `routing` object here because only client components may read the
 * current pathname needed to keep the active locale. */
export function NextNavigationClientLink<Locale extends string>({ routing, ...props }: NextNavigationLinkProps<Locale, any> & { readonly routing: NextRouting<Locale, any> }) {
  const { locale, href, ...anchor } = props;
  const pathname = useNextPathname();
  const scope = hrefScope(routing, useCurrentHost());
  return React.createElement(NextLink as unknown as React.ComponentType<NextLinkProps>, { ...anchor, href: localize(href as never, locale, pathname, scope.routing, scope.domain) } as never);
}
