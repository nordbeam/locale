import test from 'node:test';
import assert from 'node:assert/strict';
import { compileProject } from '../dist/compiler.js';
import { createMessageInspector, mountInspectorOverlay } from '../dist/inspector.js';

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
