import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { configKeys, configWarnings, validateConfig } from '../dist/config.js';
import { temporary } from './helpers.mjs';

const cli = (root, args = []) => {
  const env = { ...process.env };
  for (const key of ['NODE_ENV', 'FORCE_COLOR', 'NO_COLOR']) delete env[key];
  return spawnSync(process.execPath, [resolve('dist/cli.js'), ...args], { cwd: root, encoding: 'utf8', env });
};

test('init next steps name the request file and routing module it scaffolds', async t => {
  for (const [version, requestFile] of [['^16.0.0', 'proxy.ts'], ['^15.0.0', 'middleware.ts']]) {
    const root = await temporary(t);
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: { next: version } }) + '\n');
    const result = cli(root, ['init', '--framework', 'next']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`Next\\.js request boundary: ${requestFile} sets the locale`));
    assert.match(result.stdout, /Shared routing: .*routing\.ts is used by the request file/);
  }
});

test('migrate-project preview lists scaffold, config and package edits', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'legacy'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: { next: '^16.0.0' } }) + '\n');
  await writeFile(join(root, 'legacy/en.json'), JSON.stringify({ Checkout: { title: 'Checkout' } }));
  await writeFile(join(root, 'src/page.tsx'), `const t = useTranslations('Checkout');\nexport const Page = () => t('title');\n`);
  const result = cli(root, ['migrate-project', '--from', 'legacy', '--format', 'i18next', '--source-dir', 'src', '--framework', 'next']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^~ scaffold proxy\.ts$/m);
  assert.match(result.stdout, /^~ config nordbeam-locale\.config\.json$/m);
  assert.match(result.stdout, /^~ package edit package\.json$/m);
});

test('configKeys lists the persisted options and config validation still accepts development', () => {
  assert.ok(configKeys.includes('baseLocale'));
  assert.equal(configKeys.includes('development'), false);
  assert.equal(configKeys.includes('$schema'), false);
  assert.doesNotThrow(() => validateConfig({ $schema: './schema.json', baseLocale: 'en', development: true }));
  assert.deepEqual(configWarnings({ development: true }, 'nordbeam-locale.config.json').map(item => item.code), ['CONFIG_DEVELOPMENT_IGNORED']);
  assert.deepEqual(configWarnings({ baseLocale: 'en' }), []);
});
