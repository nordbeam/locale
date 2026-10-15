import { headers } from 'next/headers.js';

const localeHeader = 'x-nordbeam-locale';
const domainHeader = 'x-nordbeam-domain';

/** The middleware only writes canonical tags, so anything else is not a locale. */
function isCanonicalLocale(value: string): boolean {
  try { return Intl.getCanonicalLocales(value)[0] === value; }
  catch { return false; }
}

/**
 * Read the domain selected by @nordbeam/locale/next/middleware: the configured
 * host the request arrived on, or undefined. With `routing`, only its domains
 * are accepted; without it, the value must look like a host.
 */
export async function getDomain(routing?: { readonly domains?: readonly { readonly domain: string }[] }): Promise<string | undefined> {
  const value = (await headers()).get(domainHeader)?.toLowerCase();
  if (!value) return undefined;
  if (routing) return routing.domains?.some(item => item.domain.toLowerCase() === value) ? value : undefined;
  return /^[a-z0-9.-]+(:\d+)?$/.test(value) ? value : undefined;
}

/**
 * Read the locale selected by @nordbeam/locale/next/middleware. The header is
 * client-controlled on routes outside the middleware matcher, so pass the
 * configured locales (or the routing object) there to accept only known values.
 */
export async function getLocale(routing?: { readonly locales: readonly string[] } | readonly string[]): Promise<string | undefined> {
  const value = (await headers()).get(localeHeader);
  if (value === null) return undefined;
  const locales = routing === undefined ? undefined : 'locales' in routing ? routing.locales : routing;
  if (locales) return locales.includes(value) ? value : undefined;
  return isCanonicalLocale(value) ? value : undefined;
}
