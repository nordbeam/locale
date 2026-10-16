import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, unlink, stat, access, rm, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { generate, createGenerator } from '../dist/project.js';
import { temporary } from './helpers.mjs';

async function fixture(t) {
  const root = await temporary(t);
  await mkdir(join(root, 'messages'));
  await writeFile(join(root, 'messages/en.json'), JSON.stringify({ greeting: 'Hello {name}', cart: { items: '{count, plural, one {# item} other {# items}}' } }));
  await writeFile(join(root, 'messages/fr.json'), JSON.stringify({ greeting: 'Salut {name}', cart: { items: '{count, plural, one {# article} other {# articles}}' } }));
  return root;
}

test('generation preserves unchanged mtimes, deletes stale owned files and retains unrelated files', async t => {
  const root = await fixture(t);
  const options = { root, baseLocale: 'en', outDir: 'generated', scopes: { cart: ['cart.*'] } };
  const first = await generate(options);
  const file = join(root, 'generated/locales/en.js');
  const before = (await stat(file)).mtimeMs;
  await writeFile(join(root, 'generated/notes.txt'), 'keep me');
  const same = await generate(options);
  assert.equal(same.changed.length, 0);
  assert.equal((await stat(file)).mtimeMs, before);
  assert.ok(first.changed.length > 0);
  await unlink(join(root, 'messages/fr.json'));
  await generate({ ...options, scopes: {} });
  await assert.rejects(access(join(root, 'generated/locales/fr.js')), { code: 'ENOENT' });
  await assert.rejects(access(join(root, 'generated/scopes/cart/index.js')), { code: 'ENOENT' });
  await assert.rejects(access(join(root, 'generated/scopes/cart/messages.d.ts')), { code: 'ENOENT' });
  assert.equal(await readFile(join(root, 'generated/notes.txt'), 'utf8'), 'keep me');
});

test('runtime artifact generation removes stale declarations and can restore typed output', async t => {
  const root = await fixture(t);
  const options = { root, baseLocale: 'en', outDir: 'generated' };
  await generate(options);
  await access(join(root, 'generated/index.d.ts'));
  const runtime = await generate({ ...options, artifacts: 'runtime' });
  assert.equal(Object.keys(runtime.files).some(file => file.endsWith('.d.ts') || file.endsWith('.d.ts.map')), false);
  await assert.rejects(access(join(root, 'generated/index.d.ts')), { code: 'ENOENT' });
  const restored = await generate(options);
  assert.ok(restored.changed.some(file => file.endsWith('index.d.ts')));
  await access(join(root, 'generated/index.d.ts'));
});

test('loader-typed generation removes public locale modules but keeps loader declarations', async t => {
  const root = await fixture(t);
  const options = { root, baseLocale: 'en', outDir: 'generated' };
  await generate(options);
  const loader = await generate({ ...options, artifacts: 'loader-typed' });
  assert.ok(loader.files['messages.d.ts']);
  assert.ok(loader.files['index.d.ts']);
  await assert.rejects(access(join(root, 'generated/locales/en.js')), { code: 'ENOENT' });
  await assert.rejects(access(join(root, 'generated/locales/en.d.ts')), { code: 'ENOENT' });
  await access(join(root, 'generated/internal/locales/en.js'));
  await access(join(root, 'generated/index.d.ts'));
  await generate(options);
  await access(join(root, 'generated/locales/en.js'));
});

test('bad input leaves the previous output intact and unowned destinations are protected', async t => {
  const root = await fixture(t);
  const options = { root, baseLocale: 'en', outDir: 'generated' };
  await generate(options);
  const previous = await readFile(join(root, 'generated/locales/en.js'), 'utf8');
  await writeFile(join(root, 'messages/en.json'), '{broken');
  await assert.rejects(generate(options), /INVALID_JSON/);
  assert.equal(await readFile(join(root, 'generated/locales/en.js'), 'utf8'), previous);
  await writeFile(join(root, 'messages/en.json'), JSON.stringify({ greeting: 'Hello {name}', cart: { items: '{count, plural, one {# item} other {# items}}' } }));
  await mkdir(join(root, 'unowned'));
  await writeFile(join(root, 'unowned/index.js'), 'user code');
  await assert.rejects(generate({ ...options, outDir: 'unowned' }), /Refusing to overwrite unowned/);
  assert.equal(await readFile(join(root, 'unowned/index.js'), 'utf8'), 'user code');
  await assert.rejects(generate({ ...options, outDir: 'messages' }), /Catalogs cannot be inside/);
});

test('large output preflight finishes before writes and recovers ordered destination errors', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'messages'));
  const catalog = { m: Object.fromEntries(Array.from({ length: 6000 }, (_, i) => [`k${i}`, `Before ${i}`])) };
  const source = join(root, 'messages/en.json');
  await writeFile(source, JSON.stringify(catalog));
  const run = createGenerator({ root, baseLocale: 'en', scopes: { all: ['m.*'] } });
  const initial = await run(), names = Object.keys(initial.files).sort();
  assert.ok(names.length > 64);
  const locale = join(initial.outDir, 'locales/en.js');
  const previous = await readFile(locale, 'utf8');
  const manifest = join(initial.outDir, '.nordbeam-locale-manifest.json');
  const ownership = await readFile(manifest, 'utf8');
  const blocked = names.filter(name => name.startsWith('types/') && name.endsWith('.d.ts')).slice(-2);
  for (const name of blocked) { const file = join(initial.outDir, name); await unlink(file); await mkdir(file); }
  catalog.m.k0 = 'After'; await writeFile(source, JSON.stringify(catalog));
  const unchanged = async () => {
    assert.equal(await readFile(locale, 'utf8'), previous);
    assert.equal(await readFile(manifest, 'utf8'), ownership);
  };
  for (const name of blocked) {
    await assert.rejects(run(), error => error.message.includes(join(initial.outDir, name)) && error.message.includes('Refusing to overwrite'));
    await unchanged();
    await rm(join(initial.outDir, name), { recursive: true });
    await writeFile(join(initial.outDir, name), initial.files[name]);
  }
  const repaired = await run();
  assert.equal(repaired.files['locales/en.js'], await readFile(locale, 'utf8'));
  assert.notEqual(repaired.files['locales/en.js'], previous);
  assert.deepEqual(repaired.changed, [...repaired.changed].sort(), 'parallel writes retain deterministic changed ordering');
  assert.deepEqual((await run()).changed, []);

  // A filesystem rejection late in the output set must also precede all
  // writes, and leave the serialized generation session usable after repair.
  const types = join(initial.outDir, 'types'), saved = join(initial.outDir, 'saved-types');
  // The manifest now records the input digest, so it legitimately follows the repaired catalog.
  const repairedManifest = await readFile(manifest, 'utf8');
  await rename(types, saved); await writeFile(types, 'blocked parent');
  catalog.m.k0 = 'After filesystem repair'; await writeFile(source, JSON.stringify(catalog));
  await assert.rejects(run(), { code: 'ENOTDIR' });
  assert.equal(await readFile(locale, 'utf8'), repaired.files['locales/en.js']);
  assert.equal(await readFile(manifest, 'utf8'), repairedManifest);
  await unlink(types); await rename(saved, types);
  const final = await run();
  assert.match(await readFile(locale, 'utf8'), /After filesystem repair/);
  assert.deepEqual(final.files, (await generate({ root, baseLocale: 'en', scopes: { all: ['m.*'] } })).files);
  assert.deepEqual((await run()).changed, []);
});

test('generated declarations enforce keys, required arguments, number types, locales and scopes', async t => {
  const root = await fixture(t);
  await generate({ root, baseLocale: 'en', outDir: 'generated', scopes: { cart: ['cart.*'] } });
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'consumer.ts'), `
import { loadLocale, selectMessages } from './generated/index.js';
import { greeting } from './generated/locales/en.js';
import { greeting as frenchGreeting } from './generated/locales/fr.js';
import french from './generated/locales/fr.js';
import scoped from './generated/scopes/cart/locales/fr.js';
import { loadLocale as loadCart } from './generated/scopes/cart/index.js';
import { createLocaleStore } from ${JSON.stringify(resolve('packages/locale/dist/index.js'))};
import { createClientI18n, createReactI18n } from ${JSON.stringify(resolve('packages/locale/dist/react.js'))};
const initial = await loadLocale('en');
const m = initial.messages;
const scopedItems = scoped['cart.items'];
m.greeting({ name: 'Ada' });
greeting({ name: 'Ada' });
frenchGreeting({ name: 'Ada' });
french.greeting({ name: 'Ada' });
scopedItems({ count: 2 });
// @ts-expect-error locale re-exports preserve required arguments
frenchGreeting({});
// @ts-expect-error scoped re-exports preserve number types
scopedItems({ count: 'two' });
m['cart.items']({ count: 2 });
m.cart.items({ count: 2 });
// @ts-expect-error missing required name
m.greeting({});
// @ts-expect-error number is required
m['cart.items']({ count: 'two' });
// @ts-expect-error unknown message
m.missing();
// @ts-expect-error unsupported locale
loadLocale('de');
// @ts-expect-error extra values are rejected on object literals
m.greeting({ name: 'Ada', wrong: 'value' });
const cart = await loadCart('fr');
cart.messages['cart.items']({ count: 2 });
cart.messages.cart.items({ count: 2 });
// @ts-expect-error not in the selected scope
cart.messages.greeting({ name: 'Ada' });
const store = createLocaleStore({ initial, loadLocale });
store.getMessages().greeting({ name: 'Ada' });
await store.setLocale('fr');
// @ts-expect-error store keeps the generated locale union
store.setLocale('de');
const loadSelected = selectMessages('greeting');
const selected = await loadSelected('fr');
selected.messages.greeting({ name: 'Ada' });
const selectedCart = await selectMessages('cart.items')('fr');
selectedCart.messages.cart.items({ count: 2 });
// @ts-expect-error selection excludes other valid catalog IDs
selected.messages['cart.items']({ count: 3 });
// @ts-expect-error selection preserves required arguments
selected.messages.greeting({});
// @ts-expect-error invalid selection
selectMessages('missing');
// @ts-expect-error namespace prefixes are not message IDs
selectMessages('cart');
// @ts-expect-error empty selection
selectMessages();
const selectedStore = createLocaleStore({ initial: await loadSelected('en'), loadLocale: loadSelected });
await selectedStore.setLocale('fr');
// @ts-expect-error selection preserves locale union
selectedStore.setLocale('unknown');
const react = createReactI18n(loadSelected);
react.useMessages().greeting({name: 'Ada'});
react.useI18n().setLocale('fr');
const locale: 'en' | 'fr' = react.useLocale();
const props: Parameters<typeof react.Provider>[0] = {initial: selected};
// @ts-expect-error React hooks preserve selected keys
react.useMessages()['cart.items']({count: 2});
// @ts-expect-error React hooks preserve required arguments
react.useMessages().greeting({});
// @ts-expect-error React hooks preserve locale union
react.useSetLocale()('de');
// @ts-expect-error Provider initial data must have the selected messages
const badProps: Parameters<typeof react.Provider>[0] = {initial: {locale: 'en', messages: {}}};
const client = createClientI18n(loadSelected);
client.useMessages().greeting({name: 'Ada'});
client.useI18n().setLocale('fr');
const clientLocale: 'en' | 'fr' = client.useLocale();
const clientProps: Parameters<typeof client.Provider>[0] = {initialLocale: 'en', preload: ['fr'], fallback: null};
client.useMessages(loadSelected).greeting({name: 'Ada'});
client.useI18n(loadSelected).messages.greeting({name: 'Ada'});
await client.preload('fr', loadSelected);
client.isLoaded('fr', loadSelected);
// @ts-expect-error Client hooks preserve selected keys
client.useMessages()['cart.items']({count: 2});
// @ts-expect-error Component-selected hooks preserve selected keys
client.useMessages(loadSelected)['cart.items']({count: 2});
// @ts-expect-error Client hooks preserve required arguments
client.useMessages().greeting({});
// @ts-expect-error Client locale setters preserve the locale union
client.useSetLocale()('de');
// @ts-expect-error Client Provider locales preserve the locale union
const badClientProps: Parameters<typeof client.Provider>[0] = {initialLocale: 'de'};
`);
  const result = spawnSync(resolve('node_modules/.bin/tsc'), ['--ignoreConfig', '--noEmit', '--strict', '--skipLibCheck', '--module', 'nodenext', '--target', 'es2022', join(root, 'consumer.ts')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('CLI config paths resolve relative to the config file and errors exit nonzero', async t => {
  const root = await fixture(t);
  const config = join(root, 'nordbeam-i18n.config.json');
  await writeFile(config, JSON.stringify({ baseLocale: 'en', outDir: 'generated' }));
  const stdout = execFileSync(process.execPath, [resolve('dist/cli.js'), '--config', config], { encoding: 'utf8' });
  assert.match(stdout, /2 locales/);
  await access(join(root, 'generated/index.d.ts'));
  await writeFile(join(root, 'messages/fr.json'), '{}');
  const result = spawnSync(process.execPath, [resolve('dist/cli.js'), '--config', config, '--strict'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /MISSING_MESSAGE/);
});
