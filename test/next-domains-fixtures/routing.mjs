import { defineRouting } from '../../packages/locale/dist/next-routing.js';

export const pathnames = {
  '/about': { de: '/ueber-uns', fr: '/a-propos' },
  '/blog/[slug]': { de: '/artikel/[slug]' },
};

// example.com serves en and fr, example.de serves de, and the dev host serves fr.
// fr is on both example.com and the dev host, so example.com is its first domain.
export const domains = [
  { domain: 'Example.com', defaultLocale: 'en', locales: ['en', 'fr'] },
  { domain: 'example.de', defaultLocale: 'de', locales: ['de'] },
  { domain: 'localhost:3001', defaultLocale: 'fr', locales: ['fr'] },
];

export const domainRouting = (localePrefix = 'as-needed', extra = {}) => defineRouting({
  locales: ['en', 'de', 'fr'],
  defaultLocale: 'en',
  localePrefix,
  pathnames,
  domains,
  ...extra,
});
