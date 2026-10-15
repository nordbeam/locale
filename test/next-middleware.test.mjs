import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server.js';
import { createNextMiddleware } from '../dist/next-middleware.js';

const routing = (localePrefix, extra = {}) => ({
  locales: ['en', 'fr'],
  defaultLocale: 'en',
  localePrefix,
  ...extra,
});

const request = (path, init = {}) => new NextRequest(`http://localhost${path}`, init);

test('as-needed preserves default-locale canonical redirects and internal rewrites', () => {
  const middleware = createNextMiddleware(routing('as-needed'));
  const canonical = middleware(request('/en'));
  assert.equal(canonical.status, 307);
  assert.equal(canonical.headers.get('location'), 'http://localhost/');

  const defaultRoot = middleware(request('/'));
  assert.equal(defaultRoot.status, 200);
  assert.equal(defaultRoot.headers.get('x-middleware-rewrite'), 'http://localhost/en');

  const french = middleware(request('/fr/about'));
  assert.equal(french.status, 200);
  assert.match(french.headers.get('x-middleware-override-headers') ?? '', /x-nordbeam-locale/);
  assert.match(french.headers.get('link') ?? '', /http:\/\/localhost\/about.*hreflang="en"/);
  assert.match(french.headers.get('link') ?? '', /hreflang="x-default"/);
  assert.doesNotMatch(french.headers.get('link') ?? '', /localhost\/en\/about.*hreflang="en"/);
});

test('as-needed uses cookies and Accept-Language for unprefixed paths', () => {
  const middleware = createNextMiddleware(routing('as-needed'));
  const cookie = middleware(request('/about', { headers: { cookie: 'NEXT_LOCALE=fr' } }));
  assert.equal(cookie.status, 307);
  assert.equal(cookie.headers.get('location'), 'http://localhost/fr/about');

  const accepted = middleware(request('/about', { headers: { 'accept-language': 'fr-FR,fr;q=0.9' } }));
  assert.equal(accepted.status, 307);
  assert.equal(accepted.headers.get('location'), 'http://localhost/fr/about');

  const unsupported = middleware(request('/de', { headers: { 'accept-language': 'fr' } }));
  assert.equal(unsupported.status, 307);
  assert.equal(unsupported.headers.get('location'), 'http://localhost/fr/de');
});

test('always and never preserve their prefix contracts', () => {
  const always = createNextMiddleware(routing('always'));
  assert.equal(always(request('/')).headers.get('location'), 'http://localhost/en');
  assert.equal(always(request('/fr')).status, 200);
  assert.match(always(request('/fr')).headers.get('x-middleware-override-headers') ?? '', /x-nordbeam-locale/);

  const never = createNextMiddleware(routing('never'));
  assert.equal(never(request('/fr/about')).status, 307);
  assert.equal(never(request('/fr/about')).headers.get('location'), 'http://localhost/about');
  assert.equal(never(request('/about', { headers: { 'accept-language': 'fr' } })).status, 200);
  assert.equal(never(request('/about', { headers: { 'accept-language': 'fr' } })).headers.get('x-middleware-rewrite'), 'http://localhost/fr/about');
});

test('cookie configuration and query strings are retained', () => {
  const middleware = createNextMiddleware(routing('as-needed', { localeCookie: { name: 'locale', sameSite: 'strict' } }));
  const response = middleware(request('/fr?view=all', { headers: { cookie: 'locale=en' } }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie') ?? '', /locale=fr/);
  assert.match(response.headers.get('set-cookie') ?? '', /SameSite=strict/);
});
