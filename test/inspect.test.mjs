import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { temporary } from './helpers.mjs';

const cli = (root, ...args) => spawnSync(process.execPath, [resolve('dist/cli.js'), ...args], { cwd: root, encoding: 'utf8' });

test('inspect --json returns a versioned read-only project snapshot', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'messages'));
  await writeFile(join(root, 'messages/en.json'), JSON.stringify({ greeting: 'Hello', nested: { empty: '' } }));
  await writeFile(join(root, 'messages/fr.json'), JSON.stringify({ greeting: 'Bonjour', nested: { empty: '' } }));
  await writeFile(join(root, 'nordbeam-i18n.config.json'), JSON.stringify({ baseLocale: 'en', catalogs: 'messages', outDir: 'generated' }));
  const sentinel = join(root, 'keep.txt');
  await writeFile(sentinel, 'preserve');
  const before = await readFile(sentinel, 'utf8');
  const result = cli(root, 'inspect', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.deepEqual({ version: output.version, ok: output.ok }, { version: 1, ok: true });
  assert.equal(output.config.baseLocale, 'en');
  assert.deepEqual(output.locales, ['en', 'fr']);
  assert.equal(output.catalogCount, 2);
  assert.equal(output.catalogs.find(item => item.locale === 'en').messageCount, 2);
  assert.equal(output.catalogs.find(item => item.locale === 'fr').translatedCount, 1);
  assert.equal(output.generated.status, 'missing');
  assert.ok(Array.isArray(output.integrations));
  assert.equal(await readFile(sentinel, 'utf8'), before);
});
