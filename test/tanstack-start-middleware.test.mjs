import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocaleFunctionMiddleware, createLocaleMiddleware, defineRouting } from '../dist/tanstack-start.js';

const routing = (localePrefix, extra = {}) => defineRouting({
  locales: ['en', 'fr'],
  defaultLocale: 'en',
  localePrefix,
  ...extra,
});

const localized = {
  pathnames: { '/about': { fr: '/a-propos' } },
};

/** Runs the request middleware the way Start does and reports what it decided. */
async function run(middleware, path, headers = {}, { handlerType = 'router', origin = 'http://localhost' } = {}) {
  const request = new Request(origin + path, { headers });
  const url = new URL(request.url);
  let passed;
  const result = await middleware.options.server({
    request,
    pathname: url.pathname,
    handlerType,
    context: {},
    next: async ({ context } = {}) => {
      passed = context;
      return { request, pathname: url.pathname, context, response: new Response('page', { headers: { 'content-type': 'text/html' } }) };
    },
  });
  const response = result instanceof Response ? result : result.response;
  return { response, context: passed, redirected: response.status === 307, location: response.headers.get('location') };
}

test('as-needed redirects the default prefix away and detects the locale of unprefixed paths', async () => {
  const middleware = createLocaleMiddleware(routing('as-needed'));
  const canonical = await run(middleware, '/en');
  assert.equal(canonical.redirected, true);
  assert.equal(canonical.location, 'http://localhost/');

  const root = await run(middleware, '/');
  assert.equal(root.redirected, false);
  assert.deepEqual(root.context, { locale: 'en', domain: undefined });

  const french = await run(middleware, '/fr/about');
  assert.equal(french.redirected, false);
  assert.deepEqual(french.context, { locale: 'fr', domain: undefined });

  const cookie = await run(middleware, '/about', { cookie: 'NEXT_LOCALE=fr' });
  assert.equal(cookie.location, 'http://localhost/fr/about');
  const accepted = await run(middleware, '/about?x=1', { 'accept-language': 'fr-FR,fr;q=0.9' });
  assert.equal(accepted.location, 'http://localhost/fr/about?x=1');
  const unsupported = await run(middleware, '/de', { 'accept-language': 'fr' });
  assert.equal(unsupported.location, 'http://localhost/fr/de');
});

test('always prefixes every path and never removes the prefix', async () => {
  const always = createLocaleMiddleware(routing('always'));
  assert.equal((await run(always, '/')).location, 'http://localhost/en');
  assert.equal((await run(always, '/about')).location, 'http://localhost/en/about');
  assert.equal((await run(always, '/fr')).redirected, false);
  assert.equal((await run(always, '/fr')).context.locale, 'fr');

  const never = createLocaleMiddleware(routing('never'));
  assert.equal((await run(never, '/fr/about')).location, 'http://localhost/about');
  const detected = await run(never, '/about', { 'accept-language': 'fr' });
  assert.equal(detected.redirected, false);
  assert.equal(detected.context.locale, 'fr');
  assert.equal((await run(never, '/about', { cookie: 'NEXT_LOCALE=fr' })).context.locale, 'fr');
});

test('localized pathnames redirect to the canonical path of the locale', async () => {
  const middleware = createLocaleMiddleware(routing('as-needed', localized));
  assert.equal((await run(middleware, '/fr/about')).location, 'http://localhost/fr/a-propos');
  assert.equal((await run(middleware, '/fr/a-propos')).redirected, false);
  assert.equal((await run(middleware, '/fr/a-propos')).context.locale, 'fr');
  // A page named by another locale's path is canonicalized in the detected locale.
  assert.equal((await run(middleware, '/a-propos')).location, 'http://localhost/about');
  assert.equal((await run(middleware, '/a-propos', { cookie: 'NEXT_LOCALE=fr' })).location, 'http://localhost/fr/a-propos');
  assert.equal((await run(middleware, '/about')).redirected, false);
  assert.equal((await run(middleware, '/FR/a-propos?q=1')).location, 'http://localhost/fr/a-propos?q=1');
  // A custom prefix replaces the locale segment.
  const custom = createLocaleMiddleware(routing('always', { localePrefix: { mode: 'always', prefixes: { fr: '/francais' } } }));
  assert.equal((await run(custom, '/fr/x')).location, 'http://localhost/en/fr/x');
  assert.equal((await run(custom, '/francais/x')).context.locale, 'fr');
});

test('the locale cookie follows the NEXT_LOCALE rules of the Next middleware', async () => {
  const middleware = createLocaleMiddleware(routing('as-needed'));
  const cookies = response => response.headers.getSetCookie();

  const french = await run(middleware, '/fr/about');
  assert.deepEqual(cookies(french.response), ['NEXT_LOCALE=fr; Path=/; Max-Age=31536000; SameSite=Lax']);
  // The cookie is not written when it already says the same, or Accept-Language already gives the locale.
  assert.deepEqual(cookies((await run(middleware, '/fr/about', { cookie: 'NEXT_LOCALE=fr' })).response), []);
  assert.deepEqual(cookies((await run(middleware, '/fr', { 'accept-language': 'fr' })).response), []);
  // A stale cookie is replaced.
  assert.equal(cookies((await run(middleware, '/fr/about', { cookie: 'NEXT_LOCALE=en' })).response).length, 1);
  // Redirects carry the cookie too, so the next request agrees.
  assert.equal(cookies((await run(middleware, '/about', { 'accept-language': 'fr' })).response).length, 0);
  assert.equal(cookies((await run(middleware, '/en', { cookie: 'NEXT_LOCALE=fr' })).response).length, 1);
  // Only document requests write it.
  assert.deepEqual(cookies((await run(middleware, '/fr/about', { 'sec-fetch-dest': 'script' })).response), []);
  // Secure on https.
  const secure = await run(middleware, '/fr', {}, { origin: 'https://example.com' });
  assert.match(cookies(secure.response)[0], /; Secure$/);

  const custom = createLocaleMiddleware(routing('as-needed', { localeCookie: { name: 'LANG', sameSite: 'strict', maxAge: 60, httpOnly: true } }));
  assert.deepEqual(cookies((await run(custom, '/fr')).response), ['LANG=fr; Path=/; Max-Age=60; SameSite=Strict; HttpOnly']);
  assert.equal((await run(custom, '/about', { cookie: 'LANG=fr' })).location, 'http://localhost/fr/about');

  const off = createLocaleMiddleware(routing('as-needed', { localeCookie: false }));
  assert.deepEqual(cookies((await run(off, '/fr')).response), []);
});

test('localeDetection false ignores the cookie and Accept-Language', async () => {
  const middleware = createLocaleMiddleware(routing('as-needed', { localeDetection: false }));
  const result = await run(middleware, '/about', { cookie: 'NEXT_LOCALE=fr', 'accept-language': 'fr' });
  assert.equal(result.redirected, false);
  assert.equal(result.context.locale, 'en');
});

test('pages list their alternates in a Link header', async () => {
  const middleware = createLocaleMiddleware(routing('as-needed', localized));
  const link = (await run(middleware, '/fr/a-propos?x=1')).response.headers.get('link');
  assert.match(link, /<http:\/\/localhost\/about\?x=1>; rel="alternate"; hreflang="en"/);
  assert.match(link, /<http:\/\/localhost\/fr\/a-propos\?x=1>; rel="alternate"; hreflang="fr"/);
  assert.match(link, /<http:\/\/localhost\/about\?x=1>; rel="alternate"; hreflang="x-default"/);
  const never = createLocaleMiddleware(routing('never'));
  assert.equal((await run(never, '/about')).response.headers.get('link'), null);
  const off = createLocaleMiddleware(routing('as-needed', { alternateLinks: false }));
  assert.equal((await run(off, '/fr')).response.headers.get('link'), null);
  // The page response passes through untouched.
  const page = await run(middleware, '/');
  assert.equal(await page.response.text(), 'page');
  assert.equal(page.response.headers.get('content-type'), 'text/html');
});

test('assets and API routes are not redirected, and ignore is configurable', async () => {
  const middleware = createLocaleMiddleware(routing('always'));
  for (const path of ['/favicon.ico', '/assets/app.js', '/api/users', '/api']) {
    const result = await run(middleware, path, { 'accept-language': 'fr' });
    assert.equal(result.redirected, false, path);
    assert.deepEqual(result.context, { locale: undefined, domain: undefined }, path);
  }
  assert.equal((await run(middleware, '/apis')).redirected, true);
  const custom = createLocaleMiddleware(routing('always'), { ignore: pathname => pathname.startsWith('/health') });
  assert.equal((await run(custom, '/health/live')).redirected, false);
  assert.equal((await run(custom, '/api/users')).redirected, true);
});

test('paths that cannot be decoded pass through without a locale', async () => {
  const middleware = createLocaleMiddleware(routing('always'));
  const result = await run(middleware, '/%E0%A4%A');
  assert.equal(result.redirected, false);
  assert.deepEqual(result.context, { locale: undefined, domain: undefined });
});

test('encoded characters are never decoded twice in a redirect', async () => {
  const middleware = createLocaleMiddleware(routing('as-needed'));
  assert.equal((await run(middleware, '/en/100%25%20sure')).location, 'http://localhost/100%25%20sure');
});

test('domains serve their own locales and send other locales to the domain that serves them', async () => {
  const domains = [
    { domain: 'example.com', defaultLocale: 'en', locales: ['en'] },
    { domain: 'example.fr', defaultLocale: 'fr', locales: ['fr'] },
  ];
  const middleware = createLocaleMiddleware(routing('as-needed', { domains, ...localized }));
  const french = await run(middleware, '/a-propos', { host: 'example.fr' });
  assert.equal(french.redirected, false);
  assert.deepEqual(french.context, { locale: 'fr', domain: 'example.fr' });
  // A cookie for a locale the host does not serve is ignored.
  assert.deepEqual((await run(middleware, '/about', { host: 'example.com', cookie: 'NEXT_LOCALE=fr' })).context, { locale: 'en', domain: 'example.com' });
  const away = await run(middleware, '/fr/about?x=1', { host: 'example.com' });
  assert.equal(away.location, 'http://example.fr/a-propos?x=1');
  assert.equal(away.response.headers.getSetCookie().length, 0);
  // Other hosts, such as localhost, use the routing itself.
  assert.equal((await run(middleware, '/fr/a-propos', { host: 'localhost:3000' })).context.locale, 'fr');
  // Alternates are absolute URLs on the domains that serve each locale.
  const link = french.response.headers.get('link');
  assert.match(link, /<http:\/\/example\.com\/about>; rel="alternate"; hreflang="en"/);
  assert.match(link, /<http:\/\/example\.fr\/a-propos>; rel="alternate"; hreflang="fr"/);
});

test('x-forwarded-host is only trusted when asked', async () => {
  const domains = [{ domain: 'example.fr', defaultLocale: 'fr', locales: ['fr'] }, { domain: 'example.com', defaultLocale: 'en', locales: ['en'] }];
  const headers = { host: 'internal', 'x-forwarded-host': 'example.fr' };
  const plain = createLocaleMiddleware(routing('as-needed', { domains }));
  assert.equal((await run(plain, '/', headers)).context.domain, undefined);
  const trusted = createLocaleMiddleware(routing('as-needed', { domains }), { trustForwardedHost: true });
  assert.deepEqual((await run(trusted, '/', headers)).context, { locale: 'fr', domain: 'example.fr' });
});

test('server function calls use the locale the browser sent, then the page, the cookie and Accept-Language', async () => {
  const middleware = createLocaleMiddleware(routing('as-needed'));
  const call = headers => run(middleware, '/_serverFn/abc', headers, { handlerType: 'serverFn' });
  assert.deepEqual((await call({ 'x-nordbeam-locale': 'fr' })).context, { locale: 'fr', domain: undefined });
  // An unknown sent locale is ignored and the page decides.
  assert.equal((await call({ 'x-nordbeam-locale': 'xx', referer: 'http://localhost/fr/about' })).context.locale, 'fr');
  assert.equal((await call({ referer: 'http://localhost/about', cookie: 'NEXT_LOCALE=fr' })).context.locale, 'en');
  assert.equal((await call({ cookie: 'NEXT_LOCALE=fr' })).context.locale, 'fr');
  assert.equal((await call({ 'accept-language': 'fr' })).context.locale, 'fr');
  assert.equal((await call({ referer: 'not a url' })).context.locale, 'en');
  // Server functions are never redirected and never touch cookies.
  const result = await call({ referer: 'http://localhost/en' });
  assert.equal(result.redirected, false);
  assert.deepEqual(result.response.headers.getSetCookie(), []);
});

test('the function middleware sends nothing until a page locale is known', async () => {
  const middleware = createLocaleFunctionMiddleware();
  const sent = [];
  await middleware.options.client({ next: options => { sent.push(options); return {}; } });
  assert.deepEqual(sent, [{}]);
});
