import { createTanStackStartI18n, defineRouting } from '@nordbeam/locale/tanstack-start';
import { baseLocale, loadLocale, locales } from './i18n/scopes/route/index.js';

/** Locale routing shared by the request middleware and the router rewrite. */
export const routing = defineRouting({
  locales,
  defaultLocale: baseLocale,
  localePrefix: 'as-needed',
  pathnames: {
    '/about': { fr: '/a-propos', ar: '/حول' },
    '/blog/$slug': { fr: '/blogue/$slug' },
  },
});

export const i18n = createTanStackStartI18n({ routing, loadLocale });
