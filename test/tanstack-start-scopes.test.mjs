import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { RouterProvider } from '@tanstack/react-router';
import { app, browser } from './tanstack-start-scope-fixture.mjs';

test('the server renders a page of a scope with the full catalog, names the scope, and hints its catalog', async () => {
  const { router, loads } = app();
  const home = router('/');
  await home.load();
  const html = renderToString(createElement(RouterProvider, { router: home }));
  assert.match(html, /^<html lang="en" dir="ltr" data-nordbeam-locale-scope="site">/);
  assert.match(html, /<link rel="preload" href="\/assets\/site-en\.js"/);
  assert.doesNotMatch(html, /full-en\.js/);
  const about = router('/about');
  await about.load();
  const other = renderToString(createElement(RouterProvider, { router: about }));
  assert.match(other, /^<html lang="en" dir="ltr">/);
  assert.match(other, /href="\/assets\/full-en\.js"/);
  assert.deepEqual(loads, ['full:en']);
});

test('the browser keeps a scope catalog for its pages and takes the full one for any other page', async t => {
  browser(t, '<html lang="en" data-nordbeam-locale-scope="site"><body></body></html>');
  const { i18n, loads } = app();
  await i18n.routerOptions().hydrate();
  assert.deepEqual(loads, ['site:en']);
  const state = { locale: 'en', host: undefined, committed: 'en' };
  const go = (publicHref, scope, preload) => i18n.beforeLoad({
    location: { publicHref }, context: { i18n: state }, preload,
    matches: [{ routeId: '__root__' }, { routeId: '/page', staticData: scope ? { i18nScope: scope } : {} }],
  });
  const current = async locale => Object.keys((await i18n.load(locale)).messages);
  await go('/', 'site');
  assert.deepEqual(loads, ['site:en']);
  // A preload fetches the full catalog, and the page on screen keeps the scope.
  await go('/about', undefined, true);
  assert.deepEqual(loads, ['site:en', 'full:en']);
  assert.deepEqual(await current('en'), ['title']);
  await go('/about');
  assert.deepEqual(await current('en'), ['title', 'about']);
  // The full catalog serves the scope's pages too.
  await go('/', 'site');
  assert.deepEqual(await current('en'), ['title', 'about']);
  // Another locale starts from the scope of the page; a scope the app does not know is the full catalog.
  await go('/de', 'site');
  assert.deepEqual(await current('de'), ['title']);
  await go('/de/docs', 'unknown');
  assert.deepEqual(await current('de'), ['title', 'about']);
  assert.deepEqual(loads, ['site:en', 'full:en', 'site:de', 'full:de']);
});

test('load during hydration waits for the scope the page needs instead of loading the full catalog', async t => {
  browser(t, '<html lang="en" data-nordbeam-locale-scope="site"><body></body></html>');
  const { i18n, loads } = app();
  // An app's own `hydrate` hook that loads the page's locale, as the docs show for subtrees.
  i18n.routerOptions();
  const { messages } = await i18n.load('en');
  assert.deepEqual(Object.keys(messages), ['title']);
  assert.deepEqual(loads, ['site:en']);
});
