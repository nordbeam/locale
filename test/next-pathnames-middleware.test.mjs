import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server.js';
import { createNextMiddleware } from '../packages/locale/dist/next-middleware.js';
import { defineRouting } from '../packages/locale/dist/next-routing.js';

const pathnames = {
  '/about': { de: '/ueber-uns', fr: '/a-propos' },
  '/blog/[slug]': { de: '/artikel/[slug]' },
};
const routing = (localePrefix, extra = {}) => defineRouting({ locales: ['en', 'de', 'fr'], defaultLocale: 'en', localePrefix, pathnames, ...extra });
const request = (path, init = {}) => new NextRequest(`http://localhost${path}`, init);
const cookie = locale => ({ headers: { cookie: `NEXT_LOCALE=${locale}` } });
const outcome = response => ({
  status: response.status,
  location: response.headers.get('location'),
  rewrite: response.headers.get('x-middleware-rewrite'),
});
const rewriteTo = path => ({ status: 200, location: null, rewrite: `http://localhost${path}` });
const passThrough = { status: 200, location: null, rewrite: null };
const redirectTo = path => ({ status: 307, location: `http://localhost${path}`, rewrite: null });

function check(middleware, cases) {
  for (const [path, init, expected] of cases) {
    assert.deepEqual(outcome(middleware(request(path, init))), expected, `${path} ${JSON.stringify(init ?? {})}`);
  }
}

test('always: localized paths rewrite to the internal route and internal or other-locale paths redirect to the localized one', () => {
  const middleware = createNextMiddleware(routing('always'));
  check(middleware, [
    ['/de/ueber-uns', undefined, rewriteTo('/de/about')],
    ['/fr/a-propos', undefined, rewriteTo('/fr/about')],
    ['/de/about', undefined, redirectTo('/de/ueber-uns')],
    ['/fr/about', undefined, redirectTo('/fr/a-propos')],
    ['/fr/ueber-uns', undefined, redirectTo('/fr/a-propos')],
    ['/de/artikel/hello', undefined, rewriteTo('/de/blog/hello')],
    ['/de/blog/hello', undefined, redirectTo('/de/artikel/hello')],
    ['/de/artikel/hello?x=1#ignored', undefined, rewriteTo('/de/blog/hello?x=1')],
    ['/about', undefined, redirectTo('/en/about')],
    ['/', undefined, redirectTo('/en')],
  ]);
});

test('always: a prefix-less localized path redirects into the locale it belongs to', () => {
  const middleware = createNextMiddleware(routing('always'));
  check(middleware, [
    ['/ueber-uns', cookie('de'), redirectTo('/de/ueber-uns')],
    ['/a-propos', cookie('fr'), redirectTo('/fr/a-propos')],
    ['/ueber-uns', undefined, redirectTo('/en/about')],
  ]);
});

test('as-needed: the default locale stays unprefixed and other locales use their localized path', () => {
  const middleware = createNextMiddleware(routing('as-needed'));
  check(middleware, [
    ['/about', undefined, rewriteTo('/en/about')],
    ['/en/about', undefined, redirectTo('/about')],
    ['/en/ueber-uns', undefined, redirectTo('/about')],
    ['/de/ueber-uns', undefined, rewriteTo('/de/about')],
    ['/de/about', undefined, redirectTo('/de/ueber-uns')],
    ['/fr/about', undefined, redirectTo('/fr/a-propos')],
    ['/fr/a-propos?y=2', undefined, rewriteTo('/fr/about?y=2')],
    ['/ueber-uns', cookie('de'), redirectTo('/de/ueber-uns')],
    ['/ueber-uns', { headers: { 'accept-language': 'de-DE' } }, redirectTo('/de/ueber-uns')],
  ]);
});

test('never: the locale comes from the cookie or Accept-Language and the path is localized for it', () => {
  const middleware = createNextMiddleware(routing('never'));
  check(middleware, [
    ['/ueber-uns', cookie('de'), rewriteTo('/de/about')],
    ['/about', cookie('de'), redirectTo('/ueber-uns')],
    ['/ueber-uns', undefined, redirectTo('/about')],
    ['/about', { headers: { 'accept-language': 'fr' } }, redirectTo('/a-propos')],
    ['/a-propos', { headers: { 'accept-language': 'fr' } }, rewriteTo('/fr/about')],
    ['/de/ueber-uns', undefined, redirectTo('/ueber-uns')],
    ['/fr/about', undefined, redirectTo('/a-propos')],
  ]);
});

test('paths that are not in pathnames behave exactly as before in every prefix mode', () => {
  const unlisted = {
    always: [['/de/unlisted', undefined, passThrough], ['/unlisted', undefined, redirectTo('/en/unlisted')]],
    'as-needed': [['/unlisted', undefined, rewriteTo('/en/unlisted')], ['/de/unlisted', undefined, passThrough]],
    never: [['/unlisted', cookie('de'), rewriteTo('/de/unlisted')], ['/unlisted', undefined, rewriteTo('/en/unlisted')]],
  };
  for (const [mode, cases] of Object.entries(unlisted)) {
    const middleware = createNextMiddleware(routing(mode));
    const plain = createNextMiddleware({ locales: ['en', 'de', 'fr'], defaultLocale: 'en', localePrefix: mode });
    for (const [path, init, expected] of cases) {
      assert.deepEqual(outcome(middleware(request(path, init))), expected, `${mode} ${path}`);
      assert.deepEqual(outcome(middleware(request(path, init))), outcome(plain(request(path, init))), `${mode} ${path} matches the plain routing`);
    }
  }
});

test('alternate links name the same page in each locale localized path', () => {
  const middleware = createNextMiddleware(routing('as-needed'));
  const link = middleware(request('/fr/a-propos?y=2')).headers.get('link');
  assert.equal(link, [
    '<http://localhost/about?y=2>; rel="alternate"; hreflang="en"',
    '<http://localhost/de/ueber-uns?y=2>; rel="alternate"; hreflang="de"',
    '<http://localhost/fr/a-propos?y=2>; rel="alternate"; hreflang="fr"',
    '<http://localhost/about?y=2>; rel="alternate"; hreflang="x-default"',
  ].join(', '));

  const blog = createNextMiddleware(routing('always'))(request('/de/artikel/hello')).headers.get('link');
  assert.match(blog, /<http:\/\/localhost\/en\/blog\/hello>; rel="alternate"; hreflang="en"/);
  assert.match(blog, /<http:\/\/localhost\/de\/artikel\/hello>; rel="alternate"; hreflang="de"/);
  assert.match(blog, /<http:\/\/localhost\/fr\/blog\/hello>; rel="alternate"; hreflang="fr"/);
  assert.match(blog, /<http:\/\/localhost\/en\/blog\/hello>; rel="alternate"; hreflang="x-default"/);
});

test('alternate links for unlisted paths keep the internal path in every locale', () => {
  const middleware = createNextMiddleware(routing('always'));
  const link = middleware(request('/de/unlisted')).headers.get('link');
  assert.match(link, /<http:\/\/localhost\/en\/unlisted>; rel="alternate"; hreflang="en"/);
  assert.match(link, /<http:\/\/localhost\/de\/unlisted>; rel="alternate"; hreflang="de"/);
});

test('encoded params survive the rewrite and redirect without a second decode', () => {
  const middleware = createNextMiddleware(routing('always'));
  check(middleware, [
    ['/de/artikel/caf%C3%A9', undefined, rewriteTo('/de/blog/caf%C3%A9')],
    ['/de/artikel/a%2Fb%20c', undefined, rewriteTo('/de/blog/a%2Fb%20c')],
    ['/de/blog/100%25', undefined, redirectTo('/de/artikel/100%25')],
    ['/de/blog/%2541', undefined, redirectTo('/de/artikel/%2541')],
  ]);
});

test('the canonical redirect keeps the request search and the default-locale rules', () => {
  const middleware = createNextMiddleware(routing('as-needed', { localeCookie: false }));
  check(middleware, [
    ['/en/about?a=1', undefined, redirectTo('/about?a=1')],
    ['/de/about?a=1', undefined, redirectTo('/de/ueber-uns?a=1')],
  ]);
});
