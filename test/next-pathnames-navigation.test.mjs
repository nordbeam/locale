import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { defineRouting } from '../dist/next-routing.js';

register('./next-pathnames-hooks.mjs', import.meta.url);
const { createNextNavigation } = await import('../dist/next-navigation.js');
const { NextNavigationClientLink } = await import('../dist/next-navigation-client.js');

const routing = defineRouting({
  locales: ['en', 'de'],
  defaultLocale: 'en',
  localePrefix: 'as-needed',
  pathnames: {
    '/about': { de: '/ueber-uns' },
    '/blog/[slug]': { de: '/artikel/[slug]' },
    '/docs/[...path]': { de: '/dokumente/[...path]' },
  },
});

function currentPathname(pathname) {
  globalThis.__w2Pathname = pathname;
}

function recordingRouter() {
  const calls = [];
  const record = name => (href, options) => calls.push({ name, href, options });
  globalThis.__w2Router = { push: record('push'), replace: record('replace'), prefetch: record('prefetch'), back: () => {}, refresh: () => {} };
  return calls;
}

function redirectDigest(action) {
  try { action(); } catch (error) { return error.digest; }
  assert.fail('redirect did not throw');
}

test('usePathname returns the internal concrete path for localized URLs', () => {
  const { usePathname } = createNextNavigation(routing);
  const cases = [
    ['/de/ueber-uns', '/about'],
    ['/de/artikel/hello', '/blog/hello'],
    ['/de/artikel/caf%C3%A9', '/blog/caf%C3%A9'],
    ['/de/dokumente/a/b', '/docs/a/b'],
    ['/de/about', '/about'],
    ['/about', '/about'],
    ['/de/unlisted', '/unlisted'],
    ['/', '/'],
  ];
  for (const [url, internal] of cases) {
    currentPathname(url);
    assert.equal(usePathname(), internal, url);
  }
});

test('usePathname keeps raw unlisted paths as they are', () => {
  const { usePathname } = createNextNavigation({ locales: ['en', 'de'], defaultLocale: 'en' });
  currentPathname('/de/caf%C3%A9');
  assert.equal(usePathname(), '/caf%C3%A9');
});

test('a language switcher replaces the pathname with the target locale path', () => {
  const { useRouter, usePathname } = createNextNavigation(routing);
  const calls = recordingRouter();
  for (const [url, expected] of [['/de/artikel/hello', '/de/artikel/hello'], ['/about', '/about'], ['/de/ueber-uns', '/de/ueber-uns']]) {
    currentPathname(url);
    const router = useRouter();
    router.replace(usePathname(), { locale: url.startsWith('/de') ? 'en' : 'de' });
    assert.equal(calls.at(-1).href, url.startsWith('/de') ? (url === '/de/artikel/hello' ? '/blog/hello' : '/about') : '/de/ueber-uns', url);
  }
  currentPathname('/de/artikel/hello');
  const switcher = useRouter();
  switcher.replace(usePathname(), { locale: 'de' });
  assert.equal(calls.at(-1).href, '/de/artikel/hello');
});

test('router push, replace and prefetch localize string and object hrefs', () => {
  const { useRouter } = createNextNavigation(routing);
  const calls = recordingRouter();
  currentPathname('/');
  const router = useRouter();
  router.push('/about', { locale: 'de', scroll: false });
  router.replace({ pathname: '/blog/[slug]', params: { slug: 'a b' } }, { locale: 'de' });
  router.prefetch({ pathname: '/docs/[...path]', params: { path: ['x', 'y z'] } }, { locale: 'de' });
  router.push('https://example.com/about');
  assert.deepEqual(calls.map(({ name, href }) => [name, href]), [
    ['push', '/de/ueber-uns'],
    ['replace', '/de/artikel/a%20b'],
    ['prefetch', '/de/dokumente/x/y%20z'],
    ['push', 'https://example.com/about'],
  ]);
  assert.deepEqual(calls[0].options, { scroll: false });
});

test('Link localizes string and object hrefs for the target locale and the current pathname', () => {
  const { Link } = createNextNavigation(routing);
  currentPathname('/de/artikel/hello');
  const hrefOf = props => NextNavigationClientLink({ ...props, routing }).props.href;
  assert.equal(Link({ href: '/about', locale: 'de' }).props.routing, routing);
  assert.equal(hrefOf({ href: '/about', locale: 'de' }), '/de/ueber-uns');
  assert.equal(hrefOf({ href: '/about', locale: 'en' }), '/about');
  assert.equal(hrefOf({ href: '/about' }), '/de/ueber-uns');
  assert.equal(hrefOf({ href: { pathname: '/blog/[slug]', params: { slug: 'x' } }, locale: 'de' }), '/de/artikel/x');
  assert.equal(hrefOf({ href: { pathname: '/blog/[slug]', params: { slug: 'x' }, query: { tab: 'all' }, hash: 'top' }, locale: false }), '/blog/x?tab=all#top');
  assert.equal(hrefOf({ href: '/blog/hello?x=1#c', locale: 'de' }), '/de/artikel/hello?x=1#c');
  assert.equal(hrefOf({ href: 'https://example.com/a', locale: 'de' }), 'https://example.com/a');
});

test('getPathname returns the full external href for string, object and non-route hrefs', () => {
  const { getPathname } = createNextNavigation(routing);
  assert.equal(getPathname({ href: '/about', locale: 'en' }), '/about');
  assert.equal(getPathname({ href: '/about', locale: 'de' }), '/de/ueber-uns');
  assert.equal(getPathname({ href: '/about?x=1#h', locale: 'de' }), '/de/ueber-uns?x=1#h');
  assert.equal(getPathname({ href: { pathname: '/blog/[slug]', params: { slug: 'a/b' } }, locale: 'de' }), '/de/artikel/a%2Fb');
  assert.equal(getPathname({ href: '/de/ueber-uns', locale: 'en' }), '/about');
  assert.equal(getPathname({ href: '#top', locale: 'de' }), '#top');
  assert.equal(getPathname({ href: 'https://example.com/x', locale: 'de' }), 'https://example.com/x');
  assert.equal(getPathname({ href: new URL('https://example.com/x'), locale: 'de' }), 'https://example.com/x');
});

test('redirect and permanentRedirect localize the target and keep the locale requirement', () => {
  const { redirect, permanentRedirect } = createNextNavigation(routing);
  assert.equal(redirectDigest(() => redirect('/blog/hello', 'de')).split(';')[2], '/de/artikel/hello');
  assert.equal(redirectDigest(() => redirect('/blog/hello', { locale: 'de' })).split(';')[2], '/de/artikel/hello');
  assert.equal(redirectDigest(() => redirect('/about', false)).split(';')[2], '/about');
  assert.equal(redirectDigest(() => permanentRedirect({ pathname: '/docs/[...path]', params: { path: ['a', 'b'] } }, 'de')).split(';')[2], '/de/dokumente/a/b');
  assert.match(redirectDigest(() => permanentRedirect('/about', 'de')), /^NEXT_REDIRECT;replace;\/de\/ueber-uns;308/);
  assert.throws(() => redirect('/blog/hello'), { name: 'TypeError', message: /needs a locale/ });
  assert.throws(() => permanentRedirect({ pathname: '/about' }, {}), { name: 'TypeError', message: /needs a locale/ });
  assert.equal(redirectDigest(() => permanentRedirect('/de/artikel/hello', undefined)).split(';')[2], '/de/artikel/hello');
});

test('the navigation factory validates pathnames once the routing is created', () => {
  assert.throws(() => createNextNavigation({ locales: ['en'], defaultLocale: 'en', pathnames: { '/a/[x]': { en: '/b' } } }), /must have the same params/);
});
