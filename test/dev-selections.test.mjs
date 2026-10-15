import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, unlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import { nordbeamLocale } from '../dist/vite.js';
import { temporary, waitFor } from './helpers.mjs';

const source = (key, extra = '') => `${extra}import {selectMessages} from './i18n/index.js';export const load=selectMessages('common','${key}');if(import.meta.hot)import.meta.hot.accept();`;
async function fixture(t, plugins = []) {
  const root = await realpath(await temporary(t));
  await mkdir(join(root, 'messages')); await mkdir(join(root, 'src')); await writeFile(join(root, 'package.json'), '{"type":"module"}');
  const en = { common: 'Common {name}', older: 'Old {name}', newer: 'New {name}' }, fr = { ...en, common: 'Commun {name}' };
  const save = locale => writeFile(join(root, `messages/${locale}.json`), JSON.stringify(locale === 'en' ? en : fr));
  await save('en'); await save('fr'); await writeFile(join(root, 'src/b.ts'), source('older'));
  const events = [], sent = [], plugin = nordbeamLocale(), hotUpdate = plugin.hotUpdate;
  plugin.hotUpdate = async function (ctx) {
    try {
      const result = await hotUpdate.call(this, ctx);
      events.push({ file: ctx.file, environment: this.environment.name, ids: (result ?? ctx.modules).map(module => module.id) });
      return result;
    } catch (error) { events.push({ file: ctx.file, environment: this.environment.name, error: error.message }); throw error; }
  };
  const server = await createServer({ root, configFile: false, logLevel: 'silent', plugins: [...plugins, plugin], server: { host: '127.0.0.1', port: 0 } });
  const send = server.environments.client.hot.send.bind(server.environments.client.hot);
  server.environments.client.hot.send = (...args) => { if (typeof args[0] === 'object') sent.push(args[0]); return send(...args); };
  t.after(() => server.close()); await server.listen();
  const request = async (path, status = 200) => { const response = await fetch(new URL(path, server.resolvedUrls.local[0])); const text = await response.text(); assert.equal(response.status, status, text); return text; };
  const client = async () => {
    const text = await request('/src/b.ts'), loader = text.match(/from\s+"([^"\n]*virtual:nordbeam-locale\/selection\/[^"\n]+)"/)[1];
    const code = await request(loader);
    const paths = Object.fromEntries([...code.matchAll(/import\("([^"\n]+\/(en|fr)(?:\?[^"\n]*)?)"\)/g)].map(match => [match[2], match[1]]));
    assert.deepEqual(Object.keys(paths).sort(), ['en', 'fr']);
    for (const path of Object.values(paths)) await request(path);
    return { loader, ...paths };
  };
  const ssr = async () => { const module = await server.ssrLoadModule('/src/b.ts'); await module.load('en'); await module.load('fr'); return module; };
  const id = path => decodeURIComponent(path).replace('/@id/__x00__', '\0');
  const node = (environment, path) => server.environments[environment].moduleGraph.getModuleById(id(path));
  const change = async (file, action) => {
    await delay(75); events.length = 0; sent.length = 0; await action();
    await waitFor(() => events.some(event => event.file === join(root, file) && event.environment === 'ssr'), `No update for ${file}`); await delay(0);
  };
  return { root, en, fr, server, events, sent, save, request, client, ssr, node, change };
}

test('retired development selections avoid unrelated reloads and keep delayed HTTP/SSR requests correct', async t => {
  const f = await fixture(t), old = await f.client(), oldSSR = await f.ssr();
  await f.change('src/b.ts', () => writeFile(join(f.root, 'src/b.ts'), source('newer')));
  const current = await f.client();
  // SSR has not requested the changed source yet. Its old selection remains
  // relevant, while the client must not reload because of that SSR dependency.
  await f.change('messages/fr.json', () => { f.fr.older = 'Edited old {name}'; return f.save('fr'); });
  assert.equal(f.sent.filter(event => event.type === 'full-reload').length, 0);
  assert.ok(f.events.some(event => event.environment === 'ssr' && event.ids?.includes(f.node('ssr', old.fr).id)));
  assert.ok(!f.events.some(event => event.environment === 'client' && event.ids?.includes(f.node('client', old.fr).id)));
  assert.match(await f.request(old.fr), /Edited old/);
  assert.equal((await oldSSR.load('fr')).messages.older({ name: 'Ada' }), 'Edited old Ada');
  assert.deepEqual(Object.keys((await (await f.ssr()).load('fr')).messages), ['common', 'newer']);
  await waitFor(() => ['client', 'ssr'].every(environment => !f.node(environment, old.en).transformResult), 'Old selected code was retained');
  await f.change('messages/fr.json', () => { f.fr.older = 'Edited again {name}'; return f.save('fr'); });
  assert.equal(f.sent.filter(event => event.type === 'full-reload').length, 0);
  assert.ok(f.events.filter(event => event.file.endsWith('/fr.json')).every(event => !event.ids?.some(id => id?.startsWith('\0virtual:nordbeam-locale/'))));
  assert.match(await f.request(old.fr), /Edited again/);
  assert.equal((await oldSSR.load('fr')).messages.older({ name: 'Ada' }), 'Edited again Ada');
  assert.match(await f.request(current.fr), /New/);
  // Re-requesting an old loader uses today's locale list and recreates any
  // descriptor needed by a newly added locale.
  await f.change('messages/de.json', () => writeFile(join(f.root, 'messages/de.json'), JSON.stringify({ ...f.en, older: 'Alt {name}' })));
  const refreshed = await f.request(old.loader);
  const match = refreshed.match(/import\("([^"\n]+\/de(?:\?[^"\n]*)?)"\)/);
  assert.ok(match, refreshed);
  const german = match[1];
  assert.match(await f.request(german), /Alt/);
  await f.change('messages/fr.json', () => unlink(join(f.root, 'messages/fr.json')));
  await f.request(old.fr, 500);
  await f.change('messages/fr.json', () => f.save('fr'));
  assert.match(await f.request(old.fr), /Edited again/);
});

test('development cleanup preserves in-flight and failed transforms and recovers deleted source files', async t => {
  let entered = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const f = await fixture(t, [{ name: 'delayed-import', async resolveId(id) {
    if (id === 'virtual:delayed') { entered = true; await gate; return '\0virtual:delayed.js'; }
  }, load(id) { if (id === '\0virtual:delayed.js') return 'export default 1;'; } }]);
  const old = await f.client(); await f.ssr();
  await f.change('src/b.ts', () => writeFile(join(f.root, 'src/b.ts'), source('newer', 'import "virtual:delayed";')));
  const pending = f.client(); pending.catch(() => {});
  try {
    await waitFor(() => entered, 'Delayed import did not begin'); await delay(150);
    assert.ok(f.node('client', old.en).transformResult, 'The still-imported selection was evicted during import analysis');
    await f.change('messages/fr.json', () => { f.fr.older = 'While pending {name}'; return f.save('fr'); });
    assert.ok(f.events.some(event => event.environment === 'client' && event.ids?.includes(f.node('client', old.fr).id)));
  } finally { release(); }
  const current = await pending; await f.ssr();
  await f.change('src/b.ts', () => writeFile(join(f.root, 'src/b.ts'), 'export const broken = ('));
  await f.request('/src/b.ts', 500);
  await f.change('messages/fr.json', () => { f.fr.newer = 'Still active {name}'; return f.save('fr'); });
  assert.ok(f.events.some(event => event.environment === 'client' && event.ids?.includes(f.node('client', current.fr).id)));
  await f.change('src/b.ts', () => writeFile(join(f.root, 'src/b.ts'), source('newer')));
  const restored = await f.client(); assert.equal((await (await f.ssr()).load('fr')).messages.newer({ name: 'Ada' }), 'Still active Ada');
  await f.change('src/b.ts', () => unlink(join(f.root, 'src/b.ts')));
  await waitFor(() => ['client', 'ssr'].every(environment => !f.node(environment, restored.en).transformResult), 'Deleted source kept selected code');
  await f.change('src/b.ts', () => writeFile(join(f.root, 'src/b.ts'), source('newer')));
  assert.match(await f.request((await f.client()).fr), /Still active/);
  assert.equal((await (await f.ssr()).load('fr')).messages.newer({ name: 'Ada' }), 'Still active Ada');
});
