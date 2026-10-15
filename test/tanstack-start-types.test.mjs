import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const tsc = (...args) => spawnSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'),
  '--ignoreConfig', '--noEmit', '--strict', '--skipLibCheck', '--lib', 'ES2023,DOM', '--jsx', 'react-jsx', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
  '--target', 'ES2022', ...args], { encoding: 'utf8' });

test('the TanStack Start API is typed by the routing locales and the loader messages', () => {
  const result = tsc(resolve('test/tanstack-start-fixtures/types.tsx'));
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('beforeLoad keeps the root route type independent of the registered router', () => {
  // One checker, in this file order: the typed Link resolves the registered router while the
  // root route's type is still being inferred, which used to report Route and getRouter as circular.
  const fixture = name => resolve('test/tanstack-start-fixtures/registered-router', name);
  const result = tsc('--singleThreaded', fixture('nav.tsx'), fixture('root.tsx'), fixture('router.tsx'));
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
