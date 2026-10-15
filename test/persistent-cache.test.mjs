import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { generate, createGenerator } from '../dist/project.js';
import { cacheKey } from '../dist/persistent-cache.js';
import { temporary } from './helpers.mjs';

// The envelope is one header line (version, key, payload length) followed by the JSON payload.
async function readCache(file) {
  const text = await readFile(file, 'utf8'), at = text.indexOf('\n');
  return { header: JSON.parse(text.slice(0, at)), project: JSON.parse(text.slice(at + 1)) };
}
async function writeCache(file, { header, project }) {
  const payload = JSON.stringify(project);
  await writeFile(file, JSON.stringify({ ...header, length: payload.length }) + '\n' + payload);
}

async function fixture(t) {
  const root = await temporary(t);
  await mkdir(join(root, 'messages'));
  await writeFile(join(root, 'messages/en.json'), JSON.stringify({ hello: 'Hello {name}', total: '{n, number}' }));
  await writeFile(join(root, 'messages/fr.json'), JSON.stringify({ hello: 'Bonjour {name}', total: '{n, number}' }));
  return { root, baseLocale: 'en', outDir: 'generated', persistentCache: 'cache' };
}

test('persistent artifact reuse preserves full output and repairs output files', async t => {
  const options = await fixture(t);
  const first = await generate(options);
  const directory = join(options.root, 'cache');
  const names = await readdir(directory);
  assert.equal(names.length, 1);
  const cacheFile = join(directory, names[0]);
  const before = await stat(cacheFile);
  const second = await generate(options);
  assert.deepEqual(second.files, first.files);
  assert.deepEqual(second.changed, []);
  assert.equal((await stat(cacheFile)).mtimeMs, before.mtimeMs);
  const file = join(first.outDir, 'locales/fr.js');
  await unlink(file);
  const repaired = await generate(options);
  assert.ok(repaired.changed.includes(file));
  assert.equal(await readFile(file, 'utf8'), first.files['locales/fr.js']);
  await writeFile(file, 'modified externally');
  await generate(options);
  assert.equal(await readFile(file, 'utf8'), first.files['locales/fr.js']);
});

test('cache invalidates inputs/options and remains bounded across edits', async t => {
  const options = await fixture(t);
  await generate(options);
  for (let i = 0; i < 3; i++) {
    await writeFile(join(options.root, 'messages/fr.json'), JSON.stringify({ hello: `Bonjour ${i} {name}`, total: '{n, number}' }));
    const cached = await generate(options);
    const fresh = await generate({ ...options, persistentCache: false });
    assert.deepEqual(cached.files, fresh.files);
    assert.equal((await readdir(join(options.root, 'cache'))).length, 1);
  }
  const changedOptions = { ...options, development: true, timeZone: 'UTC' };
  assert.deepEqual((await generate(changedOptions)).files, (await generate({ ...changedOptions, persistentCache: false })).files);
  await writeFile(join(options.root, 'messages/fr.json'), JSON.stringify({ hello: 'Broken {name' }));
  const output = await readFile(join(options.root, 'generated/locales/fr.js'), 'utf8');
  await assert.rejects(generate(options), /INVALID_ICU/);
  assert.equal(await readFile(join(options.root, 'generated/locales/fr.js'), 'utf8'), output);
});

test('corrupt/unavailable cache is a miss and output ownership still applies', async t => {
  const options = await fixture(t);
  const expected = await generate(options);
  const cacheFile = join(options.root, 'cache', (await readdir(join(options.root, 'cache')))[0]);
  const valid = await readFile(cacheFile, 'utf8');
  for (const bad of ['{broken', '{"version":1,"key":"incorrect"}']) {
    await writeFile(cacheFile, bad);
    assert.deepEqual((await generate(options)).files, expected.files);
  }
  // A fresh run with verified outputs does not rewrite the cache, so restore a valid entry first.
  await writeFile(cacheFile, valid);
  // A payload whose shape is wrong is a miss; the output is compiled again.
  const record = await readCache(cacheFile);
  record.project.files = 'not files';
  await writeCache(cacheFile, record);
  assert.deepEqual((await generate(options)).files, expected.files);
  await writeFile(join(options.root, 'not-a-directory'), 'untouched');
  assert.deepEqual((await generate({ ...options, persistentCache: 'not-a-directory' })).files, expected.files);
  await unlink(join(expected.outDir, '.nordbeam-locale-manifest.json'));
  await assert.rejects(generate(options), /unowned output/);
  assert.equal(await readFile(join(expected.outDir, 'locales/fr.js'), 'utf8'), expected.files['locales/fr.js']);
});

test('cache restore rejects self-consistent unsafe relative file paths', async t => {
  const options = await fixture(t);
  const expected = await generate(options);
  const cacheFile = join(options.root, 'cache', (await readdir(join(options.root, 'cache')))[0]);
  const record = await readCache(cacheFile);
  record.project.files['../outside.js'] = record.project.files['locales/en.js'];
  await writeCache(cacheFile, record);
  const result = await generate(options);
  assert.deepEqual(result.files, expected.files);
  await assert.rejects(readFile(join(options.root, 'outside.js')), { code: 'ENOENT' });
});

test('cache ignores previous envelope formats and regenerates identical output', async t => {
  const options = await fixture(t);
  const expected = await generate(options);
  const cacheFile = join(options.root, 'cache', (await readdir(join(options.root, 'cache')))[0]);
  const current = await readCache(cacheFile);
  const payload = JSON.stringify(current.project);
  await writeFile(cacheFile, JSON.stringify({ version: 1, key: current.header.key, digest: 'unused', payload }));
  const restored = await generate(options);
  assert.deepEqual(restored.files, expected.files);
  assert.deepEqual(restored.changed, []);
});

test('cache keys distinguish option semantics and bypass accessor/non-data options', async () => {
  const sources = [{ file: '/example/en.json', text: '{}' }];
  const keys = await Promise.all([{}, { x: undefined }, { x: null }, { x: NaN }, { x: Infinity }, { x: -0 }, { x: 0 }].map(o => cacheKey(o, sources, '/example/out')));
  assert.equal(new Set(keys).size, keys.length);
  let reads = 0;
  const option = { get x() { reads++; return 1; } };
  assert.equal(await cacheKey(option, sources, '/example/out'), undefined);
  assert.equal(reads, 0);
  assert.equal(await cacheKey({ x: () => 1 }, sources, '/example/out'), undefined);
});

test('watch generation uses its existing memory cache and validates cache option', async t => {
  const options = await fixture(t);
  const run = createGenerator(options);
  await run();
  await assert.rejects(readdir(join(options.root, 'cache')), { code: 'ENOENT' });
  for (const persistentCache of ['', 1, {}]) await assert.rejects(generate({ ...options, persistentCache }), /persistentCache/);
  await assert.rejects(generate({ ...options, persistentCache: 'messages' }), /catalog directory/);
  await assert.rejects(generate({ ...options, persistentCache: 'messages/cache' }), /catalog directory/);
  await assert.rejects(generate({ ...options, persistentCache: 'generated/cache' }), /output directory/);
});
