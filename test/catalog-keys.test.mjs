import { test } from 'node:test';
import assert from 'node:assert/strict';
import { thenableKeyDiagnostics } from '../dist/key-policy.js';

test('a top-level then key or then namespace warns that the messages object is thenable', () => {
  for (const ids of [['then'], ['greeting', 'then'], ['then.label'], ['then.label', 'then.hint']]) {
    const [warning, ...rest] = thenableKeyDiagnostics(ids);
    assert.equal(rest.length, 0, `one warning for ${JSON.stringify(ids)}`);
    assert.equal(warning.code, 'THENABLE_KEY');
    assert.equal(warning.messageId, 'then');
    assert.equal(warning.hint, 'a `then` member makes the messages object a thenable, so `await messages` never resolves; rename the key or never await the messages object directly');
  }
});

test('then as a nested member or a word prefix does not warn', () => {
  assert.deepEqual(thenableKeyDiagnostics(['greeting', 'thenable', 'nav.then', 'nav.then.label', 'if']), []);
});
