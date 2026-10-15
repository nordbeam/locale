import test from 'node:test';
import assert from 'node:assert/strict';
import { defineRouting, getPathname, isRouteHref, localize, toExternalPath, toInternalPath, toInternalPathAny } from '../dist/next-routing.js';

const routing = defineRouting({
  locales: ['en', 'de', 'fr'],
  defaultLocale: 'en',
  localePrefix: 'as-needed',
  pathnames: {
    '/about': { de: '/ueber-uns', fr: '/a-propos' },
    '/blog/new': { de: '/artikel/neu' },
    '/blog/[slug]': { de: '/artikel/[slug]', fr: '/blogue/[slug]' },
    '/docs/[...path]': { de: '/dokumente/[...path]' },
    '/shop/[[...cat]]': { de: '/laden/[[...cat]]' },
  },
});

test('defineRouting returns the same object and accepts routings without pathnames', () => {
  const plain = { locales: ['en', 'fr'], defaultLocale: 'en' };
  assert.equal(defineRouting(plain), plain);
  assert.equal(toExternalPath('/anything/[x]', 'fr', plain), '/anything/[x]');
  assert.equal(toInternalPath('/anything', 'fr', plain), undefined);
});

test('defineRouting rejects invalid locale lists', () => {
  assert.throws(() => defineRouting({ locales: [], defaultLocale: 'en' }), /non-empty locale list containing defaultLocale/);
  assert.throws(() => defineRouting({ locales: ['fr'], defaultLocale: 'en' }), /non-empty locale list containing defaultLocale/);
  assert.throws(() => defineRouting({ locales: ['en', 'en'], defaultLocale: 'en' }), /must be unique/);
});

test('defineRouting rejects malformed internal patterns', () => {
  const cases = [
    ['about', /must start with '\/'/],
    ['/about/', /must not end with '\/'/],
    ['//about', /must start with '\/'/],
    ['/a//b', /invalid segment ''/],
    ['/[slug', /invalid segment/],
    ['/[my-slug]', /invalid segment/],
    ['/a?b', /invalid segment/],
    ['/[...rest]/after', /catch-all segments must be the last segment/],
    ['/[[...rest]]/after', /catch-all segments must be the last segment/],
    ['/[a]/[a]', /repeats a param name/],
  ];
  for (const [source, error] of cases) {
    assert.throws(() => defineRouting({ locales: ['en'], defaultLocale: 'en', pathnames: { [source]: source } }), error, source);
  }
});

test('defineRouting rejects localized variants that do not declare the same params', () => {
  const base = { locales: ['en', 'de'], defaultLocale: 'en' };
  assert.throws(() => defineRouting({ ...base, pathnames: { '/blog/[slug]': { de: '/artikel/[id]' } } }), /must have the same params/);
  assert.throws(() => defineRouting({ ...base, pathnames: { '/blog/[slug]': { de: '/artikel/[...slug]' } } }), /must have the same params/);
  assert.throws(() => defineRouting({ ...base, pathnames: { '/blog/[slug]': { de: '/artikel/[slug]/[x]' } } }), /must have the same params/);
  assert.throws(() => defineRouting({ ...base, pathnames: { '/blog': { de: '/artikel/[x]' } } }), /must have the same params/);
});

test('defineRouting rejects variants for unknown locales and ambiguous localized shapes', () => {
  const base = { locales: ['en', 'de'], defaultLocale: 'en' };
  assert.throws(() => defineRouting({ ...base, pathnames: { '/about': { fr: '/a-propos' } } }), /unknown locale 'fr'/);
  assert.throws(() => defineRouting({ ...base, pathnames: { '/a/[x]': { de: '/same/[x]' }, '/b/[y]': { de: '/same/[y]' } } }), /ambiguous in de/);
  assert.throws(() => defineRouting({ ...base, pathnames: { '/a': { de: '/same' }, '/b': { de: '/same' } } }), /ambiguous in de/);
});

test('a string variant applies to every locale and a missing locale falls back to the internal pattern', () => {
  const shared = defineRouting({ locales: ['en', 'de', 'fr'], defaultLocale: 'en', pathnames: { '/pricing': '/tarifs', '/help': { fr: '/aide' } } });
  assert.equal(toExternalPath('/pricing', 'en', shared), '/tarifs');
  assert.equal(toExternalPath('/pricing', 'de', shared), '/tarifs');
  assert.equal(toExternalPath('/help', 'de', shared), '/help');
  assert.equal(toExternalPath('/help', 'fr', shared), '/aide');
});

test('static, dynamic, catch-all and optional catch-all round-trip through the localized path', () => {
  const cases = [
    ['/about', 'de', '/ueber-uns'],
    ['/blog/hello', 'de', '/artikel/hello'],
    ['/blog/hello', 'fr', '/blogue/hello'],
    ['/docs/a/b/c', 'de', '/dokumente/a/b/c'],
    ['/shop', 'de', '/laden'],
    ['/shop/books/fiction', 'de', '/laden/books/fiction'],
  ];
  for (const [internal, locale, external] of cases) {
    assert.equal(toExternalPath(internal, locale, routing), external, `external ${internal} ${locale}`);
    assert.equal(toInternalPath(external, locale, routing), internal, `internal ${external} ${locale}`);
  }
});

test('unlisted locales and paths keep their internal form', () => {
  assert.equal(toExternalPath('/about', 'en', routing), '/about');
  assert.equal(toExternalPath('/blog/hello', 'en', routing), '/blog/hello');
  assert.equal(toExternalPath('/unlisted', 'de', routing), '/unlisted');
  assert.equal(toInternalPath('/about', 'de', routing), undefined);
  assert.equal(toInternalPath('/unlisted', 'de', routing), undefined);
});

test('the most specific pattern wins: static before dynamic before catch-all', () => {
  assert.equal(toExternalPath('/blog/new', 'de', routing), '/artikel/neu');
  assert.equal(toExternalPath('/blog/other', 'de', routing), '/artikel/other');
  assert.equal(toInternalPath('/artikel/neu', 'de', routing), '/blog/new');
  assert.equal(toInternalPath('/artikel/other', 'de', routing), '/blog/other');
  assert.equal(toInternalPath('/blog/new', 'fr', routing), '/blog/new');

  const ordered = defineRouting({
    locales: ['en', 'de'],
    defaultLocale: 'en',
    pathnames: { '/[...rest]': { de: '/d/[...rest]' }, '/[section]/[id]': { de: '/s/[section]/[id]' }, '/x/[id]': { de: '/x-de/[id]' }, '/x/y': { de: '/x-de/y' } },
  });
  assert.equal(toExternalPath('/x/y', 'de', ordered), '/x-de/y');
  assert.equal(toExternalPath('/x/z', 'de', ordered), '/x-de/z');
  assert.equal(toExternalPath('/q/z', 'de', ordered), '/s/q/z');
  assert.equal(toExternalPath('/q/z/w', 'de', ordered), '/d/q/z/w');
});

test('the optional catch-all matches zero or more segments, and the catch-all needs one', () => {
  assert.equal(toExternalPath('/shop', 'de', routing), '/laden');
  assert.equal(toExternalPath('/docs', 'de', routing), '/docs');
  assert.equal(toInternalPath('/dokumente', 'de', routing), undefined);
  assert.equal(toInternalPath('/dokumente/only', 'de', routing), '/docs/only');
});

test('params are decoded once on input and encoded once per segment on output', () => {
  const segments = ['a%2Fb', 'hello%20world', 'caf%C3%A9', '100%25', '%2541'];
  for (const segment of segments) {
    const fr = toExternalPath(`/blog/${segment}`, 'fr', routing);
    assert.equal(fr, `/blogue/${segment}`, segment);
    assert.equal(toInternalPath(fr, 'fr', routing), `/blog/${segment}`, `round trip ${segment}`);
  }
});

test('already decoded values are encoded once, never decoded again', () => {
  const decoded = [
    ['a/b', 'a%2Fb'],
    ['hello world', 'hello%20world'],
    ['100%', '100%25'],
    ['%41', '%2541'],
    ['café', 'caf%C3%A9'],
    ['日本語', '%E6%97%A5%E6%9C%AC%E8%AA%9E'],
  ];
  for (const [value, encoded] of decoded) {
    const external = getPathname({ href: { pathname: '/blog/[slug]', params: { slug: value } }, locale: 'de' }, routing);
    assert.equal(external, `/de/artikel/${encoded}`, value);
    const internal = toInternalPath(`/artikel/${encoded}`, 'de', routing);
    assert.equal(internal, `/blog/${encoded}`, `internal ${value}`);
    assert.equal(getPathname({ href: { pathname: '/blog/[slug]', params: { slug: decodeURIComponent(encoded) } }, locale: 'en' }, routing), `/blog/${encoded}`);
  }
});

test('catch-all params keep each segment separate, and an encoded slash stays inside one segment', () => {
  assert.equal(getPathname({ href: { pathname: '/docs/[...path]', params: { path: ['a b', 'c/d', '%'] } }, locale: 'de' }, routing), '/de/dokumente/a%20b/c%2Fd/%25');
  assert.equal(toInternalPath('/dokumente/a%20b/c%2Fd/%25', 'de', routing), '/docs/a%20b/c%2Fd/%25');
  assert.equal(getPathname({ href: { pathname: '/shop/[[...cat]]' }, locale: 'de' }, routing), '/de/laden');
});

test('invalid param values are rejected with a clear message', () => {
  const blog = { pathname: '/blog/[slug]' };
  assert.throws(() => getPathname({ href: { ...blog, params: {} }, locale: 'de' }, routing), /needs a non-empty string for param 'slug'/);
  assert.throws(() => getPathname({ href: { ...blog, params: { slug: '' } }, locale: 'de' }, routing), /needs a non-empty string/);
  assert.throws(() => getPathname({ href: { pathname: '/docs/[...path]', params: { path: [] } }, locale: 'de' }, routing), /needs at least one value/);
  assert.throws(() => getPathname({ href: { pathname: '/docs/[...path]', params: { path: ['a', ''] } }, locale: 'de' }, routing), /empty value/);
});

test('getPathname returns the full external href with prefix, localized path, query and hash', () => {
  const cases = [
    [{ href: '/about', locale: 'en' }, '/about'],
    [{ href: '/about', locale: 'de' }, '/de/ueber-uns'],
    [{ href: '/about?x=1#top', locale: 'de' }, '/de/ueber-uns?x=1#top'],
    [{ href: '/', locale: 'en' }, '/'],
    [{ href: '/?x=1', locale: 'en' }, '/?x=1'],
    [{ href: '/', locale: 'fr' }, '/fr'],
    [{ href: { pathname: '/blog/[slug]', params: { slug: 'hello' }, query: { tag: ['a', 'b'], drop: undefined }, hash: 'end' }, locale: 'fr' }, '/fr/blogue/hello?tag=a&tag=b#end'],
    [{ href: { pathname: '/blog/new' }, locale: 'de' }, '/de/artikel/neu'],
    [{ href: { pathname: '/nope/[x]', params: { x: 'a' } }, locale: 'de' }, '/de/nope/a'],
    [{ href: 'https://example.com/about', locale: 'de' }, 'https://example.com/about'],
    [{ href: '#top', locale: 'de' }, '#top'],
  ];
  for (const [input, expected] of cases) assert.equal(getPathname(input, routing), expected, JSON.stringify(input.href));
});

test('getPathname prefix modes follow the routing policy', () => {
  const modes = {
    always: { ...routing, localePrefix: 'always' },
    'as-needed': routing,
    never: { ...routing, localePrefix: 'never' },
  };
  assert.equal(getPathname({ href: '/about', locale: 'en' }, modes.always), '/en/about');
  assert.equal(getPathname({ href: '/about', locale: 'en' }, modes['as-needed']), '/about');
  assert.equal(getPathname({ href: '/about', locale: 'de' }, modes.never), '/ueber-uns');
});

test('localize keeps the prefix mode rules for localized paths', () => {
  const cases = [
    ['/about', 'de', '/de/ueber-uns'],
    ['/de/ueber-uns', 'fr', '/fr/a-propos'],
    ['/fr/a-propos', undefined, '/fr/a-propos'],
    ['/about', false, '/about'],
    ['/about?x=1#h', 'de', '/de/ueber-uns?x=1#h'],
    ['/', 'de', '/de'],
  ];
  for (const [href, locale, expected] of cases) {
    assert.equal(localize(href, locale, null, routing), expected, `${href} ${locale}`);
  }
  assert.equal(localize('/about', undefined, '/de/ueber-uns', routing), '/de/ueber-uns');
  assert.equal(localize('/blog/x', undefined, '/de/artikel/y', routing), '/de/artikel/x');
  assert.equal(localize({ pathname: '/blog/[slug]', params: { slug: 'a b' } }, 'de', null, routing), '/de/artikel/a%20b');
});

test('localize leaves non-route hrefs alone', () => {
  const url = new URL('https://example.com/about');
  assert.equal(localize(url, 'de', null, routing), url);
  for (const href of ['about', '?q=1', '//cdn.example.com/a', 'https://example.com/about', 'mailto:team@example.com']) {
    assert.equal(localize(href, 'de', null, routing), href, href);
  }
  assert.equal(isRouteHref('/about'), true);
  assert.equal(isRouteHref('//about'), false);
  assert.equal(isRouteHref({ query: { a: 1 } }), false);
});

test('toInternalPathAny finds the page under the preferred locale, other locales, or its internal name', () => {
  assert.equal(toInternalPathAny('/ueber-uns', routing), '/about');
  assert.equal(toInternalPathAny('/about', routing), '/about');
  assert.equal(toInternalPathAny('/ueber-uns', routing, 'fr'), '/about');
  assert.equal(toInternalPathAny('/nope', routing), undefined);
  // `/b` is both the internal name of one page and the German name of another: the preferred locale decides.
  const crossed = defineRouting({ locales: ['en', 'de'], defaultLocale: 'en', pathnames: { '/a': { de: '/b' }, '/b': { de: '/c' } } });
  assert.equal(toInternalPathAny('/b', crossed, 'en'), '/b');
  assert.equal(toInternalPathAny('/b', crossed, 'de'), '/a');
});
