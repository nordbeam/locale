import test from 'node:test';
import assert from 'node:assert/strict';
import { compileProject } from '../dist/compiler.js';
import { JSDOM } from 'jsdom';
import { createMessageInspector, mountInspectorOverlay, scanRenderedText } from '../packages/locale/dist/inspector.js';

async function messagesFor(catalog, extra = {}) {
  const project = compileProject({ baseLocale: 'en', catalogs: { en: catalog }, ...extra });
  const source = project.files['locales/en.js'];
  return (await import(`data:text/javascript,${encodeURIComponent(source)}`)).default;
}

test('inspector records flat and nested generated message calls without changing results', async () => {
  const messages = await messagesFor({ product: { price: 'Price {amount, number}' }, plain: 'Hello' });
  const inspector = createMessageInspector({ locale: 'en', maxEntries: 2 });
  const notifications = [];
  inspector.subscribe(() => notifications.push(inspector.records().length));
  const m = inspector.wrap(messages);
  assert.equal(m.product.price({ amount: 12 }), 'Price 12');
  assert.equal(m.plain(), 'Hello');
  assert.equal(inspector.records().at(-1).key, 'plain');
  assert.equal(inspector.records()[0].key, 'product.price');
  assert.deepEqual(inspector.records()[0].arguments, { amount: 12 });
  assert.equal(inspector.records()[0].locale, 'en');
  assert.equal(inspector.records()[0].result, 'Price 12');
  assert.equal(notifications.length, 2);
  assert.equal(inspector.records().length, 2);
  inspector.clear();
  assert.deepEqual(inspector.records(), []);
});

test('inspector captures failures and can reuse one recorder across locales', async () => {
  const messages = await messagesFor({ greet: 'Hi {name}' }, { development: true });
  const inspector = createMessageInspector({ locale: 'en' });
  const m = inspector.wrap(messages);
  assert.throws(() => m.greet(), /expected message arguments/);
  assert.match(inspector.records()[0].error, /expected message arguments/);
  inspector.setLocale('fr');
  const french = inspector.wrap(messages, inspector.getLocale());
  french.greet({ name: 'Ada' });
  assert.equal(inspector.records().at(-1).locale, 'fr');
});

function fakeDocument() {
  class Element {
    constructor() { this.children = []; this.style = {}; this.textContent = ''; this.attributes = {}; }
    appendChild(child) { this.children.push(child); return child; }
    setAttribute(name, value) { this.attributes[name] = value; }
    remove() { this.removed = true; }
  }
  const document = { body: new Element(), createElement: () => new Element() };
  return { document, Element };
}

function treeText(node) { return String(node.textContent ?? '') + (node.children ?? []).map(treeText).join(''); }

test('browser overlay subscribes, renders records, and disposes without browser globals in Node', async () => {
  const messages = await messagesFor({ product: { price: 'Price {amount}' } });
  const inspector = createMessageInspector({ locale: 'en' });
  const { document } = fakeDocument();
  const overlay = mountInspectorOverlay(inspector, { document });
  assert.equal(document.body.children.length, 1);
  const root = document.body.children[0];
  inspector.wrap(messages).product.price({ amount: 3 });
  assert.equal(treeText(root).includes('product.price'), true);
  overlay.dispose();
  assert.equal(root.removed, true);
});

test('scanRenderedText reports page text that no message rendered', async () => {
  const messages = await messagesFor({ title: 'Invoices', count: 'You have {n} invoices', search: 'Search' });
  const inspector = createMessageInspector({ locale: 'en' });
  const m = inspector.wrap(messages);
  const { document } = new JSDOM(`<body><main>
    <h1>${m.title()}</h1>
    <p id="split"></p>
    <p class="meta">${m.count({ n: 2 })} · 14:05</p>
    <p>${m.count({ n: 3 })} · Updated today</p>
    <form class="search"><input placeholder="${m.search()}"><input placeholder="Filter by customer"><input type="submit" value="Go"></form>
    <button>Save</button>
    <code>npm install</code><pre>Stack trace</pre>
    <span translate="no">Nordbeam Cloud</span><span class="notranslate">Brand name</span>
    <p data-nordbeam-locale-ignore>Debug only</p><p hidden>Not shown</p>
    <p>42</p><p>LinkedIn</p><p>https://nordbeam.io</p>
  </main></body>`).window;
  // React renders "You have {n} invoices" as three text nodes: they are one run.
  document.getElementById('split').append('You have ', '7', ' invoices');
  m.count({ n: 7 });
  const found = scanRenderedText(inspector, { root: document.body });
  assert.deepEqual(found.map(finding => [finding.text, finding.attribute ?? '', finding.path]), [
    ['You have 3 invoices · Updated today', '', 'main > p'],
    ['Filter by customer', 'placeholder', 'main > form.search > input'],
    ['Go', 'value', 'main > form.search > input'],
    ['Save', '', 'main > button'],
  ]);
  assert.deepEqual(scanRenderedText(inspector, { root: document.body, ignore: ['Save', /^Filter/, 'Go', /Updated/] }), []);
});

test('the overlay finds hardcoded text on demand and outlines it', async () => {
  const messages = await messagesFor({ title: 'Invoices' });
  const inspector = createMessageInspector({ locale: 'en' });
  const { document } = new JSDOM(`<body><h1>${inspector.wrap(messages).title()}</h1><button>Save</button></body>`).window;
  const overlay = mountInspectorOverlay(inspector, { document });
  const button = [...overlay.element.querySelectorAll('button')].find(item => item.textContent === 'Find hardcoded text');
  button.click();
  assert.match(overlay.element.textContent, /1 string on this screen did not come from a message/);
  assert.match(overlay.element.textContent, /"Save"/);
  const save = document.querySelector('body > button');
  assert.equal(save.style.outline, '2px dashed #f59e0b');
  overlay.dispose();
  assert.equal(save.style.outline, '');
});
