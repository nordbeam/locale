import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('typed pathnames check pattern keys, params and locales at the type level', () => {
  const result = spawnSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'),
    '--ignoreConfig', '--noEmit', '--strict', '--skipLibCheck', '--lib', 'ES2023,DOM', '--jsx', 'react-jsx', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    '--target', 'ES2022', resolve('test/next-pathnames-fixtures/pathnames.tsx')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
