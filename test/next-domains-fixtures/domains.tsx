import { defineRouting } from '../../packages/locale/dist/next-routing.js';
import { createNextNavigation } from '../../packages/locale/dist/next-navigation.js';
import { createNextMiddleware } from '../../packages/locale/dist/next-middleware.js';

const routing = defineRouting({
  locales: ['en', 'de', 'fr'],
  defaultLocale: 'en',
  domains: [
    { domain: 'example.com', defaultLocale: 'en', locales: ['en', 'fr'] },
    { domain: 'example.de', defaultLocale: 'de' },
    { domain: 'localhost:3001', defaultLocale: 'fr', locales: ['fr'] },
  ],
});

const { Link, getPathname } = createNextNavigation(routing);

// A domain's locales and default locale are the routing locales.
export const cross: string = getPathname({ href: '/about', locale: 'de', domain: 'example.com' });
export const sameHost = <Link href="/about" locale="fr">Francais</Link>;
export const middleware = createNextMiddleware(routing, { trustForwardedHost: true });

// @ts-expect-error a domain's defaultLocale must be a routing locale
export const unknownDefault = defineRouting({ locales: ['en', 'de'], defaultLocale: 'en', domains: [{ domain: 'example.de', defaultLocale: 'nl' }] });

// @ts-expect-error a domain's locales must be routing locales
export const unknownLocales = defineRouting({ locales: ['en', 'de'], defaultLocale: 'en', domains: [{ domain: 'example.de', defaultLocale: 'de', locales: ['nl'] }] });

// @ts-expect-error a locale given to getPathname with a domain must be a routing locale
export const unknownLocale = getPathname({ href: '/about', locale: 'nl', domain: 'example.de' });
