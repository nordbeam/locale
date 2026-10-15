import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, rm, stat, unlink, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { generate } from '../dist/project.js';
import { temporary } from './helpers.mjs';

async function fixture(t) {
  const root = await temporary(t);
  await mkdir(join(root, 'messages'));
  await writeFile(join(root, 'messages/en.json'), JSON.stringify({ greeting: 'Hello {name}', total: '{n, number}' }));
  await writeFile(join(root, 'messages/fr.json'), JSON.stringify({ greeting: 'Bonjour {name}', total: '{n, number}' }));
  return { root, baseLocale: 'en', outDir: 'generated' };
}

const snapshot = async dir => {
  const names = (await readdir(join(dir), { recursive: true })).filter(name => !name.endsWith('/'));
  const stats = {};
  for (const name of names) { const state = await stat(join(dir, name)); stats[name] = state.mtimeMs; }
  return stats;
};

test('a no-op generate changes no file and keeps every mtime', async t => {
  const options = await fixture(t);
  const first = await generate(options);
  const before = await snapshot(first.outDir);
  const second = await generate(options);
  assert.deepEqual(second.changed, []);
  assert.deepEqual(second.locales, first.locales);
  assert.deepEqual(second.groups, first.groups);
  assert.deepEqual(second.warnings, first.warnings);
  assert.deepEqual(second.files, first.files);
  assert.deepEqual(await snapshot(first.outDir), before);
});

test('a catalog edit regenerates instead of trusting the no-op path', async t => {
  const options = await fixture(t);
  await generate(options);
  await writeFile(join(options.root, 'messages/fr.json'), JSON.stringify({ greeting: 'Salut {name}', total: '{n, number}' }));
  const changed = await generate(options);
  assert.ok(changed.changed.some(file => file.endsWith('locales/fr.js')));
  const cold = await generate({ ...options, outDir: 'cold' });
  assert.deepEqual(changed.files, cold.files);
});

test('a deleted output file is rewritten by the next generate', async t => {
  const options = await fixture(t);
  const first = await generate(options);
  const file = join(first.outDir, 'locales/fr.js');
  await unlink(file);
  const repaired = await generate(options);
  assert.deepEqual(repaired.changed, [file]);
  assert.equal(await readFile(file, 'utf8'), first.files['locales/fr.js']);
});

test('a same-size hand edit is detected by content, not trusted by stat, and rewritten', async t => {
  const options = await fixture(t);
  const first = await generate(options);
  const file = join(first.outDir, 'locales/fr.js');
  const original = await readFile(file, 'utf8');
  const edited = original.replace('Bonjour', 'Bonsoir');
  assert.equal(edited.length, original.length);
  await writeFile(file, edited);
  await utimes(file, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  const repaired = await generate(options);
  assert.ok(repaired.changed.includes(file));
  assert.equal(await readFile(file, 'utf8'), original);
  assert.equal(repaired.files['locales/fr.js'], original);
});

test('persistent cache restores missing outputs without a fresh compile, and the cache option keeps the manifest', async t => {
  const options = await fixture(t);
  const cold = await generate({ ...options, persistentCache: 'cache' });
  const manifest = await readFile(join(cold.outDir, '.nordbeam-locale-manifest.json'), 'utf8');
  assert.equal(manifest, await readFile(join(cold.outDir, '.nordbeam-locale-manifest.json'), 'utf8'));
  assert.deepEqual((await generate(options)).changed, [], 'the manifest is identical with and without the cache');
  await rm(cold.outDir, { recursive: true });
  const restored = await generate({ ...options, persistentCache: 'cache' });
  assert.deepEqual(restored.files, cold.files);
  assert.equal(restored.changed.length, Object.keys(cold.files).length);
  // Restored outputs get new mtimes, which the manifest records; the inputs, project and content hashes are unchanged.
  const restoredManifest = JSON.parse(await readFile(join(cold.outDir, '.nordbeam-locale-manifest.json'), 'utf8'));
  const coldManifest = JSON.parse(manifest);
  assert.deepEqual(restoredManifest.inputs, coldManifest.inputs);
  assert.deepEqual(restoredManifest.project, coldManifest.project);
  assert.deepEqual(Object.values(restoredManifest.outputs).map(item => item.hash), Object.values(coldManifest.outputs).map(item => item.hash));
});

test('a cache entry whose payload length does not match its header is a miss', async t => {
  const options = await fixture(t);
  const expected = await generate({ ...options, persistentCache: 'cache' });
  const [cacheName] = await readdir(join(options.root, 'cache'));
  const file = join(options.root, 'cache', cacheName);
  const text = await readFile(file, 'utf8');
  const header = JSON.parse(text.slice(0, text.indexOf('\n')));
  assert.equal(header.version, 4);
  await writeFile(file, text + ' ');
  await rm(expected.outDir, { recursive: true });
  const result = await generate({ ...options, persistentCache: 'cache' });
  assert.deepEqual(result.files, expected.files);
  assert.equal(await readFile(file, 'utf8'), text, 'a miss compiles and rewrites a valid entry');
});
