import test from 'node:test';
import assert from 'node:assert/strict';
import { createTanStackStartI18n, defineRouting, getLocaleDirection } from '../packages/locale/dist/tanstack-start.js';

const loadLocale = async locale => ({ locale, messages: {} });

const build = routing => createTanStackStartI18n({ routing: defineRouting(routing), loadLocale });

const pathnames = {
  '/about': { de: '/ueber-uns', fr: '/a-propos' },
  '/blog/$slug': { de: '/artikel/$slug' },
  '/docs/$': { de: '/dokumente/$' },
  '/pricing': '/preise',
};

test('getPathname applies the prefix mode and the localized pathnames', () => {
  const asNeeded = build({ locales: ['en', 'de', 'fr'], defaultLocale: 'en', localePrefix: 'as-needed', pathnames });
  assert.equal(asNeeded.getPathname({ to: '/about', locale: 'en' }), '/about');
  assert.equal(asNeeded.getPathname({ to: '/about', locale: 'de' }), '/de/ueber-uns');
  assert.equal(asNeeded.getPathname({ to: '/about', locale: 'fr' }), '/fr/a-propos');
  assert.equal(asNeeded.getPathname({ to: '/', locale: 'en' }), '/');
  assert.equal(asNeeded.getPathname({ to: '/', locale: 'de' }), '/de');
  assert.equal(asNeeded.getPathname({ to: '/pricing', locale: 'fr' }), '/fr/preise');
  // A missing locale falls back to the internal pattern.
  assert.equal(asNeeded.getPathname({ to: '/blog/$slug', params: { slug: 'x' }, locale: 'fr' }), '/fr/blog/x');

  const always = build({ locales: ['en', 'de', 'fr'], defaultLocale: 'en', localePrefix: 'always', pathnames });
  assert.equal(always.getPathname({ to: '/about', locale: 'en' }), '/en/about');
  assert.equal(always.getPathname({ to: '/', locale: 'en' }), '/en');

  const never = build({ locales: ['en', 'de', 'fr'], defaultLocale: 'en', localePrefix: 'never', pathnames });
  assert.equal(never.getPathname({ to: '/about', locale: 'de' }), '/ueber-uns');
  assert.equal(never.getPathname({ to: '/', locale: 'de' }), '/');
});

test('getPathname fills params, splats, search and hash with one round of encoding', () => {
  const i18n = build({ locales: ['en', 'de', 'fr'], defaultLocale: 'en', localePrefix: 'as-needed', pathnames });
  assert.equal(i18n.getPathname({ to: '/blog/$slug', params: { slug: 'hello world' }, locale: 'de' }), '/de/artikel/hello%20world');
  assert.equal(i18n.getPathname({ to: '/blog/$slug', params: { slug: 'a/b' }, locale: 'de' }), '/de/artikel/a%2Fb');
  assert.equal(i18n.getPathname({ to: '/blog/$slug', params: { slug: '100%' }, locale: 'en' }), '/blog/100%25');
  assert.equal(i18n.getPathname({ to: '/docs/$', params: { _splat: 'a/b/c' }, locale: 'de' }), '/de/dokumente/a/b/c');
  assert.equal(i18n.getPathname({ to: '/about', search: { tab: 'one', n: 2 }, hash: 'top', locale: 'de' }), '/de/ueber-uns?tab=one&n=2#top');
  assert.equal(i18n.getPathname({ to: '/about', search: '?a=1', locale: 'en' }), '/about?a=1');
  assert.throws(() => i18n.getPathname({ to: '/blog/$slug', locale: 'de' }), /needs a non-empty string for param 'slug'/);
});

test('custom prefixes replace the locale segment', () => {
  const i18n = build({ locales: ['en', 'pt-BR'], defaultLocale: 'en', localePrefix: { mode: 'always', prefixes: { 'pt-BR': '/br' } } });
  assert.equal(i18n.getPathname({ to: '/x', locale: 'pt-BR' }), '/br/x');
  assert.equal(i18n.getPathname({ to: '/x', locale: 'en' }), '/en/x');
});

test('getPathname follows domains and leaves for the domain that serves the locale', () => {
  const i18n = build({
    locales: ['en', 'de', 'fr'],
    defaultLocale: 'en',
    localePrefix: 'as-needed',
    pathnames: { '/about': { de: '/ueber-uns', fr: '/a-propos' } },
    domains: [
      { domain: 'example.com', defaultLocale: 'en', locales: ['en', 'fr'] },
      { domain: 'example.de', defaultLocale: 'de', locales: ['de'] },
    ],
  });
  assert.equal(i18n.getPathname({ to: '/about', locale: 'de', domain: 'example.de' }), '/ueber-uns');
  assert.equal(i18n.getPathname({ to: '/about', locale: 'fr', domain: 'example.com' }), '/fr/a-propos');
  assert.equal(i18n.getPathname({ to: '/about', locale: 'de', domain: 'example.com' }), 'https://example.de/ueber-uns');
  assert.equal(i18n.getPathname({ to: '/about', locale: 'fr', domain: 'example.de' }), 'https://example.com/fr/a-propos');
});

test('defineRouting validates the routing and the TanStack path syntax', () => {
  const base = { locales: ['en', 'de'], defaultLocale: 'en' };
  assert.throws(() => defineRouting({ locales: [], defaultLocale: 'en' }), /non-empty locale list/);
  assert.throws(() => defineRouting({ locales: ['en'], defaultLocale: 'de' }), /containing defaultLocale/);
  assert.throws(() => defineRouting({ ...base, pathnames: { 'about': '/x' } }), /must start with '\//);
  assert.throws(() => defineRouting({ ...base, pathnames: { '/about': { fr: '/a-propos' } } }), /unknown locale 'fr'/);
  assert.throws(() => defineRouting({ ...base, pathnames: { '/blog/$slug': { de: '/artikel/$id' } } }), /must have the same params/);
  assert.throws(() => defineRouting({ ...base, pathnames: { '/blog/{-$slug}': { de: '/artikel/{-$slug}' } } }), /only '\$name' and '\$' segments can be localized/);
  assert.throws(() => defineRouting({ ...base, pathnames: { '/file{$name}.txt': '/datei{$name}.txt' } }), /only '\$name' and '\$' segments can be localized/);
  assert.throws(() => defineRouting({ ...base, pathnames: { '/a/$x': { de: '/b/$x' }, '/c/$y': { de: '/b/$y' } } }), /ambiguous in de/);
  assert.throws(() => defineRouting({ ...base, domains: [{ domain: 'a.com', defaultLocale: 'en' }, { domain: 'A.com', defaultLocale: 'de' }] }), /listed more than once/);
  const valid = defineRouting({ ...base, pathnames: { '/blog/$slug': { de: '/artikel/$slug' }, '/docs/$': '/docs/$' } });
  assert.equal(valid.defaultLocale, 'en');
});

test('the i18n object exposes the routing locales', () => {
  const i18n = build({ locales: ['en', 'de'], defaultLocale: 'en' });
  assert.deepEqual([...i18n.locales], ['en', 'de']);
  assert.equal(i18n.defaultLocale, 'en');
  assert.equal(typeof i18n.beforeLoad, 'function');
  assert.equal(typeof i18n.routerOptions, 'function');
});

test('getLocaleDirection is rtl for right-to-left scripts only', () => {
  for (const locale of ['ar', 'ar-EG', 'he', 'fa', 'ur', 'ps', 'ckb', 'yi', 'dv', 'sd-Arab']) assert.equal(getLocaleDirection(locale), 'rtl', locale);
  for (const locale of ['en', 'fr', 'de', 'ja', 'zh-Hant', 'tr', 'hi']) assert.equal(getLocaleDirection(locale), 'ltr', locale);
  // Not a locale at all: never throws, defaults to ltr.
  assert.equal(getLocaleDirection('not a locale'), 'ltr');
});
