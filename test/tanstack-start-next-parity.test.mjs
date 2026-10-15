import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server.js';
import { createNextMiddleware } from '../dist/next-middleware.js';
import { createLocaleMiddleware } from '../dist/tanstack-start.js';

// Both adapters call the shared request decision in src/locale-request.ts, so the same
// routing and the same request must give the same redirect, locale, cookie and Link header.
const routing = (localePrefix, extra = {}) => ({ locales: ['en', 'fr'], defaultLocale: 'en', localePrefix, ...extra });

const variants = [
  {},
  { pathnames: { '/about': { fr: '/a-propos' }, '/blog/$slug': { fr: '/blogue/$slug' } } },
  { localeDetection: false },
  { localeCookie: { name: 'LANG', maxAge: 60 } },
  { domains: [{ domain: 'example.com', defaultLocale: 'en', locales: ['en'] }, { domain: 'example.fr', defaultLocale: 'fr', locales: ['fr'] }] },
];

const requests = [
  ['/'], ['/en'], ['/fr'], ['/fr/'], ['/en/about'], ['/fr/about'], ['/about'], ['/a-propos'], ['/fr/a-propos'], ['/FR/a-propos?x=1'], ['/de/about'],
  ['/blog/hi'], ['/fr/blog/hi'], ['/fr/blogue/hi'],
  ['/about', { cookie: 'NEXT_LOCALE=fr' }], ['/fr/about', { cookie: 'NEXT_LOCALE=en' }], ['/about', { cookie: 'LANG=fr' }],
  ['/about', { 'accept-language': 'fr-CA,fr;q=0.8,en;q=0.5' }], ['/about', { 'accept-language': '*' }], ['/', { 'accept-language': 'de' }],
  ['/fr', { 'sec-fetch-dest': 'script' }], ['//fr//about'], ['/fr/about/'], ['/%E0%A4%A'],
  ['/about', { host: 'example.fr' }], ['/fr/about', { host: 'example.com' }], ['/en/about', { host: 'example.fr' }], ['/', { host: 'example.com', cookie: 'NEXT_LOCALE=fr' }],
];

async function decide(middleware, path, headers) {
  const request = new Request(`http://localhost${path}`, { headers });
  let locale;
  const result = await middleware.options.server({
    request,
    pathname: new URL(request.url).pathname,
    handlerType: 'router',
    context: {},
    next: async ({ context }) => { locale = context.locale; return { request, context, response: new Response('page') }; },
  });
  const response = result instanceof Response ? result : result.response;
  return { response, locale };
}

for (const mode of ['always', 'as-needed', 'never']) {
  test(`TanStack Start and Next.js decide the same requests with ${mode}`, async () => {
    for (const extra of variants) {
      // Next.js pathname patterns use [param]; TanStack Start uses $param.
      const nextExtra = extra.pathnames ? { pathnames: { '/about': extra.pathnames['/about'], '/blog/[slug]': { fr: '/blogue/[slug]' } } } : extra;
      const next = createNextMiddleware(routing(mode, nextExtra));
      const tanstack = createLocaleMiddleware(routing(mode, extra));
      for (const [path, headers] of requests) {
        const expected = next(new NextRequest(`http://localhost${path}`, { headers }));
        const actual = await decide(tanstack, path, headers);
        const label = `${mode} ${JSON.stringify(extra)} ${path} ${JSON.stringify(headers ?? {})}`;
        if (expected.status === 307) {
          assert.equal(actual.response.headers.get('location'), expected.headers.get('location'), label);
        } else {
          assert.equal(actual.response.status, 200, label);
          assert.equal(actual.locale ?? '', expected.headers.get('x-middleware-request-x-nordbeam-locale') ?? '', label);
        }
        assert.equal(actual.response.headers.get('link'), expected.headers.get('link'), label);
        const cookies = response => response.headers.getSetCookie().map(value => value.split(';')[0]);
        assert.deepEqual(cookies(actual.response), cookies(expected), label);
      }
    }
  });
}
