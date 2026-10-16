import test from 'node:test';
import assert from 'node:assert/strict';
import { defineRouting, domainRouting, getPathname, servingDomain } from '../packages/locale/dist/next-routing.js';
import { domainRouting as fixtureRouting } from './next-domains-fixtures/routing.mjs';

const base = { locales: ['en', 'de', 'fr'], defaultLocale: 'en' };

test('defineRouting accepts domains with the default locales of all routing locales', () => {
  const routing = fixtureRouting();
  assert.equal(domainRouting(routing, 'example.com').defaultLocale, 'en');
  assert.deepEqual(domainRouting(routing, 'example.com').locales, ['en', 'fr']);
  assert.deepEqual(domainRouting(routing, 'example.de').locales, ['de']);
  assert.deepEqual(defineRouting({ ...base, domains: [{ domain: 'example.org', defaultLocale: 'fr' }] }).domains[0].domain, 'example.org');
  assert.deepEqual(domainRouting(defineRouting({ ...base, domains: [{ domain: 'example.org', defaultLocale: 'fr' }] }), 'example.org').locales, ['en', 'de', 'fr']);
});

test('domain lookups are case-insensitive, and the first domain serves a shared locale', () => {
  const routing = fixtureRouting();
  assert.equal(domainRouting(routing, 'EXAMPLE.COM')?.defaultLocale, 'en');
  assert.equal(domainRouting(routing, 'other.test'), undefined);
  assert.equal(domainRouting(routing, undefined), undefined);
  assert.equal(servingDomain(routing, 'fr'), 'example.com');
  assert.equal(servingDomain(routing, 'de'), 'example.de');
  assert.equal(servingDomain(defineRouting(base), 'de'), undefined);
});

test('defineRouting rejects a domain listed twice, even under another case', () => {
  assert.throws(() => defineRouting({ ...base, domains: [{ domain: 'Example.com', defaultLocale: 'en' }, { domain: 'example.COM', defaultLocale: 'en' }] }), { name: 'TypeError', message: /listed more than once/ });
});

test('defineRouting rejects a domain that is not a bare host', () => {
  for (const domain of ['', 'https://example.de', 'example.de/de', 'example.de?x=1', 'user@example.de', 'exa mple.de', ' example.de', 'example.de:99999']) {
    assert.throws(() => defineRouting({ ...base, domains: [{ domain, defaultLocale: 'en' }] }), { name: 'TypeError', message: /must be a host/ }, JSON.stringify(domain));
  }
});

test('defineRouting rejects domain locales that are not routing locales, duplicated, or empty', () => {
  assert.throws(() => defineRouting({ ...base, domains: [{ domain: 'a.test', defaultLocale: 'en', locales: ['es'] }] }), { name: 'TypeError', message: /unique locales from the routing locales/ });
  assert.throws(() => defineRouting({ ...base, domains: [{ domain: 'a.test', defaultLocale: 'en', locales: ['en', 'en'] }] }), { name: 'TypeError', message: /unique locales from the routing locales/ });
  assert.throws(() => defineRouting({ ...base, domains: [{ domain: 'a.test', defaultLocale: 'en', locales: [] }] }), { name: 'TypeError', message: /unique locales from the routing locales/ });
});

test('defineRouting rejects a domain defaultLocale that its locales do not include', () => {
  assert.throws(() => defineRouting({ ...base, domains: [{ domain: 'a.test', defaultLocale: 'de', locales: ['en', 'fr'] }] }), { name: 'TypeError', message: /defaultLocale in its locales/ });
  assert.throws(() => defineRouting({ ...base, domains: [{ domain: 'a.test', defaultLocale: 'nl' }] }), { name: 'TypeError', message: /defaultLocale in its locales/ });
});

test('a domain without locales of its own serves every routing locale', () => {
  const routing = defineRouting({ ...base, domains: [{ domain: 'a.test', defaultLocale: 'de' }, { domain: 'b.test', defaultLocale: 'fr' }] });
  assert.equal(servingDomain(routing, 'fr'), 'a.test');
  assert.deepEqual(domainRouting(routing, 'b.test').locales, ['en', 'de', 'fr']);
});

test('a domain keeps the pathnames of the routing, so localized paths work on every domain', () => {
  const routing = fixtureRouting();
  assert.equal(getPathname({ href: '/about', locale: 'fr', domain: 'localhost:3001' }, routing), '/a-propos');
  assert.equal(getPathname({ href: '/about', locale: 'de', domain: 'example.de' }, routing), '/ueber-uns');
  assert.equal(getPathname({ href: { pathname: '/blog/[slug]', params: { slug: 'x' } }, locale: 'de', domain: 'example.de' }, routing), '/artikel/x');
});

test('defineRouting still rejects invalid pathnames when domains are configured', () => {
  assert.throws(() => defineRouting({ ...base, domains: [{ domain: 'a.test', defaultLocale: 'en' }], pathnames: { '/a/[x]': { de: '/b' } } }), /must have the same params/);
});
