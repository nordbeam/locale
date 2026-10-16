import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { defineRouting } from '../packages/locale/dist/next-routing.js';
import { domainRouting } from './next-domains-fixtures/routing.mjs';

register('./next-pathnames-hooks.mjs', import.meta.url);
const { createNextNavigation } = await import('../packages/locale/dist/next-navigation.js');
const { NextNavigationClientLink } = await import('../packages/locale/dist/next-navigation-client.js');

const routing = domainRouting('as-needed');

// The host is the server snapshot until mounted(host) sets the page's host, as after hydration in a browser.
function mounted(host) {
  globalThis.location = { host };
  globalThis.__w3Mounted = true;
}
function server() {
  delete globalThis.location;
  globalThis.__w3Mounted = false;
}
function currentPathname(pathname) {
  globalThis.__w2Pathname = pathname;
}
function recordingRouter() {
  const calls = [];
  const record = name => (href, options) => calls.push({ name, href, options });
  globalThis.__w2Router = { push: record('push'), replace: record('replace'), prefetch: record('prefetch'), back: () => {}, refresh: () => {} };
  return calls;
}

test('getPathname with a domain uses its prefix rules, or the absolute URL of the domain that serves the locale', () => {
  const { getPathname } = createNextNavigation(routing);
  const cases = [
    [{ href: '/about', locale: 'en', domain: 'example.com' }, '/about'],
    [{ href: '/about', locale: 'fr', domain: 'example.com' }, '/fr/a-propos'],
    [{ href: '/about', locale: 'de', domain: 'example.com' }, 'https://example.de/ueber-uns'],
    [{ href: '/about', locale: 'de', domain: 'example.de' }, '/ueber-uns'],
    [{ href: '/about', locale: 'en', domain: 'example.de' }, 'https://example.com/about'],
    [{ href: '/about', locale: 'fr', domain: 'localhost:3001' }, '/a-propos'],
    [{ href: '/about', locale: 'en', domain: 'localhost:3001' }, 'https://example.com/about'],
    [{ href: '/about', locale: 'de', domain: 'EXAMPLE.DE' }, '/ueber-uns'],
    [{ href: { pathname: '/blog/[slug]', params: { slug: 'a b' }, query: { x: 1 }, hash: 'top' }, locale: 'de', domain: 'example.com' }, 'https://example.de/artikel/a%20b?x=1#top'],
    [{ href: '#top', locale: 'de', domain: 'example.com' }, '#top'],
    [{ href: 'https://other.test/a', locale: 'de', domain: 'example.com' }, 'https://other.test/a'],
    // A host that is not configured is ignored, so the routing answers as it does without domains.
    [{ href: '/about', locale: 'de', domain: 'other.test' }, '/de/ueber-uns'],
    [{ href: '/about', locale: 'de' }, '/de/ueber-uns'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(getPathname(input), expected, JSON.stringify(input));
  }
});

test('getPathname with a domain uses the http origin for localhost domains', () => {
  const local = defineRouting({
    locales: ['en', 'de'],
    defaultLocale: 'en',
    localePrefix: 'always',
    pathnames: { '/about': { de: '/ueber-uns' } },
    domains: [{ domain: 'localhost:3001', defaultLocale: 'en', locales: ['en'] }, { domain: 'example.de', defaultLocale: 'de', locales: ['de'] }],
  });
  const { getPathname } = createNextNavigation(local);
  assert.equal(getPathname({ href: '/about', locale: 'en', domain: 'example.de' }), 'http://localhost:3001/en/about');
  assert.equal(getPathname({ href: '/about', locale: 'de', domain: 'localhost:3001' }), 'https://example.de/de/ueber-uns');
  assert.equal(getPathname({ href: '/about', locale: 'en', domain: 'localhost:3001' }), '/en/about');
});

test('getPathname with a domain follows the prefix rules of that domain under always', () => {
  const { getPathname } = createNextNavigation(domainRouting('always'));
  assert.equal(getPathname({ href: '/about', locale: 'en', domain: 'example.com' }), '/en/about');
  assert.equal(getPathname({ href: '/about', locale: 'de', domain: 'example.com' }), 'https://example.de/de/ueber-uns');
  assert.equal(getPathname({ href: '/about', locale: 'de', domain: 'example.de' }), '/de/ueber-uns');
});

test('the Link renders the prefixed href on the server, then the domain href after mount', () => {
  const { Link } = createNextNavigation(routing);
  const hrefOf = props => NextNavigationClientLink({ ...props, routing }).props.href;
  currentPathname('/ueber-uns');
  try {
    // Server render and hydration: the host is unknown, so the href is the prefixed form every host can serve.
    server();
    assert.equal(Link({ href: '/about', locale: 'de' }).props.routing, routing);
    assert.equal(hrefOf({ href: '/about', locale: 'de' }), '/de/ueber-uns');
    assert.equal(hrefOf({ href: '/about', locale: 'en' }), '/en/about');
    // After mount on example.de, the href is what that host serves.
    mounted('example.de');
    assert.equal(hrefOf({ href: '/about', locale: 'de' }), '/ueber-uns');
    assert.equal(hrefOf({ href: '/about' }), '/ueber-uns');
    assert.equal(hrefOf({ href: '/about', locale: 'en' }), 'https://example.com/about');
    assert.equal(hrefOf({ href: { pathname: '/blog/[slug]', params: { slug: 'x' } }, locale: 'de' }), '/artikel/x');
    assert.equal(hrefOf({ href: '/about', locale: 'de' }), '/ueber-uns');
    // A host that is not configured keeps the routing as it is without domains.
    mounted('localhost:3000');
    assert.equal(hrefOf({ href: '/about', locale: 'de' }), '/de/ueber-uns');
  } finally {
    server();
  }
});

test('the server-agreed href is the same on every host, so a hydrated Link never differs from the first render', () => {
  const hrefOf = props => NextNavigationClientLink({ ...props, routing }).props.href;
  currentPathname('/');
  server();
  const first = hrefOf({ href: '/about', locale: 'fr' });
  mounted('example.com');
  assert.equal(hrefOf({ href: '/about', locale: 'fr' }), '/fr/a-propos');
  server();
  assert.equal(hrefOf({ href: '/about', locale: 'fr' }), first);
  assert.equal(first, '/fr/a-propos');
});

test('router push and replace resolve the href against the current host', () => {
  const { useRouter } = createNextNavigation(routing);
  const calls = recordingRouter();
  currentPathname('/ueber-uns');
  try {
    mounted('example.de');
    const router = useRouter();
    router.push('/about', { locale: 'en', scroll: false });
    router.replace('/about', { locale: 'de' });
    router.prefetch('/about', { locale: 'fr' });
    assert.deepEqual(calls.map(({ name, href }) => [name, href]), [
      ['push', 'https://example.com/about'],
      ['replace', '/ueber-uns'],
      ['prefetch', 'https://example.com/fr/a-propos'],
    ]);
    assert.deepEqual(calls[0].options, { scroll: false });
  } finally {
    server();
  }
});

test('a language switcher moves between domains with the same internal path', () => {
  const { useRouter, usePathname } = createNextNavigation(routing);
  const calls = recordingRouter();
  try {
    // On example.de the page is /ueber-uns, and the switcher gets the internal path /about.
    mounted('example.de');
    currentPathname('/ueber-uns');
    assert.equal(usePathname(), '/about');
    useRouter().replace(usePathname(), { locale: 'fr' });
    assert.equal(calls.at(-1).href, 'https://example.com/fr/a-propos');
    // On example.com the switcher back to de leaves the domain.
    mounted('example.com');
    currentPathname('/fr/a-propos');
    assert.equal(usePathname(), '/about');
    useRouter().replace(usePathname(), { locale: 'de' });
    assert.equal(calls.at(-1).href, 'https://example.de/ueber-uns');
    // On the same domain the switcher stays relative.
    mounted('example.com');
    currentPathname('/about');
    useRouter().replace(usePathname(), { locale: 'fr' });
    assert.equal(calls.at(-1).href, '/fr/a-propos');
  } finally {
    server();
  }
});

test('a domain without a locale prefix on the current path uses the domain default locale', () => {
  const { getPathname, useRouter } = createNextNavigation(routing);
  const calls = recordingRouter();
  try {
    mounted('example.de');
    currentPathname('/about');
    useRouter().push('/blog/hello');
    assert.equal(calls.at(-1).href, '/artikel/hello');
    assert.equal(getPathname({ href: '/blog/hello', locale: 'de', domain: 'example.de' }), '/artikel/hello');
  } finally {
    server();
  }
});
