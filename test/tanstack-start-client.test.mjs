import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { RouterProvider } from '@tanstack/react-router';
import { app, browser } from './tanstack-start-scope-fixture.mjs';

// The router renders its client tree only from TanStack's browser build, so run this
// file with `node --conditions=browser --test test/tanstack-start-client.test.mjs`.
const browserCondition = process.execArgv.includes('--conditions=browser') || process.env.NODE_OPTIONS?.includes('--conditions=browser');
const browserTest = (name, fn) => test(name, { skip: browserCondition ? false : 'run with --conditions=browser' }, fn);

browserTest('navigating out of the scope renders the next page with the full catalog', async t => {
  const document = browser(t, '<html lang="en" data-nordbeam-locale-scope="site"><body><div id="root"></div></body></html>');
  const { router, loads } = app({ shell: false });
  const value = router('/');
  await value.options.hydrate();
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  // Unmount before the DOM globals go away with the test's after hook.
  try {
    await act(async () => { root.render(createElement(RouterProvider, { router: value })); });
    assert.equal(document.querySelector('h1').textContent, 'Welcome');
    await act(() => value.navigate({ to: '/about' }));
    assert.equal(document.querySelector('h1').textContent, 'About');
    assert.deepEqual(loads, ['site:en', 'full:en']);
  } finally {
    await act(() => root.unmount());
  }
});
