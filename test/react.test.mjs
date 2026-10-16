import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h, act, StrictMode, Suspense, startTransition, useState } from 'react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { JSDOM } from 'jsdom';
import { createClientI18n, createReactI18n, createSuspenseI18n, rich } from '../dist/react.js';
import { compiled } from './helpers.mjs';

const loaded = locale => ({ locale, messages: { hello: ({ name }) => `${locale}: ${name}` } });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test('React server renders use the matching isolated provider and fail clearly without one', async () => {
  const i18n = createReactI18n(async locale => loaded(locale));
  const other = createReactI18n(i18n.loadLocale);
  function Message() { return h('p', null, i18n.useMessages().hello({ name: 'Ada' })); }
  const render = async locale => renderToString(h(i18n.Provider, { initial: await i18n.loadLocale(locale) }, h(Message)));
  assert.deepEqual(await Promise.all([render('en'), render('fr'), render('ar')]), [
    '<p>en: Ada</p>', '<p>fr: Ada</p>', '<p>ar: Ada</p>',
  ]);
  assert.throws(() => renderToString(h(Message)), /matching i18n.Provider/);
  assert.throws(() => renderToString(h(other.Provider, { initial: loaded('en') }, h(Message))), /matching i18n.Provider/);
});

test('React hydrates, keeps providers isolated, switches without stale races and preserves initial state', async t => {
  const pending = new Map();
  const i18n = createReactI18n(locale => {
    const request = deferred(); pending.set(locale, request); return request.promise;
  });
  const setters = new Map();
  const controlRenders = new Map();
  function Controls({ id }) {
    setters.set(id, i18n.useSetLocale());
    controlRenders.set(id, (controlRenders.get(id) ?? 0) + 1);
    return null;
  }
  function Message({ id }) {
    const { messages, locale, setLocale } = i18n.useI18n();
    assert.equal(setLocale, i18n.useSetLocale());
    assert.equal(locale, i18n.useLocale());
    return h('p', { id, lang: locale }, messages.hello({ name: 'Ada' }));
  }
  const view = (firstLocale = 'en') => h(StrictMode, null,
    h(i18n.Provider, { initial: loaded(firstLocale) }, h(Controls, { id: 'first' }), h(Message, { id: 'first' })),
    h(i18n.Provider, { initial: loaded('ar') }, h(Controls, { id: 'second' }), h(Message, { id: 'second' })),
  );
  const html = renderToString(view());
  const dom = new JSDOM(`<div id="root">${html}</div>`, { url: 'http://localhost/' });
  const restore = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    restore.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  let root;
  t.after(async () => {
    if (root) await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of restore) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  const container = document.getElementById('root');
  const errors = [];
  await act(async () => { root = hydrateRoot(container, view(), { onRecoverableError: error => errors.push(error) }); });
  assert.deepEqual(errors, []);
  assert.equal(container.innerHTML, html);
  const setLocale = setters.get('first');
  const controlCount = controlRenders.get('first');
  const stale = setLocale('fr');
  const fresh = setLocale('ja');
  assert.equal(document.getElementById('first').textContent, 'en: Ada');
  await act(async () => { pending.get('ja').resolve(loaded('ja')); assert.equal(await fresh, true); });
  await act(async () => { pending.get('fr').resolve(loaded('fr')); assert.equal(await stale, false); });
  assert.equal(document.getElementById('first').textContent, 'ja: Ada');
  assert.equal(document.getElementById('second').textContent, 'ar: Ada');
  assert.equal(controlRenders.get('first'), controlCount, 'setter-only controls do not subscribe');
  assert.equal(setters.get('first'), setLocale, 'setter identity stays stable');
  const failing = setLocale('de');
  pending.get('de').reject(new Error('offline'));
  await assert.rejects(failing, /offline/);
  assert.equal(document.getElementById('first').textContent, 'ja: Ada');
  await act(async () => root.render(view('fr')));
  assert.equal(document.getElementById('first').textContent, 'ja: Ada', 'a parent render does not reset the locale');
  assert.deepEqual(errors, []);
});

test('rich React slots hydrate, switch locales and render nested/repeated elements with keys and escaped text',async t=>{
  const project=await compiled(t,{baseLocale:'en',catalogs:{
    en:{welcome:'Hello <link><strong>{name}</strong></link> <strong>again</strong>'},
    fr:{welcome:'<strong>Encore</strong>, bonjour <link><strong>{name}</strong></link>'},
  }});
  const {loadLocale}=await project.load('index.js');
  const i18n=createReactI18n(loadLocale),initial=await loadLocale('en');
  const warnings=[];t.mock.method(console,'error',(...args)=>warnings.push(args.join(' ')));
  let setLocale;
  function Message(){
    const {messages,locale,setLocale:change}=i18n.useI18n();setLocale=change;
    return h('p',{lang:locale},rich(messages.welcome,{name:'<script>alert(1)</script>',
      strong:children=>h('strong',null,children),link:children=>h('a',{href:'/docs'},children)}));
  }
  const view=()=>h(i18n.Provider,{initial},h(Message));
  const html=renderToString(view());
  assert.match(html,/<a href="\/docs"><strong>&lt;script&gt;/);
  const dom=new JSDOM(`<div id="root">${html}</div>`,{url:'http://localhost/'});
  const restore=new Map();let root;
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true})){
    restore.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  }
  t.after(async()=>{if(root)await act(async()=>root.unmount());dom.window.close();for(const [key,descriptor] of restore){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}});
  const container=document.getElementById('root'),errors=[];
  await act(async()=>{root=hydrateRoot(container,view(),{onRecoverableError:error=>errors.push(error)});});
  assert.equal(container.innerHTML,html);
  await act(async()=>{assert.equal(await setLocale('fr'),true);});
  assert.equal(container.querySelector('p').lang,'fr');
  assert.equal(container.querySelector('p').textContent,'Encore, bonjour <script>alert(1)</script>');
  assert.equal(container.querySelectorAll('script').length,0);
  assert.equal(container.querySelectorAll('strong').length,2);
  assert.deepEqual(errors,[]);assert.deepEqual(warnings,[],'React should not report missing keys or hydration errors');
});

test('rich slots preserve arrays, iterables, empty nodes and callback-owned values',async t=>{
  const project=await compiled(t,{baseLocale:'en',catalogs:{en:{message:'Before <outer>A<inner>{name}</inner>Z</outer> after'}}});
  const {message}=(await project.load('locales/en.js')).default;
  const warnings=[];t.mock.method(console,'error',(...args)=>warnings.push(args.join(' ')));
  const em=h('em',null,'X'),bold=h('b',null,'B');
  const nested=Object.freeze(['Y',0]);
  const iterable=new Set([bold,'tail']);
  const nodes=Object.freeze([em,null,false,nested,iterable]);
  const values=Object.freeze({name:'Ada',inner:()=>nodes,outer:children=>h('span',null,children)});
  const html=renderToString(rich(message,values));
  const dom=new JSDOM(`<div>${html}</div>`);t.after(()=>dom.window.close());
  assert.equal(dom.window.document.querySelector('div').textContent,'Before AXY0BtailZ after');
  assert.equal(dom.window.document.querySelector('span').innerHTML,'A<em>X</em>Y<!-- -->0<b>B</b>tail<!-- -->Z');
  assert.deepEqual(nodes,[em,null,false,nested,iterable]);
  assert.deepEqual([...iterable],[bold,'tail']);
  for(const value of [null,undefined,false,true,'',0,'literal']){
    const expected=typeof value==='string'||typeof value==='number'?String(value):'';
    const fragment=renderToString(rich(message,{name:'Ada',inner:()=>value,outer:children=>h('span',null,children)}));
    const wrapper=dom.window.document.createElement('div');wrapper.innerHTML=fragment;
    assert.equal(wrapper.textContent,`Before A${expected}Z after`);
  }
  assert.throws(()=>rich(message,{name:'Ada',inner:()=>({invalid:true}),outer:children=>h('span',null,children)}),/Objects are not valid as a React child/);
  assert.deepEqual(warnings,[],'Complex slot results should not introduce missing-key warnings');
});

test('rich places React elements passed for plain arguments, with or without tags, in development and production output',async t=>{
  for(const development of [true,false]){
    const project=await compiled(t,{baseLocale:'en',development,catalogs:{
      en:{code:'Your code is {code}.',twice:'{code} and {code}',tagged:'Use <link>{code} now</link>, {who}',plural:'{n, plural, one {# use of {code}} other {# uses of {code}}}'},
      sv:{code:'Din kod är {code}.',twice:'{code} och {code}',tagged:'{who}: använd <link>{code} nu</link>',plural:'{n, plural, one {# användning av {code}} other {# användningar av {code}}}'},
    }});
    const warnings=[];const mock=t.mock.method(console,'error',(...args)=>warnings.push(args.join(' ')));
    const code=h('b',{className:'code'},'SAVE10');
    for(const [locale,expected] of [['en',{code:'Your code is <b class="code">SAVE10</b>.',twice:'<b class="code">SAVE10</b> and <b class="code">SAVE10</b>',
      tagged:'Use <a href="/redeem"><b class="code">SAVE10</b> now</a>, <i>Ada</i>',plural:'2 uses of <b class="code">SAVE10</b>'}],
      ['sv',{code:'Din kod är <b class="code">SAVE10</b>.',twice:'<b class="code">SAVE10</b> och <b class="code">SAVE10</b>',
      tagged:'<i>Ada</i>: använd <a href="/redeem"><b class="code">SAVE10</b> nu</a>',plural:'2 användningar av <b class="code">SAVE10</b>'}]]){
      const m=(await project.load(`locales/${locale}.js`)).default;
      const html={
        code:renderToString(rich(m.code,{code})),
        twice:renderToString(rich(m.twice,{code})),
        tagged:renderToString(rich(m.tagged,{code,who:h('i',null,'Ada'),link:children=>h('a',{href:'/redeem'},children)})),
        plural:renderToString(rich(m.plural,{n:2,code})),
      };
      assert.deepEqual(html,expected,`${locale} development=${development}`);
      // Text arguments still render as text, and markup in them stays escaped.
      assert.equal(renderToString(rich(m.code,{code:'<b>'})),locale==='en'?'Your code is &lt;b&gt;.':'Din kod är &lt;b&gt;.');
    }
    mock.mock.restore();
    assert.deepEqual(warnings,[],'Elements in plain arguments should get React keys');
  }
});

test('rich slots retain React portal behavior',async t=>{
  const project=await compiled(t,{baseLocale:'en',catalogs:{en:{message:'Before <slot>Portal text</slot> after'}}});
  const {message}=(await project.load('locales/en.js')).default;
  const dom=new JSDOM('<div id="root"></div><div id="portal"></div>',{url:'http://localhost/'});
  const restore=new Map();let root;
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true})){
    restore.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  }
  t.after(async()=>{if(root)await act(async()=>root.unmount());dom.window.close();for(const [key,descriptor] of restore){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}});
  const warnings=[];t.mock.method(console,'error',(...args)=>warnings.push(args.join(' ')));
  const {createRoot}=await import('react-dom/client');
  await act(async()=>{
    root=createRoot(document.getElementById('root'));
    root.render(rich(message,{slot:children=>createPortal(h('strong',null,children),document.getElementById('portal'))}));
  });
  assert.equal(document.getElementById('root').textContent,'Before  after');
  assert.equal(document.getElementById('portal').innerHTML,'<strong>Portal text</strong>');
  assert.deepEqual(warnings,[]);
});

test('Suspense i18n preloads once, renders the loaded snapshot and isolates factory caches', async () => {
  const requests = new Map();
  const i18n = createSuspenseI18n(async locale => {
    requests.set(locale, (requests.get(locale) ?? 0) + 1);
    return loaded(locale);
  });
  const first = i18n.preload('en');
  assert.equal(i18n.isLoaded('en'), false);
  assert.strictEqual(first, i18n.preload('en'));
  const snapshot = await first;
  assert.equal(i18n.isLoaded('en'), true);
  assert.equal(snapshot.locale, 'en');
  assert.equal(snapshot.messages.hello({ name: 'Ada' }), 'en: Ada');
  function Message() { return h('p', null, i18n.useMessages().hello({ name: 'Ada' })); }
  assert.equal(renderToString(h(i18n.Provider, { locale: 'en' }, h(Message))), '<p>en: Ada</p>');
  assert.throws(() => renderToString(h(Message)), /matching Suspense i18n.Provider/);
  assert.equal(requests.get('en'), 1);

  const other = createSuspenseI18n(async locale => loaded(locale));
  await other.preload('en');
  assert.equal(renderToString(h(other.Provider, { locale: 'en' }, h(() => h('p', null, other.useLocale())))), '<p>en</p>');
});

test('Suspense provider preloads likely client locales after hydration without loading them during SSR', async t => {
  const requests = [];
  const i18n = createSuspenseI18n(async locale => { requests.push(locale); return loaded(locale); });
  await i18n.preload('en');
  const preloadLocales = ['fr', 'ar'];
  function Message() { return h('p', null, i18n.useMessages().hello({ name: 'Ada' })); }
  const view = () => h(i18n.Provider, { locale: 'en', preloadLocales }, h(Message));
  const html = renderToString(view());
  assert.deepEqual(requests, ['en'], 'server rendering must not preload client alternatives');

  const dom = new JSDOM(`<div id="root">${html}</div>`, { url: 'http://localhost/' });
  const restore = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    restore.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  let root;
  t.after(async () => {
    if (root) await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of restore) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  await act(async () => { root = hydrateRoot(document.getElementById('root'), view()); });
  assert.deepEqual(requests, ['en', 'fr', 'ar']);
  assert.equal(i18n.isLoaded('fr'), true);
  assert.equal(i18n.isLoaded('ar'), true);
  await Promise.all([i18n.preload('fr'), i18n.preload('ar')]);
  assert.deepEqual(requests, ['en', 'fr', 'ar'], 'provider and imperative preloads share the locale cache');
  assert.equal(document.getElementById('root').textContent, 'en: Ada');
});

test('Suspense i18n cold renders show fallback then resolve without duplicate loads', async t => {
  const pending = deferred();
  let calls = 0;
  const i18n = createSuspenseI18n(async () => { calls++; return pending.promise; });
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const restore = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    restore.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  let root;
  t.after(async () => {
    if (root) await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of restore) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  const { createRoot } = await import('react-dom/client');
  let fallbacks = 0;
  function Fallback() { fallbacks++; return h('p', null, 'loading'); }
  function Message() { return h('p', null, i18n.useMessages().hello({ name: 'Ada' })); }
  await act(async () => {
    root = createRoot(document.getElementById('root'));
    root.render(h(Suspense, { fallback: h(Fallback) },
      h(i18n.Provider, { locale: 'en' }, h(Message))));
  });
  assert.equal(document.getElementById('root').textContent, 'loading');
  assert.equal(calls, 1);
  await act(async () => pending.resolve(loaded('en')));
  assert.equal(document.getElementById('root').textContent, 'en: Ada');
  assert.equal(fallbacks, 1);
});

test('Suspense i18n transitions keep revealed messages visible and ignore stale resources', async t => {
  const pending = new Map();
  const i18n = createSuspenseI18n(locale => {
    const request = deferred();
    pending.set(locale, request);
    return request.promise;
  });
  await Promise.resolve();
  const initial = i18n.preload('en');
  pending.get('en').resolve(loaded('en'));
  await initial;

  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const restore = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    restore.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  let root, setLocale;
  t.after(async () => {
    if (root) await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of restore) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  function Message() {
    const { locale, messages } = i18n.useI18n();
    return h('p', { lang: locale }, messages.hello({ name: 'Ada' }));
  }
  function App() {
    const [locale, changeLocale] = useState('en');
    setLocale = changeLocale;
    return h(Suspense, { fallback: h('p', null, 'loading') },
      h(i18n.Provider, { locale }, h(Message)));
  }
  const { createRoot } = await import('react-dom/client');
  await act(async () => {
    root = createRoot(document.getElementById('root'));
    root.render(h(App));
  });
  assert.equal(document.getElementById('root').textContent, 'en: Ada');

  await act(async () => { startTransition(() => setLocale('fr')); });
  assert.equal(document.getElementById('root').textContent, 'en: Ada');
  await act(async () => { startTransition(() => setLocale('ja')); });
  pending.get('fr').resolve(loaded('fr'));
  await act(async () => { await i18n.preload('fr'); });
  assert.equal(document.getElementById('root').textContent, 'en: Ada');
  pending.get('ja').resolve(loaded('ja'));
  await act(async () => { await i18n.preload('ja'); });
  assert.equal(document.getElementById('root').textContent, 'ja: Ada');
});

test('Suspense i18n invalidation cannot let an older request overwrite a fresh one', async () => {
  const first = deferred(), second = deferred();
  let calls = 0;
  const i18n = createSuspenseI18n(() => ++calls === 1 ? first.promise : second.promise);
  const stale = i18n.preload('fr');
  i18n.invalidate('fr');
  const fresh = i18n.preload('fr');
  second.resolve({ locale: 'fr', messages: { hello: () => 'fresh' } });
  assert.equal((await fresh).messages.hello({ name: 'Ada' }), 'fresh');
  first.resolve({ locale: 'fr', messages: { hello: () => 'stale' } });
  await stale;
  assert.equal((await i18n.preload('fr')).messages.hello({ name: 'Ada' }), 'fresh');
});

test('Suspense i18n caches loader contract failures as rejected resources', async () => {
  const i18n = createSuspenseI18n(async () => loaded('en'));
  await assert.rejects(i18n.preload('fr'), /Locale loader returned en for fr/);
  await assert.rejects(i18n.preload('fr'), /Locale loader returned en for fr/);
});

test('client i18n owns locale state, preloads after hydration and switches cached locales directly', async t => {
  const requests = [];
  const i18n = createClientI18n(async locale => { requests.push(locale); return loaded(locale); });
  await i18n.preload('en');
  const likelyLocales = ['fr', 'ar'];
  let controller;
  function Message() {
    controller = i18n.useI18n();
    assert.equal(controller.messages, i18n.useMessages());
    assert.equal(controller.locale, i18n.useLocale());
    assert.equal(controller.setLocale, i18n.useSetLocale());
    assert.equal(controller.pending, i18n.usePending());
    return h('p', { lang: controller.locale, 'data-pending': controller.pending },
      controller.messages.hello({ name: 'Ada' }));
  }
  const view = () => h(i18n.Provider, {
    initialLocale: 'en', preload: likelyLocales, fallback: h('p', null, 'loading'),
  }, h(Message));
  const html = renderToString(view());
  assert.deepEqual(requests, ['en'], 'alternate locales must not load during SSR');

  const dom = new JSDOM(`<div id="root">${html}</div>`, { url: 'http://localhost/' });
  const restore = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    restore.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  let root;
  t.after(async () => {
    if (root) await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of restore) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  await act(async () => { root = hydrateRoot(document.getElementById('root'), view()); });
  assert.deepEqual(requests, ['en', 'fr', 'ar']);
  assert.equal(i18n.isLoaded('fr'), true);
  await act(async () => controller.setLocale('fr'));
  assert.equal(document.querySelector('p').textContent, 'fr: Ada');
  assert.equal(document.querySelector('p').dataset.pending, 'false');
});

test('client i18n automatically transitions cold switches, keeps content visible and applies the latest choice', async t => {
  const requests = new Map();
  const i18n = createClientI18n(locale => {
    const request = deferred();
    requests.set(locale, request);
    return request.promise;
  });
  const initial = i18n.preload('en');
  requests.get('en').resolve(loaded('en'));
  await initial;
  let controller;
  function Message() {
    controller = i18n.useI18n();
    return h('p', { lang: controller.locale, 'data-pending': controller.pending },
      controller.messages.hello({ name: 'Ada' }));
  }
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const restore = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    restore.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  let root;
  t.after(async () => {
    if (root) await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of restore) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  const { createRoot } = await import('react-dom/client');
  await act(async () => {
    root = createRoot(document.getElementById('root'));
    root.render(h(i18n.Provider, {
      initialLocale: 'en', fallback: h('p', null, 'loading'),
    }, h(Message)));
  });
  assert.equal(document.querySelector('p').textContent, 'en: Ada');

  await act(async () => controller.setLocale('fr'));
  assert.equal(document.querySelector('p').textContent, 'en: Ada');
  assert.equal(document.querySelector('p').dataset.pending, 'true');
  await act(async () => controller.setLocale('ja'));
  requests.get('fr').resolve(loaded('fr'));
  await act(async () => { await i18n.preload('fr'); });
  assert.equal(document.querySelector('p').textContent, 'en: Ada');
  requests.get('ja').resolve(loaded('ja'));
  await act(async () => { await i18n.preload('ja'); });
  assert.equal(document.querySelector('p').textContent, 'ja: Ada');
  assert.equal(document.querySelector('p').dataset.pending, 'false');
});

test('client i18n loads and preloads only a component-selected message contract', async t => {
  const fullRequests = [];
  const selectedRequests = [];
  const i18n = createClientI18n(async locale => {
    fullRequests.push(locale);
    return { locale, messages: { hello: () => `${locale}: hello`, unused: () => `${locale}: unused` } };
  });
  const loadGreeting = async locale => {
    selectedRequests.push(locale);
    return { locale, messages: { hello: () => `${locale}: hello` } };
  };
  await i18n.preload('en', loadGreeting);
  let controller;
  function Message() {
    controller = i18n.useI18n(loadGreeting);
    return h('p', { lang: controller.locale }, controller.messages.hello());
  }
  const preload = ['fr'];
  const view = () => h(i18n.Provider, { initialLocale: 'en', preload }, h(Message));
  const html = renderToString(view());
  assert.equal(html.includes('en: hello'), true);
  assert.deepEqual(fullRequests, []);

  const dom = new JSDOM(`<div id="root">${html}</div>`, { url: 'http://localhost/' });
  const restore = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    restore.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  let root;
  t.after(async () => {
    if (root) await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of restore) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  await act(async () => { root = hydrateRoot(document.getElementById('root'), view()); });
  assert.deepEqual(selectedRequests, ['en', 'fr']);
  assert.deepEqual(fullRequests, [], 'component preloading must not pull in the full loader');
  assert.equal(i18n.isLoaded('fr', loadGreeting), true);
  await act(async () => controller.setLocale('fr'));
  assert.equal(document.querySelector('p').textContent, 'fr: hello');
  i18n.invalidate('fr', loadGreeting);
  assert.equal(i18n.isLoaded('fr', loadGreeting), false);
});
