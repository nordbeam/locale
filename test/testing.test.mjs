import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageTestHelpers } from '../dist/testing.js';

test('test helpers derive nested keys and render locale matrices', async () => {
  const helpers = createMessageTestHelpers();
  assert.equal(helpers.keyFromSelector(m => m.product.price), 'product.price');
  assert.throws(() => helpers.keyFromSelector(() => undefined), /return one message/);
  const matrix = await helpers.localeMatrix(['en', 'fr'], async locale => ({ messages: { greeting: name => `${locale}:${name}` } }), messages => messages.greeting('Ada'));
  assert.deepEqual(matrix, { en: 'en:Ada', fr: 'fr:Ada' });
});
