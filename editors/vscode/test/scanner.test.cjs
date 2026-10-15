const test = require('node:test');
const assert = require('node:assert/strict');
const { completionContext, findMessageOccurrences, jsonKeyRange, messageCompletions, tokenize, validMessageIdentifiers } = require('../dist/core.js');

const ids = (text, names) => findMessageOccurrences(text, names).map(item => item.id);

test('detects README-style and destructured message bindings', () => {
  assert.deepEqual(ids(`const messages = await loadLocale('en'); messages.greeting(); messages.checkout.pay()`), ['greeting', 'checkout.pay']);
  assert.deepEqual(ids(`const { messages: t } = await loadLocale('en'); t.checkout.pay(); t['odd-key']();`), ['checkout.pay', 'odd-key']);
  assert.deepEqual(ids(`const { messages: m } = await i18n.loadLocale(locale); m.save();`), ['save']);
  assert.deepEqual(ids(`const { messages: m } = await loadCheckout(locale); m.pay();`), ['pay']);
  assert.deepEqual(ids(`const { messages: m } = i18n.useI18n(loader); m.pay();`), ['pay']);
  assert.deepEqual(ids(`const M = i18n.useMessages(loader); M.pay(); const L = useMessages(loader); L.save();`), ['pay', 'save']);
  assert.deepEqual(ids(`const { messages: m }: Props = await loadLocale('en'); m.pay();`), ['pay']);
});

test('ignores unrelated libraries and member calls on other objects', () => {
  assert.deepEqual(ids(`t('legacy'); translate('x'); formatMessage('y'); i18n.m.z(); other.m.w();`), []);
  assert.deepEqual(ids(`const { messages: t } = await loadLocale('en'); const messages = list; t.pay()`), ['pay']);
});

test('skips strings, comments, regex literals and template text but reads interpolations', () => {
  const text = [
    `const s = "m.a.b()"; const u = 'm.c()'; // m.d()`,
    `/* m.e() */ const tpl = \`m.f() \${m.g()} m.h()\`;`,
    `const r = /m.i()/g; const q = a / m.j() / 2; m.k()`,
  ].join('\n');
  assert.deepEqual(ids(text), ['g', 'j', 'k']);
});

test('keeps scanning after JSX text with an apostrophe or closing tags', () => {
  const text = [`<p>Don't {m.a()}</p><p>{m.b()}</p>`, `<span>{m.c()}</span> m.d()`].join('\n');
  assert.deepEqual(ids(text), ['a', 'b', 'c', 'd']);
});

test('handles optional chaining and reports exact key ranges', () => {
  const text = `m?.checkout.pay(); m['checkout']['pay']();`;
  const found = findMessageOccurrences(text);
  assert.deepEqual(found.map(item => item.id), ['checkout.pay', 'checkout.pay']);
  assert.equal(text.slice(found[0].start, found[0].end), 'checkout.pay');
  assert.equal(text.slice(found[1].start, found[1].end), `checkout']['pay`);
});

test('uses configured fallback names and skips builtin member names for them', () => {
  assert.deepEqual(ids(`const list = [1]; messages.map(); messages.pay(); m.set(); t.pay();`, ['messages', 't']), ['pay', 'pay']);
  assert.deepEqual(ids(`messages.map(); m.pay();`, ['m']), ['pay']);
  assert.deepEqual(validMessageIdentifiers(['m', 'bad-name', 'm', 'messages']), ['m', 'messages']);
  assert.deepEqual(validMessageIdentifiers(['bad-name']), ['m', 'messages']);
  assert.deepEqual(validMessageIdentifiers(undefined), ['m', 'messages']);
});

test('completion context covers dot and bracket forms', () => {
  assert.deepEqual(completionContext(`  return m.checkout.pa`), { bracket: false, namespace: ['checkout'], partial: 'pa' });
  assert.deepEqual(completionContext(`m.`), { bracket: false, namespace: [], partial: '' });
  assert.deepEqual(completionContext(`m['check`), { bracket: true, namespace: [], partial: 'check' });
  assert.deepEqual(completionContext(`messages.checkout['pa`), { bracket: true, namespace: ['checkout'], partial: 'pa' });
  assert.equal(completionContext(`xm.checkout.`), undefined);
  assert.equal(completionContext(`m.checkout.pay(`), undefined);
});

test('completion candidates list next segments for dots and full keys for brackets', () => {
  const base = new Map([['checkout.pay', 'Pay'], ['checkout.cart.total', 'Total'], ['save', 'Save']]);
  assert.deepEqual(messageCompletions(base, { bracket: false, namespace: [], partial: '' }), [
    { label: 'checkout', leaf: false, text: undefined },
    { label: 'save', leaf: true, text: 'Save' },
  ]);
  assert.deepEqual(messageCompletions(base, { bracket: false, namespace: ['checkout'], partial: '' }), [
    { label: 'cart', leaf: false, text: undefined },
    { label: 'pay', leaf: true, text: 'Pay' },
  ]);
  assert.deepEqual(messageCompletions(base, { bracket: true, namespace: ['checkout'], partial: '' }).map(item => item.label), ['cart.total', 'pay']);
});

test('finds JSON key ranges for nested IDs', () => {
  const json = `{\n  "checkout": {\n    "pay": "Pay",\n    "cart": { "pay": "Cart pay" }\n  }\n}`;
  const range = jsonKeyRange(json, 'checkout.cart.pay');
  assert.equal(json.slice(range.start, range.end), '"pay"');
  assert.equal(json.slice(range.start).startsWith('"pay": "Cart pay"'), true);
  assert.equal(jsonKeyRange(json, 'missing.key'), undefined);
});

test('tokenizer keeps spread and optional chaining distinct from member access', () => {
  assert.deepEqual(tokenize('...m.a?.b').map(token => token.value), ['...', 'm', '.', 'a', '?.', 'b']);
  assert.deepEqual(ids(`const all = [...m.a()];`), ['a']);
});

test('scans a 5k-line document quickly', () => {
  const line = `const { messages: t } = await loadLocale('en'); t.checkout.pay(); const s = "m.x()"; // m.y()\n`;
  const text = line.repeat(5000);
  const started = performance.now();
  const found = findMessageOccurrences(text);
  const elapsed = performance.now() - started;
  assert.equal(found.length, 5000);
  assert.ok(elapsed < 500, `scan took ${elapsed.toFixed(1)}ms`);
});
