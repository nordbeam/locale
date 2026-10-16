import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import {
  Link,
  RouterProvider,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { createTanStackStartI18n, defineRouting } from '../dist/tanstack-start.js';

const catalogs = {
  en: { title: () => 'Welcome', about: () => 'About' },
  de: { title: () => 'Willkommen', about: () => 'Ueber uns' },
  ar: { title: () => 'مرحبا', about: () => 'حول' },
};

function app(routingOptions, catalogAssets) {
  const loads = [];
  const routing = defineRouting({
    locales: ['en', 'de', 'ar'],
    defaultLocale: 'en',
    localePrefix: 'as-needed',
    pathnames: {
      '/about': { de: '/ueber-uns', ar: '/حول' },
      '/blog/$slug': { de: '/artikel/$slug' },
      '/docs/$': { de: '/dokumente/$' },
    },
    ...routingOptions,
  });
  const loadLocale = async locale => { loads.push(locale); return { locale, messages: catalogs[locale] }; };
  // What the Vite plugin attaches to the generated loader in a server build.
  if (catalogAssets) Object.defineProperty(loadLocale, Symbol.for('nordbeam-locale.catalog-assets'), { value: catalogAssets });
  const i18n = createTanStackStartI18n({ routing, loadLocale });
  const root = createRootRouteWithContext()({
    beforeLoad: i18n.beforeLoad,
    shellComponent: ({ children }) => createElement(Shell, null, children),
    component: () => createElement(i18n.Provider, null, createElement(Page)),
  });
  function Shell({ children }) {
    const html = i18n.useHtmlAttributes();
    return createElement('html', html, createElement('body', null, children));
  }
  function Page() {
    const m = i18n.useMessages();
    return createElement('main', null,
      createElement('h1', null, m.title()),
      createElement(Link, { to: '/about' }, m.about()),
      createElement(Link, { to: '/blog/$slug', params: { slug: 'hi there' } }, 'post'),
      createElement(i18n.LocaleLink, { locale: 'de' }, 'de'),
      createElement(i18n.LocaleLink, { locale: 'ar' }, 'ar'),
      createElement(i18n.LocaleLink, { locale: 'en' }, 'en'));
  }
  const routeTree = root.addChildren([
    createRoute({ getParentRoute: () => root, path: '/', component: () => null }),
    createRoute({ getParentRoute: () => root, path: '/about', component: () => null }),
    createRoute({ getParentRoute: () => root, path: '/blog/$slug', component: () => null }),
    createRoute({ getParentRoute: () => root, path: '/docs/$', component: () => null }),
  ]);
  const router = (url, extra = {}, serverContext) => {
    const value = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: [url] }),
      ...i18n.routerOptions(),
      ...extra,
    });
    if (serverContext) value.options.additionalContext = { serverContext };
    return value;
  };
  return { i18n, routing, router, loads };
}

const render = async router => {
  await router.load();
  return renderToString(createElement(RouterProvider, { router }));
};

test('the rewrite maps public URLs to the unprefixed route tree and records the locale', async () => {
  const { router } = app();
  for (const [url, pathname, locale] of [
    ['/', '/', 'en'],
    ['/about', '/about', 'en'],
    ['/de', '/', 'de'],
    ['/de/ueber-uns', '/about', 'de'],
    ['/de/artikel/hello', '/blog/hello', 'de'],
    ['/de/dokumente/a/b', '/docs/a/b', 'de'],
    ['/ar/%D8%AD%D9%88%D9%84', '/about', 'ar'],
  ]) {
    const value = router(url);
    await value.load();
    assert.equal(value.state.location.pathname, pathname, url);
    assert.equal(value.state.matches[0].context.locale, locale, url);
    assert.equal(value.options.context.i18n.locale, locale, url);
    assert.equal(value.state.location.publicHref, url, url);
  }
});

test('links are built through the output rewrite for the current locale', async () => {
  const { router } = app();
  const german = router('/de/ueber-uns');
  await german.load();
  assert.equal(german.buildLocation({ to: '/about' }).publicHref, '/de/ueber-uns');
  assert.equal(german.buildLocation({ to: '/' }).publicHref, '/de');
  assert.equal(german.buildLocation({ to: '/blog/$slug', params: { slug: 'a b' } }).publicHref, '/de/artikel/a%20b');
  assert.equal(german.buildLocation({ to: '/docs/$', params: { _splat: 'x/y' } }).publicHref, '/de/dokumente/x/y');
  assert.equal(german.buildLocation({ to: '/about', search: { q: 'ä' }, hash: 'h' }).publicHref, '/de/ueber-uns?q=%C3%A4#h');

  const english = router('/about');
  await english.load();
  assert.equal(english.buildLocation({ to: '/about' }).publicHref, '/about');
  assert.equal(english.buildLocation({ to: '/' }).publicHref, '/');
});

test('server rendering writes translated markup, lang, dir and localized links', async () => {
  const { router } = app();
  const english = await render(router('/'));
  assert.match(english, /^<html lang="en" dir="ltr">/);
  assert.match(english, /<h1>Welcome<\/h1>/);
  assert.match(english, /<a href="\/about"[^>]*>About<\/a>/);
  assert.match(english, /<a href="\/blog\/hi%20there"/);

  const german = await render(router('/de/ueber-uns'));
  assert.match(german, /^<html lang="de" dir="ltr">/);
  assert.match(german, /<h1>Willkommen<\/h1>/);
  assert.match(german, /<a [^>]*href="\/de\/ueber-uns"[^>]*>Ueber uns<\/a>/);
  assert.match(german, /<a href="\/de\/artikel\/hi%20there"/);

  const arabic = await render(router('/ar'));
  assert.match(arabic, /^<html lang="ar" dir="rtl">/);
  assert.match(arabic, /<h1>مرحبا<\/h1>/);
});

test('server rendering hints the client chunks of the page catalog, and only that locale', async () => {
  const { router } = app(undefined, { en: ['/assets/en-1.js'], de: ['/assets/de-1.js', '/assets/literals-1.js'], ar: [] });
  const german = await render(router('/de'));
  assert.match(german, /<link rel="preload" href="\/assets\/de-1\.js" as="script" crossorigin="" fetchPriority="low"\/>/);
  assert.match(german, /<link rel="preload" href="\/assets\/literals-1\.js"/);
  assert.doesNotMatch(german, /en-1\.js/);
  assert.doesNotMatch(await render(app().router('/de')), /rel="preload"/);
});

test('LocaleLink points at the current page in each locale', async () => {
  const { router } = app();
  const html = await render(router('/de/artikel/hi%20there'));
  assert.match(html, /<a href="\/de\/artikel\/hi%20there"[^>]*>de<\/a>/);
  assert.match(html, /<a href="\/ar\/blog\/hi%20there"[^>]*>ar<\/a>/);
  assert.match(html, /<a href="\/blog\/hi%20there"[^>]*>en<\/a>/);

  const about = await render(router('/de/ueber-uns?tab=1#x'));
  assert.match(about, /<a href="\/ar\/%D8%AD%D9%88%D9%84\?tab=1#x"/);
  assert.match(about, /<a href="\/about\?tab=1#x"/);
});

test('every request gets its own state, so concurrent renders do not share a locale', async () => {
  const { router } = app();
  const [german, english, arabic] = await Promise.all([render(router('/de')), render(router('/')), render(router('/ar'))]);
  assert.match(german, /<h1>Willkommen<\/h1>/);
  assert.match(german, /href="\/de\/ueber-uns"/);
  assert.match(english, /<h1>Welcome<\/h1>/);
  assert.match(english, /href="\/about"/);
  assert.match(arabic, /dir="rtl"/);
});

test('messages load once per locale and before the first render', async () => {
  const { router, loads } = app();
  await render(router('/de'));
  await render(router('/de/ueber-uns'));
  await render(router('/'));
  assert.deepEqual(loads, ['de', 'en']);
});

test('as-needed treats an unprefixed path as the default locale, whatever the server detected', async () => {
  const { router } = app({ localePrefix: 'as-needed' });
  const value = router('/about', {}, { locale: 'de' });
  await value.load();
  assert.equal(value.state.matches[0].context.locale, 'en');
});

test('never reads the locale from the server context, then from the router state', async () => {
  const { router } = app({ localePrefix: 'never' });
  const value = router('/ueber-uns', {}, { locale: 'de' });
  // The browser starts from the locale of <html lang>; the server reaches beforeLoad with the detected one.
  value.options.context.i18n.locale = 'de';
  await value.load();
  assert.equal(value.state.location.pathname, '/about');
  assert.equal(value.state.matches[0].context.locale, 'de');
  assert.equal(value.buildLocation({ to: '/about' }).publicHref, '/ueber-uns');
  // An unknown detected locale is ignored.
  const unknown = router('/about', {}, { locale: 'xx' });
  await unknown.load();
  assert.equal(unknown.state.matches[0].context.locale, 'en');
  // A locale in the URL is not part of the routes in this mode.
  const arabic = router('/%D8%AD%D9%88%D9%84', {}, { locale: 'ar' });
  arabic.options.context.i18n.locale = 'ar';
  const html = await render(arabic);
  assert.match(html, /^<html lang="ar" dir="rtl">/);
  assert.match(html, /href="\/%D8%AD%D9%88%D9%84"/);
});

test('always requires the prefix to name the locale', async () => {
  const { router } = app({ localePrefix: 'always' });
  const value = router('/de/ueber-uns');
  await value.load();
  assert.equal(value.state.matches[0].context.locale, 'de');
  assert.equal(value.buildLocation({ to: '/about' }).publicHref, '/de/ueber-uns');
  const english = router('/en');
  await english.load();
  assert.equal(english.buildLocation({ to: '/about' }).publicHref, '/en/about');
});

test('domains scope the locales and the prefix rules by host', async () => {
  const domains = [
    { domain: 'example.com', defaultLocale: 'en', locales: ['en', 'ar'] },
    { domain: 'example.de', defaultLocale: 'de', locales: ['de'] },
  ];
  const { router } = app({ localePrefix: 'as-needed', domains });
  const german = createRouter({
    routeTree: router('/').routeTree,
    history: createMemoryHistory({ initialEntries: ['/ueber-uns'] }),
    origin: 'https://example.de',
    ...app({ localePrefix: 'as-needed', domains }).i18n.routerOptions(),
  });
  await german.load();
  assert.equal(german.state.location.pathname, '/about');
  assert.equal(german.buildLocation({ to: '/about' }).publicHref, '/ueber-uns');
});

test('a locale switch marks loaders stale so they run again in the new locale', async () => {
  const { router } = app();
  const value = router('/about');
  await value.load();
  const matches = [{ routeId: '__root__' }, { routeId: '/about', invalid: false }];
  const { i18n } = app();
  const state = { locale: 'en', host: undefined, committed: 'en' };
  await i18n.beforeLoad({ location: { publicHref: '/de/ueber-uns' }, context: { i18n: state }, matches });
  assert.equal(matches[1].invalid, true);
  assert.equal(matches[0].invalid, undefined);
  assert.equal(state.locale, 'de');
  assert.equal(state.committed, 'de');
  // Preloads never change what the router believes about the page.
  const preloaded = [{ routeId: '/about', invalid: false }];
  await i18n.beforeLoad({ location: { publicHref: '/ar' }, context: { i18n: state }, matches: preloaded, preload: true });
  assert.equal(preloaded[0].invalid, false);
  assert.equal(state.committed, 'de');
  // The same locale reloads nothing.
  const same = [{ routeId: '/about', invalid: false }];
  await i18n.beforeLoad({ location: { publicHref: '/de' }, context: { i18n: state }, matches: same });
  assert.equal(same[0].invalid, false);
});

test('the router keeps working without the i18n context', async () => {
  const { i18n } = app();
  const result = await i18n.beforeLoad({ location: { publicHref: '/de/x' }, context: {}, matches: [] });
  assert.deepEqual(result, { locale: 'de' });
});

test('the hydrate hook waits for the catalog of the server-rendered page, and never rejects', async () => {
  const pending = new Map();
  const routing = defineRouting({ locales: ['en', 'de'], defaultLocale: 'en', localePrefix: 'as-needed' });
  const i18n = createTanStackStartI18n({
    routing,
    loadLocale: locale => new Promise((resolve, reject) => pending.set(locale, { resolve: () => resolve({ locale, messages: catalogs[locale] }), reject })),
  });
  // Without a server-rendered page there is nothing to wait for.
  await i18n.routerOptions().hydrate();
  assert.deepEqual([...pending.keys()], []);
  globalThis.document = { documentElement: { lang: 'de' } };
  try {
    const { hydrate } = i18n.routerOptions();
    let done = false;
    const hydrating = hydrate().then(() => { done = true; });
    await new Promise(resolveTick => setImmediate(resolveTick));
    assert.equal(done, false, 'hydrate resolved before the catalog loaded');
    pending.get('de').resolve();
    await hydrating;
    assert.equal(i18n.isLoaded('de'), true);
    // A failed load resolves the hook, so the router still hydrates; the Provider throws the error to the error boundary.
    i18n.invalidate('de');
    const failing = i18n.routerOptions().hydrate();
    pending.get('de').reject(new Error('offline'));
    await failing;
    assert.equal(i18n.isLoaded('de'), false);
  } finally {
    delete globalThis.document;
  }
});

test('a locale mapped by intlLocales renders its tag as lang, and the browser reads it back', async () => {
  const { router } = app({ intlLocales: { de: 'de-CH' } });
  assert.match(await render(router('/de')), /^<html lang="de-CH" dir="ltr">/);
  assert.match(await render(router('/')), /^<html lang="en" dir="ltr">/);
  const routing = defineRouting({ locales: ['en', 'de'], defaultLocale: 'en', localePrefix: 'as-needed', intlLocales: { de: 'de-CH' } });
  const loads = [];
  const i18n = createTanStackStartI18n({ routing, loadLocale: async locale => { loads.push(locale); return { locale, messages: catalogs[locale] }; } });
  globalThis.document = { documentElement: { lang: 'de-CH' } };
  try {
    await i18n.routerOptions().hydrate();
    assert.deepEqual(loads, ['de']);
  } finally {
    delete globalThis.document;
  }
});
