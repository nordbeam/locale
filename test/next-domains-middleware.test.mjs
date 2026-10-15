import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server.js';
import { createNextMiddleware } from '../dist/next-middleware.js';
import { domainRouting } from './next-domains-fixtures/routing.mjs';

const request = (host, path, init = {}) => new NextRequest(`https://${host}${path}`, { ...init, headers: { host, ...init.headers } });
const cookie = locale => ({ headers: { cookie: `NEXT_LOCALE=${locale}` } });
const outcome = response => ({
  status: response.status,
  location: response.headers.get('location'),
  rewrite: response.headers.get('x-middleware-rewrite'),
});
const rewriteTo = url => ({ status: 200, location: null, rewrite: url });
const redirectTo = url => ({ status: 307, location: url, rewrite: null });
// The path already is the internal route, so the request passes through without a rewrite.
const passThrough = { status: 200, location: null, rewrite: null };

function check(middleware, cases) {
  for (const [host, path, init, expected] of cases) {
    assert.deepEqual(outcome(middleware(request(host, path, init))), expected, `${host}${path} ${JSON.stringify(init ?? {})}`);
  }
}

test('always: a configured host serves its own locales and redirects a locale that another host serves', () => {
  const middleware = createNextMiddleware(domainRouting('always'));
  check(middleware, [
    ['example.com', '/en/about', undefined, passThrough],
    ['example.com', '/fr/a-propos', undefined, rewriteTo('https://example.com/fr/about')],
    ['example.com', '/de/ueber-uns?x=1', undefined, redirectTo('https://example.de/de/ueber-uns?x=1')],
    ['example.com', '/de/about', undefined, redirectTo('https://example.de/de/ueber-uns')],
    ['example.com', '/about', undefined, redirectTo('https://example.com/en/about')],
    ['example.com', '/', undefined, redirectTo('https://example.com/en')],
    ['example.de', '/de/ueber-uns', undefined, rewriteTo('https://example.de/de/about')],
    ['example.de', '/de/artikel/hello', undefined, rewriteTo('https://example.de/de/blog/hello')],
    ['example.de', '/', undefined, redirectTo('https://example.de/de')],
    ['example.de', '/en/about', undefined, redirectTo('https://example.com/en/about')],
    ['example.de', '/fr/a-propos', undefined, redirectTo('https://example.com/fr/a-propos')],
    ['localhost:3001', '/fr/a-propos', undefined, rewriteTo('https://localhost:3001/fr/about')],
    ['localhost:3001', '/about', undefined, redirectTo('https://localhost:3001/fr/a-propos')],
    ['localhost:3001', '/en/about', undefined, redirectTo('https://example.com/en/about')],
  ]);
});

test('as-needed: each domain leaves its default locale unprefixed', () => {
  const middleware = createNextMiddleware(domainRouting('as-needed'));
  check(middleware, [
    ['example.com', '/about', undefined, rewriteTo('https://example.com/en/about')],
    ['example.com', '/en/about', undefined, redirectTo('https://example.com/about')],
    ['example.com', '/', undefined, rewriteTo('https://example.com/en')],
    ['example.com', '/fr/a-propos?y=2', undefined, rewriteTo('https://example.com/fr/about?y=2')],
    ['example.com', '/fr/about', undefined, redirectTo('https://example.com/fr/a-propos')],
    ['example.com', '/de/ueber-uns?x=1', undefined, redirectTo('https://example.de/ueber-uns?x=1')],
    ['example.de', '/ueber-uns', undefined, rewriteTo('https://example.de/de/about')],
    ['example.de', '/about', undefined, redirectTo('https://example.de/ueber-uns')],
    ['example.de', '/de/about', undefined, redirectTo('https://example.de/ueber-uns')],
    ['example.de', '/en/about', undefined, redirectTo('https://example.com/about')],
    ['example.de', '/fr/a-propos', undefined, redirectTo('https://example.com/fr/a-propos')],
    ['localhost:3001', '/a-propos', undefined, rewriteTo('https://localhost:3001/fr/about')],
    ['localhost:3001', '/fr/a-propos', undefined, redirectTo('https://localhost:3001/a-propos')],
    ['localhost:3001', '/en/about', undefined, redirectTo('https://example.com/about')],
  ]);
});

test('the locale comes from the cookie and Accept-Language only among the locales of the host', () => {
  const always = createNextMiddleware(domainRouting('always'));
  check(always, [
    ['example.com', '/', cookie('de'), redirectTo('https://example.com/en')],
    ['example.com', '/', cookie('fr'), redirectTo('https://example.com/fr')],
    ['example.de', '/', cookie('fr'), redirectTo('https://example.de/de')],
    ['example.com', '/', { headers: { 'accept-language': 'de-DE, fr;q=0.8' } }, redirectTo('https://example.com/fr')],
    ['example.de', '/', { headers: { 'accept-language': 'en-US' } }, redirectTo('https://example.de/de')],
  ]);
  const asNeeded = createNextMiddleware(domainRouting('as-needed'));
  check(asNeeded, [
    ['example.com', '/', cookie('fr'), redirectTo('https://example.com/fr')],
    ['example.com', '/', cookie('de'), rewriteTo('https://example.com/en')],
    // An unlisted path is its own internal route, as it is without domains.
    ['example.com', '/ueber-uns', cookie('de'), rewriteTo('https://example.com/en/ueber-uns')],
  ]);
});

test('a host that is not configured behaves as the routing alone', () => {
  const middleware = createNextMiddleware(domainRouting('as-needed'));
  const plain = createNextMiddleware({ locales: ['en', 'de', 'fr'], defaultLocale: 'en', localePrefix: 'as-needed', pathnames: domainRouting().pathnames });
  for (const path of ['/about', '/en/about', '/de/ueber-uns', '/fr/a-propos', '/blog/hello', '/', '/de/blog/hello?x=1']) {
    assert.deepEqual(outcome(middleware(request('unknown.test', path))), outcome(plain(request('unknown.test', path))), path);
  }
  check(middleware, [
    ['unknown.test', '/de/ueber-uns', undefined, rewriteTo('https://unknown.test/de/about')],
    ['unknown.test', '/fr/a-propos', undefined, rewriteTo('https://unknown.test/fr/about')],
    ['localhost:3000', '/fr/about', undefined, redirectTo('https://localhost:3000/fr/a-propos')],
  ]);
});

test('the domain header names the matched domain on every path, and is never taken from the client', () => {
  const middleware = createNextMiddleware(domainRouting('as-needed'));
  const domainOf = (host, path, init) => middleware(request(host, path, init)).headers.get('x-middleware-request-x-nordbeam-domain');
  assert.equal(domainOf('example.com', '/about'), 'example.com');
  assert.equal(domainOf('example.de', '/ueber-uns'), 'example.de');
  assert.equal(domainOf('localhost:3001', '/a-propos'), 'localhost:3001');
  assert.equal(domainOf('unknown.test', '/about', { headers: { 'x-nordbeam-domain': 'example.de' } }), '');
  assert.equal(domainOf('example.com', '/about', { headers: { 'x-nordbeam-domain': 'example.de' } }), 'example.com');
  assert.equal(middleware(request('example.com', '/de/ueber-uns')).headers.get('x-middleware-request-x-nordbeam-locale'), null);
  assert.equal(middleware(request('example.de', '/ueber-uns')).headers.get('x-middleware-request-x-nordbeam-locale'), 'de');
});

test('a spoofed Host never causes a redirect to a host outside the configured domains', () => {
  const middleware = createNextMiddleware(domainRouting('always'));
  const hosts = ['evil.test', 'example.de.evil.test', 'example.com:443@evil.test'];
  for (const spoof of hosts) {
    for (const path of ['/en/about', '/de/ueber-uns', '/fr/a-propos', '/about', '/']) {
      // The URL is on example.com, so a redirect can only name example.com or a configured domain.
      const response = middleware(new NextRequest(`https://example.com${path}`, { headers: { host: spoof, 'x-forwarded-host': spoof } }));
      const location = response.headers.get('location');
      if (location) assert.ok(['https://example.com', 'https://example.de'].some(origin => location.startsWith(`${origin}/`) || location === origin), `${spoof}${path} -> ${location}`);
    }
  }
  // A spoofed Host that names a configured domain selects that domain, and only its configured redirects follow.
  check(middleware, [
    ['example.de', '/fr/a-propos', undefined, redirectTo('https://example.com/fr/a-propos')],
  ]);
});

test('trustForwardedHost reads x-forwarded-host only when it is enabled, and then its first entry', () => {
  const untrusted = createNextMiddleware(domainRouting('always'));
  const trusted = createNextMiddleware(domainRouting('always'), { trustForwardedHost: true });
  const forwarded = { headers: { 'x-forwarded-host': 'example.de' } };
  check(untrusted, [
    ['internal.test', '/en/about', forwarded, passThrough],
    ['internal.test', '/de/ueber-uns', forwarded, rewriteTo('https://internal.test/de/about')],
  ]);
  check(trusted, [
    ['internal.test', '/en/about', forwarded, redirectTo('https://example.com/en/about')],
    ['internal.test', '/de/ueber-uns', { headers: { 'x-forwarded-host': 'EXAMPLE.DE, proxy.internal' } }, rewriteTo('https://internal.test/de/about')],
    ['internal.test', '/en/about', { headers: { 'x-forwarded-host': 'evil.test' } }, passThrough],
    // A trusted forwarded host replaces the Host header, so an unknown forwarded host is not a domain.
    ['example.de', '/en/about', { headers: { 'x-forwarded-host': 'evil.test' } }, passThrough],
    ['example.com', '/en/about', { headers: { 'x-forwarded-host': '' } }, passThrough],
  ]);
  const domainHeader = middleware => middleware(new NextRequest('https://internal.test/fr/a-propos', { headers: { host: 'internal.test', 'x-forwarded-host': 'example.com' } })).headers.get('x-middleware-request-x-nordbeam-domain');
  assert.equal(domainHeader(untrusted), '');
  assert.equal(domainHeader(trusted), 'example.com');
});

test('alternate links are absolute and name each locale on the first domain that serves it', () => {
  const middleware = createNextMiddleware(domainRouting('always'));
  const link = (host, path) => middleware(request(host, path)).headers.get('link');
  assert.equal(link('example.com', '/fr/a-propos'), [
    '<https://example.com/en/about>; rel="alternate"; hreflang="en"',
    '<https://example.de/de/ueber-uns>; rel="alternate"; hreflang="de"',
    '<https://example.com/fr/a-propos>; rel="alternate"; hreflang="fr"',
    '<https://example.com/en/about>; rel="alternate"; hreflang="x-default"',
  ].join(', '));
  const asNeeded = createNextMiddleware(domainRouting('as-needed'));
  assert.equal(asNeeded(request('example.de', '/ueber-uns')).headers.get('link'), [
    '<https://example.com/about>; rel="alternate"; hreflang="en"',
    '<https://example.de/ueber-uns>; rel="alternate"; hreflang="de"',
    '<https://example.com/fr/a-propos>; rel="alternate"; hreflang="fr"',
    '<https://example.com/about>; rel="alternate"; hreflang="x-default"',
  ].join(', '));
  assert.equal(link('localhost:3001', '/fr/about'), [
    '<https://example.com/en/about>; rel="alternate"; hreflang="en"',
    '<https://example.de/de/ueber-uns>; rel="alternate"; hreflang="de"',
    '<https://example.com/fr/a-propos>; rel="alternate"; hreflang="fr"',
    '<https://example.com/en/about>; rel="alternate"; hreflang="x-default"',
  ].join(', '));
});

test('alternate links leave out a locale that no domain serves, and alternateLinks can turn them off', () => {
  const partial = [{ domain: 'example.com', defaultLocale: 'en', locales: ['en'] }];
  const middleware = createNextMiddleware(domainRouting('as-needed', { domains: partial }));
  assert.equal(middleware(request('example.com', '/about')).headers.get('link'), [
    '<https://example.com/about>; rel="alternate"; hreflang="en"',
    '<https://example.com/about>; rel="alternate"; hreflang="x-default"',
  ].join(', '));
  const off = createNextMiddleware(domainRouting('always', { alternateLinks: false }));
  assert.equal(off(request('example.com', '/en/about')).headers.get('link'), null);
});

test('domain names are lowercase-normalized, so a request host matches in any case', () => {
  const middleware = createNextMiddleware(domainRouting('always', { domains: [{ domain: 'EXAMPLE.de', defaultLocale: 'de' }] }));
  assert.equal(middleware(request('Example.DE', '/de/ueber-uns')).headers.get('x-middleware-request-x-nordbeam-domain'), 'example.de');
});
