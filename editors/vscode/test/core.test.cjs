const test = require('node:test');
const assert = require('node:assert/strict');
const { accessFor, findMessageOccurrences, flattenCatalog, missingLocales, missingReport } = require('../dist/core.js');

test('indexes nested catalogs and typed plus bracket calls', () => {
  assert.deepEqual([...flattenCatalog({ checkout: { pay: 'Pay' } })], [['checkout.pay', 'Pay']]);
  assert.deepEqual(findMessageOccurrences(`m.checkout.pay(); m['odd-key'](); messages["a"]["b"]()`).map(item => item.id), ['checkout.pay', 'odd-key', 'a.b']);
  assert.equal(accessFor('checkout.pay'), 'm.checkout.pay');
  assert.equal(accessFor('odd-key'), 'm["odd-key"]');
  assert.equal(accessFor('odd-key', 'messages'), 'messages["odd-key"]');
});

test('reports locale gaps and the missing-translations report', () => {
  const catalogs = new Map([['en', new Map([['save', 'Save'], ['pay', 'Pay']])], ['fr', new Map([['save', 'Enregistrer']])], ['de', new Map()]]);
  assert.deepEqual(missingLocales('pay', catalogs), ['de', 'fr']);
  assert.deepEqual(missingReport(catalogs, 'en'), [
    { locale: 'de', ids: ['pay', 'save'] },
    { locale: 'fr', ids: ['pay'] },
  ]);
});
