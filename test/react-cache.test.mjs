import test from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { createElement as h, Component, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { createClientI18n, createSuspenseI18n } from '../packages/locale/dist/react.js';

// React exports act only from development builds. Production runs the same flushes without it.
const act = React.act ?? (async run => { await run(); });
const loaded = locale => ({ locale, messages: { hello: () => `${locale}: hello` } });
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

// Mounts into a jsdom document. One cleanup unmounts before the globals are restored.
async function mount(t, element) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const restore = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    restore.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const root = createRoot(dom.window.document.getElementById('root'));
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of restore) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  await act(async () => root.render(element));
  await until(dom.window.document, '#error, #message');
  return { document: dom.window.document, root };
}

// Polls for React's asynchronous work. Production builds do not flush through act.
async function until(document, selector) {
  for (let i = 0; i < 200 && !document.querySelector(selector); i++) {
    await act(async () => { await tick(); });
  }
}

class Boundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() { return this.state.error ? h('p', { id: 'error' }, this.state.error.message) : this.props.children; }
}

test('client i18n rejects a render that creates more than 1000 distinct inline loaders', { timeout: 10000 }, async t => {
  const i18n = createClientI18n(async locale => loaded(locale));
  let loads = 0;
  // An inline loader has a new identity on every render, so each render suspends on a new resource.
  function Inline() {
    const messages = i18n.useMessages(async locale => { loads++; return loaded(locale); });
    return h('p', null, messages.hello());
  }
  const started = Date.now();
  const { document } = await mount(t, h(Boundary, null, h(i18n.Provider, { initialLocale: 'en' }, h(Inline))));
  const message = document.getElementById('error')?.textContent;
  assert.match(message ?? '', /more than 1000 distinct selection loaders/);
  assert.match(message ?? '', /create them once at module scope with selectMessages/);
  assert.ok(loads <= 1001, `loader calls ${loads}`);
  assert.ok(Date.now() - started < 5000, 'the guard must trigger quickly');
});

test('client i18n counts loader identities across explicit preloads', () => {
  const i18n = createClientI18n(async locale => loaded(locale));
  for (let n = 0; n < 1000; n++) void i18n.preload('fr', async locale => loaded(locale));
  assert.throws(
    () => i18n.preload('fr', async locale => loaded(locale)),
    /more than 1000 distinct selection loaders/,
  );
});

test('client i18n releases dropped loader caches', { timeout: 20000, skip: typeof globalThis.gc !== 'function' && 'run with --expose-gc' }, async () => {
  const refs = [];
  // Two factories keep each one under the stable-loader limit while exercising 200 loaders.
  for (const i18n of [createClientI18n(async locale => loaded(locale)), createClientI18n(async locale => loaded(locale))]) {
    for (let n = 0; n < 100; n++) {
      const messages = { n, pad: new Array(1000).fill(n) };
      refs.push(new WeakRef(messages));
      await i18n.preload('en', async locale => ({ locale, messages }));
    }
  }
  for (let k = 0; k < 5; k++) { await tick(); globalThis.gc(); }
  const retained = refs.filter(ref => ref.deref()).length;
  assert.ok(retained <= 5, `${retained} of 200 dropped loader caches are still retained`);
});

test('client i18n invalidate(locale) still clears live loader caches after weak tracking', async () => {
  const i18n = createClientI18n(async locale => loaded(locale));
  let calls = 0;
  const loader = async locale => { calls++; return loaded(locale); };
  await i18n.preload('fr', loader);
  assert.equal(i18n.isLoaded('fr', loader), true);
  i18n.invalidate('fr');
  assert.equal(i18n.isLoaded('fr', loader), false);
  await i18n.preload('fr', loader);
  assert.equal(calls, 2);
});

test('Suspense i18n retries a failed locale after the loader recovers, without invalidate', async () => {
  let fail = true;
  let calls = 0;
  const i18n = createSuspenseI18n(async locale => {
    calls++;
    if (fail) throw new Error('chunk failed');
    return loaded(locale);
  });
  await assert.rejects(i18n.preload('fr'), /chunk failed/);
  fail = false;
  assert.equal((await i18n.preload('fr')).messages.hello(), 'fr: hello');
  assert.equal(calls, 2);
});

test('client i18n retries a failed locale after the loader recovers, without invalidate', async () => {
  let fail = true;
  let calls = 0;
  const i18n = createClientI18n(async locale => {
    calls++;
    if (fail) throw new Error('chunk failed');
    return loaded(locale);
  });
  await assert.rejects(i18n.preload('fr'), /chunk failed/);
  fail = false;
  assert.equal((await i18n.preload('fr')).messages.hello(), 'fr: hello');
  assert.equal(calls, 2);
});

test('Suspense i18n throws a permanent loader failure to the boundary once and does not loop', { timeout: 10000 }, async t => {
  let calls = 0;
  const i18n = createSuspenseI18n(async () => { calls++; throw new Error('offline'); });
  function Message() { return h('p', null, i18n.useMessages().hello()); }
  const { document } = await mount(t, h(Boundary, null,
    h(i18n.Provider, { locale: 'fr' }, h(Suspense, { fallback: null }, h(Message)))));
  assert.equal(document.getElementById('error')?.textContent, 'offline');
  assert.ok(calls <= 3, `loader calls ${calls}`);
});

test('client i18n throws a permanent loader failure to the boundary once and does not loop', { timeout: 10000 }, async t => {
  let calls = 0;
  const i18n = createClientI18n(async () => { calls++; throw new Error('offline'); });
  function Message() { return h('p', null, i18n.useMessages().hello()); }
  const { document } = await mount(t, h(Boundary, null, h(i18n.Provider, { initialLocale: 'fr' }, h(Message))));
  assert.equal(document.getElementById('error')?.textContent, 'offline');
  assert.ok(calls <= 3, `loader calls ${calls}`);
});

test('Suspense i18n renders after a failed locale retry the loader instead of staying poisoned', { timeout: 10000 }, async t => {
  let fail = true;
  let calls = 0;
  const i18n = createSuspenseI18n(async locale => {
    calls++;
    if (fail) throw new Error('chunk failed');
    return loaded(locale);
  });
  function Message() { return h('p', { id: 'message' }, i18n.useMessages().hello()); }
  const view = key => h(Boundary, { key }, h(i18n.Provider, { locale: 'fr' }, h(Suspense, { fallback: null }, h(Message))));
  const { document, root } = await mount(t, view(1));
  assert.equal(document.getElementById('error')?.textContent, 'chunk failed');
  // A later render retries once the failed attempt has been forgotten, as it is between user actions.
  await new Promise(resolve => setTimeout(resolve, 10));
  fail = false;
  await act(async () => root.render(view(2)));
  await until(document, '#message');
  assert.equal(document.getElementById('message')?.textContent, 'fr: hello');
  assert.equal(calls, 2);
});
