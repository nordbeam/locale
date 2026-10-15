import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { nordbeamLocale } from '../dist/vite.js';
import { temporary } from './helpers.mjs';

async function fixture(t, code, options = {}) {
  const root = await temporary(t);
  await mkdir(join(root, 'messages'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'messages/en.json'), JSON.stringify({ greeting:'Hello {name}', unused:'EN_UNUSED' }));
  await writeFile(join(root, 'messages/fr.json'), JSON.stringify({ greeting:'Bonjour {name}', unused:'FR_UNUSED' }));
  await writeFile(join(root, 'src/main.js'), code);
  const warnings = [];
  const result = await build({root,configFile:false,logLevel:'silent',plugins:[nordbeamLocale({baseLocale:'en',...options})],build:{
    modulePreload:false,minify:false,rollupOptions:{input:join(root,'src/main.js'),preserveEntrySignatures:'strict',
      onwarn(warning) { warnings.push(warning.message); },output:{entryFileNames:'entry.js'}}}});
  return {warnings, code:result.output.filter(x=>x.type==='chunk').map(x=>x.code).join('\n'),
    module:await import(pathToFileURL(join(root,'dist/entry.js')))};
}

test('static locale warns about escaping loaders and preserves their dynamic contract', async t => {
  const result = await fixture(t, `import {loadLocale} from './i18n/index.js'; export const load = loadLocale;`, {staticLocale:'fr'});
  assert.equal(result.warnings.filter(w=>w.includes('could not specialize')).length,1);
  assert.match(result.warnings[0],/dynamic loader.*other locales/);
  assert.match(result.code,/Hello/);
  assert.match(result.code,/Bonjour/);
  assert.equal((await result.module.load('en')).messages.greeting({name:'Ada'}),'Hello Ada');
  assert.equal((await result.module.load('fr')).messages.greeting({name:'Ada'}),'Bonjour Ada');
});

test('static locale explains namespace and direct-eval boundaries', async t => {
  const namespace = await fixture(t, `import * as catalog from './i18n/index.js'; export const load = locale => catalog.loadLocale(locale);`, {staticLocale:'fr'});
  assert.ok(namespace.warnings.some(w=>w.includes('namespace import')));
  assert.equal((await namespace.module.load('en')).messages.unused(),'EN_UNUSED');
  const reflected = await fixture(t, `import {loadLocale} from './i18n/index.js'; export async function read(locale) { const data = await loadLocale(locale); return eval('data.messages.greeting({name:"Ada"})'); }`, {staticLocale:'fr'});
  assert.ok(reflected.warnings.some(w=>w.includes('direct eval')));
  assert.equal(await reflected.module.read('en'),'Hello Ada');
});

test('static locale keeps proven selection silent and supports a manual static import', async t => {
  const selected = await fixture(t, `import {selectMessages} from './i18n/index.js'; export const load=selectMessages('greeting');`, {staticLocale:'fr'});
  assert.deepEqual(selected.warnings,[]);
  assert.doesNotMatch(selected.code,/Hello|UNUSED|import\(/);
  assert.equal((await selected.module.load('fr')).messages.greeting({name:'Ada'}),'Bonjour Ada');
  await assert.rejects(selected.module.load('en'),/Static locale is fr/);
  const manual = await fixture(t, `export {greeting} from './i18n/locales/fr.js';`);
  assert.deepEqual(manual.warnings,[]);
  assert.doesNotMatch(manual.code,/Hello|UNUSED|import\(/);
  assert.equal(manual.module.greeting({name:'Ada'}),'Bonjour Ada');
});

test('ordinary dynamic loading does not receive static-locale warnings', async t => {
  const result = await fixture(t, `import {loadLocale} from './i18n/index.js'; export const load=loadLocale;`);
  assert.deepEqual(result.warnings,[]);
});
