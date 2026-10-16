import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h, act, memo } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { createClientI18n } from '../packages/locale/dist/react.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const loaded = locale => wait(10).then(() => ({ locale, messages: { hello: `hello ${locale}` } }));

function useDom(t) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const restore = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    restore.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  t.after(() => {
    dom.window.close();
    for (const [key, descriptor] of restore) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  return dom;
}

test('a cold locale switch renders each useMessages consumer at most twice and useSetLocale consumers never', async t => {
  let root;
  t.after(async () => { if (root) await act(() => root.unmount()); });
  useDom(t);
  const i18n = createClientI18n(loaded);
  await i18n.preload('en');
  const renders = new Map();
  const count = id => renders.set(id, (renders.get(id) ?? 0) + 1);
  let setLocale;
  function Controller() {
    setLocale = i18n.useSetLocale();
    return null;
  }
  // memo keeps each consumer's own props stable, so only context can re-render it.
  const Message = memo(function Message({ id }) {
    count(`message-${id}`);
    return h('span', null, i18n.useMessages().hello);
  });
  const Button = memo(function Button({ id }) {
    count(`button-${id}`);
    i18n.useSetLocale();
    return h('button', null, String(id));
  });
  const children = [h(Controller, { key: 'controller' })];
  for (let id = 0; id < 500; id++) children.push(h(Message, { key: `m${id}`, id }));
  for (let id = 0; id < 100; id++) children.push(h(Button, { key: `b${id}`, id }));

  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(h(i18n.Provider, { initialLocale: 'en' }, ...children)));
  renders.clear();

  await act(async () => setLocale('fr'));
  await act(() => wait(40));
  assert.equal(document.querySelector('span').textContent, 'hello fr');
  const messageRenders = [...renders].filter(([id]) => id.startsWith('message-'));
  const buttonRenders = [...renders].filter(([id]) => id.startsWith('button-'));
  // One suspended attempt in the transition, then one commit with the new locale.
  assert.equal(messageRenders.length, 500);
  assert.ok(messageRenders.every(([, n]) => n <= 2), 'no consumer renders more than twice');
  assert.equal(messageRenders.reduce((sum, [, n]) => sum + n, 0), 1000);
  assert.equal(buttonRenders.length, 0, 'useSetLocale consumers must not re-render on a locale switch');
});

test('a warm locale switch re-renders each useMessages consumer once', async t => {
  let root;
  t.after(async () => { if (root) await act(() => root.unmount()); });
  useDom(t);
  const i18n = createClientI18n(loaded);
  await i18n.preload('en');
  await i18n.preload('fr');
  const renders = new Map();
  let setLocale;
  function Controller() {
    setLocale = i18n.useSetLocale();
    return null;
  }
  const Message = memo(function Message({ id }) {
    renders.set(id, (renders.get(id) ?? 0) + 1);
    return h('span', null, i18n.useMessages().hello);
  });
  const children = [h(Controller, { key: 'controller' })];
  for (let id = 0; id < 500; id++) children.push(h(Message, { key: `m${id}`, id }));
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(h(i18n.Provider, { initialLocale: 'en' }, ...children)));
  renders.clear();
  await act(async () => setLocale('fr'));
  assert.equal(document.querySelector('span').textContent, 'hello fr');
  assert.equal([...renders.values()].reduce((sum, n) => sum + n, 0), 500);
  assert.ok([...renders.values()].every(n => n === 1));
});

test('preloading and registration happen once per loader, not once per consumer', async t => {
  let root;
  t.after(async () => { if (root) await act(() => root.unmount()); });
  useDom(t);
  const requests = [];
  const i18n = createClientI18n(async locale => { requests.push(locale); return loaded(locale); });
  await i18n.preload('en');
  requests.length = 0;
  function Message() {
    return h('span', null, i18n.useMessages().hello);
  }
  const children = [];
  for (let id = 0; id < 500; id++) children.push(h(Message, { key: id }));
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(h(i18n.Provider, { initialLocale: 'en', preload: ['fr'] }, ...children)));
  await act(() => wait(30));
  assert.deepEqual(requests, ['fr']);
});

test('the Provider reads initialLocale only on mount and keeps preload live', async t => {
  let root;
  t.after(async () => { if (root) await act(() => root.unmount()); });
  useDom(t);
  const i18n = createClientI18n(loaded);
  await i18n.preload('en');
  await i18n.preload('fr');
  function Message() {
    return h('span', null, i18n.useLocale());
  }
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(h(i18n.Provider, { initialLocale: 'en' }, h(Message))));
  assert.equal(document.querySelector('span').textContent, 'en');
  await act(async () => root.render(h(i18n.Provider, { initialLocale: 'fr' }, h(Message))));
  assert.equal(document.querySelector('span').textContent, 'en', 'a changed initialLocale must not switch the locale');
});
