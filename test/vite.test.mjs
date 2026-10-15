import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, unlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { build, createServer } from 'vite';
import { nordbeamLocale } from '../dist/vite.js';
import { temporary, waitFor } from './helpers.mjs';

async function fixture(t) {
  const root = await temporary(t);
  await mkdir(join(root, 'messages'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'index.html'), '<div id="app"></div><script type="module" src="/src/main.js"></script>');
  await writeFile(join(root, 'messages/en.json'), JSON.stringify({ greeting: 'Hello {name}', checkout: { total: 'EN_CHECKOUT {count}' }, unused: 'EN_UNUSED_SENTINEL {value, number}', plain: 'UNUSED_LITERAL_SENTINEL' }));
  await writeFile(join(root, 'messages/fr.json'), JSON.stringify({ greeting: 'Bonjour {name}', checkout: { total: 'FR_CHECKOUT {count}' }, unused: 'FR_UNUSED_SENTINEL {value, number}' }));
  return root;
}
const plugin = () => nordbeamLocale({ baseLocale: 'en', scopes: { checkout: ['checkout.*'] } });

test('Vite tree-shakes named messages and emits separate locale chunks for a scope', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'src/main.js'), `import { greeting } from './i18n/locales/en.js';import { loadLocale } from './i18n/scopes/checkout/index.js';globalThis.result=greeting({name:globalThis.person});globalThis.loadCheckout=loadLocale;`);
  const result = await build({ root, configFile: false, logLevel: 'silent', plugins: [plugin()], build: { write: false, minify: true } });
  const chunks = result.output.filter(file => file.type === 'chunk');
  const all = chunks.map(file => file.code).join('\n');
  const entry = chunks.find(file => file.isEntry).code;
  assert.match(entry, /Hello/);
  assert.doesNotMatch(entry, /EN_CHECKOUT|FR_CHECKOUT/);
  assert.doesNotMatch(all, /UNUSED_SENTINEL|UNUSED_LITERAL_SENTINEL|Bonjour|icu-messageformat-parser|new Function|eval\(/);
  const en = chunks.find(file => file.code.includes('EN_CHECKOUT'));
  const fr = chunks.find(file => file.code.includes('FR_CHECKOUT'));
  assert.ok(en && fr && en.fileName !== fr.fileName, 'locale messages must be in separate chunks');
  assert.doesNotMatch(en.code, /FR_CHECKOUT/);
  assert.doesNotMatch(fr.code, /EN_CHECKOUT/);
});

test('Vite serves catalog edits and recovers from invalid ICU; locale add/delete updates the loader', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'src/main.js'), `import { greeting } from './i18n/locales/en.js';console.log(greeting({name:'Ada'}));`);
  const server = await createServer({ root, configFile: false, logLevel: 'silent', plugins: [plugin()], server: { host: '127.0.0.1', port: 0 } });
  try {
    await server.listen();
    const origin = server.resolvedUrls.local[0];
    const path = 'src/i18n/locales/en.js';
    assert.match(await (await fetch(new URL(path, origin))).text(), /Hello/);
    const catalogPath = join(root, 'messages/en.json');
    const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
    catalog.greeting = 'Welcome {name}';
    await writeFile(catalogPath, JSON.stringify(catalog));
    await waitFor(async () => (await readFile(join(root, path), 'utf8')).includes('Welcome'), 'catalog edit did not regenerate JS');
    await waitFor(async () => /Welcome/.test(await (await fetch(new URL(path, origin))).text()), 'Vite did not invalidate the served module');
    // Types also refresh when the base schema changes.
    catalog.added = 'Added {value}';
    await writeFile(catalogPath, JSON.stringify(catalog));
    await waitFor(async () => (await readFile(join(root, 'src/i18n/messages.d.ts'), 'utf8')).includes('"added"'), 'new key did not regenerate types');
    const previous = await readFile(join(root, path), 'utf8');
    catalog.greeting = '{broken';
    await writeFile(catalogPath, JSON.stringify(catalog));
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(await readFile(join(root, path), 'utf8'), previous);
    catalog.greeting = 'Recovered {name}';
    await writeFile(catalogPath, JSON.stringify(catalog));
    await waitFor(async () => (await readFile(join(root, path), 'utf8')).includes('Recovered'), 'compiler queue did not recover');
    await waitFor(async () => /Recovered/.test(await (await fetch(new URL(path, origin))).text()), 'Vite did not serve the repaired module');
    // A generation started by an earlier edit can list de.json before the watcher
    // reports it. Deleting the file before then lets the platform watcher merge the
    // create and the delete into no event at all, so wait for the add first.
    let watched = false;
    server.watcher.on('add', file => { if (file.endsWith('/messages/de.json')) watched = true; });
    await writeFile(join(root, 'messages/de.json'), JSON.stringify(catalog));
    await waitFor(async () => (await readFile(join(root, 'src/i18n/index.js'), 'utf8')).includes('"de"'), 'new locale not added');
    await waitFor(async () => watched, 'watcher did not report the new locale');
    await unlink(join(root, 'messages/de.json'));
    await waitFor(async () => !(await readFile(join(root, 'src/i18n/index.js'), 'utf8')).includes('"de"'), 'deleted locale retained');
  } finally {
    await server.close();
  }
});

test('a catalog write that the watcher drops is replayed after its throttle window', async t => {
  const root = await realpath(await fixture(t)), instance = plugin();
  const server = await createServer({ root, configFile: false, logLevel: 'silent', plugins: [instance], server: { watch: null } });
  const file = join(root, 'messages/en.json'), original = JSON.parse(await readFile(file, 'utf8'));
  // chokidar drops a second change to one path within 50 ms; record what the plugin replays.
  const replayed = [], emit = server.watcher.emit.bind(server.watcher);
  server.watcher.emit = (event, path, ...rest) => { if (event === 'change') replayed.push(path); return emit(event, path, ...rest); };
  const context = { environment: server.environments.client };
  try {
    const first = JSON.stringify({ ...original, greeting: 'First {name}' });
    await writeFile(file, first);
    await instance.hotUpdate.call(context, { file, type: 'update', timestamp: 1, modules: [], read: async () => first });
    await writeFile(file, JSON.stringify({ ...original, greeting: 'Second {name}' }));
    await waitFor(() => replayed.includes(file), 'the write after the compiled one was not replayed');
    await waitFor(async () => (await readFile(join(root, 'src/i18n/locales/en.js'), 'utf8')).includes('Second'), 'the replayed write was not compiled');
    replayed.length = 0;
    await instance.hotUpdate.call(context, { file, type: 'update', timestamp: 2, modules: [], read: () => readFile(file, 'utf8') });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.deepEqual(replayed, [], 'an unchanged catalog was replayed');
  } finally { await server.close(); }
});

test('development shutdown drains pending catalog generation and ignores later notifications', async t => {
  const root = await realpath(await fixture(t)), instance = plugin();
  const server = await createServer({ root, configFile: false, logLevel: 'silent', plugins: [instance], server: { watch: null } });
  const file = join(root, 'messages/en.json'), original = JSON.parse(await readFile(file, 'utf8'));
  let release, entered, timeout, update, close;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise((resolve, reject) => {
    entered = resolve;
    timeout = setTimeout(() => reject(new Error('The controlled catalog read did not start')), 5000);
  });
  const context = { environment: server.environments.client };
  const event = { file, type: 'update', timestamp: 1, modules: [], read: async () => {
    entered(); await gate; return JSON.stringify({ ...original, greeting: 'DRAINED {name}' });
  } };
  let settled = false;
  try {
    update = instance.hotUpdate.call(context, event);
    await started;
    close = server.close().then(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(settled, false, 'Server closed while catalog generation could still write');
    release(); await update; await close;
    assert.match(await readFile(join(root, 'src/i18n/locales/en.js'), 'utf8'), /DRAINED/);
    let reads = 0;
    await instance.hotUpdate.call(context, { ...event, timestamp: 2, read: async () => { reads++; return JSON.stringify(original); } });
    assert.equal(reads, 0, 'A late notification restarted generation after shutdown');
  } finally {
    release(); clearTimeout(timeout);
    await update?.catch(() => undefined); await close; await server.close();
  }
});
