import { createElement } from 'react';
import { JSDOM } from 'jsdom';
import { Outlet, createMemoryHistory, createRootRouteWithContext, createRoute, createRouter } from '@tanstack/react-router';
import { createTanStackStartI18n, defineRouting } from '../packages/locale/dist/tanstack-start.js';

const assetsKey = Symbol.for('nordbeam-locale.catalog-assets');
const full = {
  en: { title: () => 'Welcome', about: () => 'About' },
  de: { title: () => 'Willkommen', about: () => 'Ueber uns' },
};
// The scope of the home page leaves out the message only /about shows.
const site = { en: { title: full.en.title }, de: { title: full.de.title } };

export function app({ shell = true } = {}) {
  const loads = [];
  const loader = (name, catalogs, assets) => {
    const load = async locale => { loads.push(`${name}:${locale}`); return { locale, messages: catalogs[locale] }; };
    // What the Vite plugin attaches to each generated loader in a server build.
    Object.defineProperty(load, assetsKey, { value: assets });
    return load;
  };
  const routing = defineRouting({ locales: ['en', 'de'], defaultLocale: 'en', localePrefix: 'as-needed' });
  const i18n = createTanStackStartI18n({
    routing,
    loadLocale: loader('full', full, { en: ['/assets/full-en.js'], de: [] }),
    scopes: { site: loader('site', site, { en: ['/assets/site-en.js'], de: [] }) },
  });
  function Shell({ children }) {
    return createElement('html', i18n.useHtmlAttributes(), createElement('body', null, children));
  }
  const root = createRootRouteWithContext()({
    beforeLoad: i18n.beforeLoad,
    ...(shell ? { shellComponent: Shell } : {}),
    component: () => createElement(i18n.Provider, null, createElement(Outlet)),
  });
  const Message = ({ id }) => createElement('h1', null, i18n.useMessages()[id]());
  const routeTree = root.addChildren([
    createRoute({ getParentRoute: () => root, path: '/', staticData: { i18nScope: 'site' }, component: () => createElement(Message, { id: 'title' }) }),
    createRoute({ getParentRoute: () => root, path: '/about', component: () => createElement(Message, { id: 'about' }) }),
  ]);
  const router = url => createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [url] }), ...i18n.routerOptions() });
  return { i18n, router, loads };
}

export function browser(t, html) {
  const dom = new JSDOM(html, { url: 'http://localhost/' });
  const restore = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, self: dom.window, document: dom.window.document, sessionStorage: dom.window.sessionStorage, scrollTo: () => undefined, IS_REACT_ACT_ENVIRONMENT: true })) {
    restore.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  t.after(() => {
    dom.window.close();
    for (const [key, descriptor] of restore) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  });
  return dom.window.document;
}
