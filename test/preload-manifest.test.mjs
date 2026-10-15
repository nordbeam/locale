import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'vite';
import { nordbeamLocale } from '../dist/vite.js';
import { preloadManifest } from '../dist/preload-manifest.js';
import { temporary } from './helpers.mjs';

test('preload manifest maps entry/locale files and their static shared dependencies', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'messages')); await mkdir(join(root, 'src'));
  for (const locale of ['en', 'fr']) await writeFile(join(root, `messages/${locale}.json`), JSON.stringify({ a: `${locale}_A`, b: `${locale}_B`, shared: `${locale}_SHARED`, unused: 'UNUSED_SENTINEL' }));
  await writeFile(join(root, 'src/main.ts'), `export const a = () => import('./a'); export const b = () => import('./b');`);
  await writeFile(join(root, 'src/a.ts'), `import { selectMessages } from './i18n/index.js';export const load=selectMessages('a','shared');`);
  await writeFile(join(root, 'src/b.ts'), `import { selectMessages } from './i18n/index.js';export const load=selectMessages('b','shared');`);
  const config = enabled => ({root,configFile:false,logLevel:'silent',plugins:[nordbeamLocale({baseLocale:'en',preloadManifest:enabled})],
    build:{write:false,minify:false,rollupOptions:{input:join(root,'src/main.ts'),preserveEntrySignatures:'strict'}}});
  const result = await build(config(true));
  const asset = result.output.find(x=>x.fileName==='nordbeam-locale-preload.json');
  assert.ok(asset);
  const manifest = JSON.parse(asset.source);
  assert.deepEqual(Object.keys(manifest.entries).sort(), ['src/a.ts','src/b.ts']);
  for(const [entry,marker] of [['src/a.ts','A'],['src/b.ts','B']]) for(const locale of ['en','fr']) {
    const files = manifest.entries[entry].locales[locale];
    assert.ok(files.length);
    const code = files.map(file=>result.output.find(x=>x.fileName===file).code).join('\n');
    assert.ok(code.includes(`${locale}_${marker}`));
    assert.ok(code.includes(`${locale}_SHARED`));
    assert.ok(!code.includes(`${locale==='en'?'fr':'en'}_${marker}`));
    assert.ok(!code.includes('UNUSED_SENTINEL'));
  }
  const before = await build(config(false));
  assert.equal(before.output.some(x=>x.fileName==='nordbeam-locale-preload.json'),false);
  assert.deepEqual(result.output.filter(x=>x.type==='chunk').map(x=>[x.fileName,x.code]).sort(),before.output.filter(x=>x.type==='chunk').map(x=>[x.fileName,x.code]).sort());
});

test('preload manifest fails clearly when its reserved asset filename is already owned', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'messages')); await mkdir(join(root, 'src'));
  await writeFile(join(root, 'messages/en.json'), JSON.stringify({ greeting: 'Hello' }));
  await writeFile(join(root, 'src/main.ts'), 'export const greeting = "hello";');
  const owner = {
    name: 'existing-preload-asset',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'nordbeam-locale-preload.json', source: '{"owned":true}\n' });
    },
  };
  await assert.rejects(build({ root, configFile: false, logLevel: 'silent', plugins: [owner, nordbeamLocale({ baseLocale: 'en', preloadManifest: true })],
    build: { write: false, minify: false, rollupOptions: { input: join(root, 'src/main.ts') } } }),
    /Nordbeam Locale: cannot emit nordbeam-locale-preload\.json because the bundle already owns that filename/);
});

test('preload manifest keeps dynamic full-loader routes separate and skips SSR output', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'messages')); await mkdir(join(root, 'src'));
  for (const locale of ['en', 'fr']) await writeFile(join(root, `messages/${locale}.json`), JSON.stringify({ a: `${locale}_A`, unused: 'UNUSED_SENTINEL' }));
  await writeFile(join(root, 'src/main.ts'), `export const route = () => import('./route');`);
  // The result is consumed through a dynamic object, so selection inference
  // correctly keeps the full generated loader as the dependency.
  await writeFile(join(root, 'src/route.ts'), `import { loadLocale } from './i18n/index.js';export async function load(locale){const result=await loadLocale(locale);return Object.keys(result.messages).length;}`);
  const config = (ssr, outDir) => ({ root, configFile: false, logLevel: 'silent', plugins: [nordbeamLocale({ baseLocale: 'en', preloadManifest: true })],
    build: { write: false, ssr, outDir, minify: false, rollupOptions: { input: join(root, 'src/main.ts'), preserveEntrySignatures: 'strict' } } });
  const client = await build(config(false, 'dist-client'));
  const asset = client.output.find(x => x.fileName === 'nordbeam-locale-preload.json');
  assert.ok(asset);
  const manifest = JSON.parse(asset.source);
  assert.deepEqual(Object.keys(manifest.entries), ['src/route.ts']);
  for (const locale of ['en', 'fr']) {
    const files = manifest.entries['src/route.ts'].locales[locale];
    assert.ok(files.length);
    const code = files.map(file => client.output.find(x => x.fileName === file).code).join('\n');
    assert.ok(code.includes(`${locale}_A`));
    // Full-loader fallback intentionally carries every message in the locale.
    assert.ok(code.includes('UNUSED_SENTINEL'));
  }
  const server = await build(config(true, 'dist-server'));
  assert.equal(server.output.some(x => x.fileName === 'nordbeam-locale-preload.json'), false);
});

test('preload manifest handles full-loader dependency cycles and shared imports', () => {
  const root = '/app';
  const outDir = '/app/generated';
  const loader = `${outDir}/index.js`;
  const bundle = {
    'entry.js': { type: 'chunk', fileName: 'entry.js', isEntry: true, isDynamicEntry: false, facadeModuleId: '/app/src/main.ts', moduleIds: ['/app/src/main.ts'], imports: ['locale-en.js'] },
    'locale-en.js': { type: 'chunk', fileName: 'locale-en.js', isEntry: false, isDynamicEntry: false, facadeModuleId: null, moduleIds: [`${outDir}/locales/en.js`], imports: ['shared.js'] },
    'shared.js': { type: 'chunk', fileName: 'shared.js', isEntry: false, isDynamicEntry: false, facadeModuleId: null, moduleIds: ['/app/src/helper.ts'], imports: ['cycle.js'] },
    'cycle.js': { type: 'chunk', fileName: 'cycle.js', isEntry: false, isDynamicEntry: false, facadeModuleId: null, moduleIds: ['/app/src/cycle.ts'], imports: ['shared.js'] },
  };
  const graph = new Map([
    ['/app/src/main.ts', [`/app/src/helper.ts`, loader]],
    ['/app/src/helper.ts', ['/app/src/cycle.ts']],
    ['/app/src/cycle.ts', ['/app/src/helper.ts', loader]],
    [loader, []],
  ]);
  const project = { outDir, locales: ['en'], groups: { 'index.js': ['a'] } };
  const selections = { modules: new Map() };
  const result = preloadManifest(root, project, selections, bundle, id => ({ importedIds: graph.get(id) ?? [] }));
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { version: 1, entries: { 'src/main.ts': { file: 'entry.js', locales: { en: ['cycle.js', 'locale-en.js', 'shared.js'] } } } });
});
