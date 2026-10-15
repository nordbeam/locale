import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('server-safe rich entry renders through real React Flight and locale-only client props serialize', () => {
  const output = execFileSync(process.execPath, [
    '--conditions=react-server',
    'test/fixtures/react-flight.mjs',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'production' },
  });
  const result = JSON.parse(output.trim());
  assert.equal(result.serverRich.ok, true);
  assert.equal(result.loadedCatalogRejected.ok, true);
  assert.equal(result.localeOnlyProvider.ok, true);
});
