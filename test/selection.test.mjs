import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, createServer, createLogger } from 'vite';
import { nordbeamLocale } from '../dist/vite.js';
import { temporary, waitFor } from './helpers.mjs';

async function fixture(t) {
  const root = await temporary(t);
  await mkdir(join(root, 'messages'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  const en = { greeting: 'Hello {name}', total: 'EN_TOTAL {count, number}', unused: 'UNUSED_SENTINEL', product: { price: 'EN_PRICE {amount}' } };
  const fr = { greeting: 'Bonjour {name}', total: 'FR_TOTAL {count, number}', unused: 'FR_UNUSED_SENTINEL', product: { price: 'FR_PRICE {amount}' } };
  await writeFile(join(root, 'messages/en.json'), JSON.stringify(en));
  await writeFile(join(root, 'messages/fr.json'), JSON.stringify(fr));
  return { root, en, fr };
}
const config = root => ({ root, configFile: false, logLevel: 'silent', plugins: [nordbeamLocale({ baseLocale: 'en' })] });
// Disable DOM preload hints so emitted ESM can also be executed in Node.
const output = root => ({ modulePreload: false, rollupOptions: { input: join(root, 'src/main.ts'), preserveEntrySignatures: 'strict', output: { entryFileNames: 'entry.js' } }, minify: false });

test('Vite selects typed messages into separate route/locale chunks and preserves Unicode offsets', async t => {
  const { root } = await fixture(t);
  await writeFile(join(root, 'src/main.ts'), `export const pageA = () => import('./a'); export const pageB = () => import('./b');`);
  await writeFile(join(root, 'src/a.ts'), `import { selectMessages as choose } from './i18n/index.js';
export const label: string = 'العربية 👩🏽‍💻'; export const load = choose('greeting');`);
  await writeFile(join(root, 'src/b.ts'), `import { selectMessages } from './i18n/index.js'; export const load = selectMessages('total');`);
  const result = await build({ ...config(root), build: output(root) });
  const chunks = result.output.filter(file => file.type === 'chunk');
  const all = chunks.map(chunk => chunk.code).join('\n');
  assert.doesNotMatch(all, /UNUSED_SENTINEL|function selectMessages/);
  const greeting = chunks.find(chunk => chunk.code.includes('Hello'));
  const total = chunks.find(chunk => chunk.code.includes('EN_TOTAL'));
  const french = chunks.find(chunk => chunk.code.includes('Bonjour'));
  assert.ok(greeting && total && french);
  assert.notEqual(greeting.fileName, total.fileName, 'unrelated routes should load different message chunks');
  assert.notEqual(greeting.fileName, french.fileName, 'locales should stay separate');
  assert.doesNotMatch(greeting.code, /EN_TOTAL|Bonjour/);
  const entry = await import(pathToFileURL(join(root, 'dist/entry.js')));
  const [a, b] = await Promise.all([entry.pageA(), entry.pageB()]);
  assert.equal(a.label, 'العربية 👩🏽‍💻');
  assert.equal((await a.load('fr')).messages.greeting({ name: 'Ada' }), 'Bonjour Ada');
  assert.deepEqual(Object.keys((await b.load('en')).messages), ['total']);
  assert.equal((await b.load('en')).messages.total({ count: 1234 }), 'EN_TOTAL 1,234');
  await assert.rejects(a.load('__proto__'), /Unsupported locale/);
});

test('Vite narrows a component-scoped loader passed directly to a hook', async t => {
  const { root } = await fixture(t);
  await writeFile(join(root, 'src/main.ts'), `import { selectMessages } from './i18n/index.js';
const i18n = { useMessages: loader => loader };
export const load = i18n.useMessages(selectMessages('greeting'));`);
  const result = await build({ ...config(root), build: output(root) });
  const all = result.output.filter(file => file.type === 'chunk').map(chunk => chunk.code).join('\n');
  assert.doesNotMatch(all, /UNUSED_SENTINEL|EN_TOTAL|function selectMessages/);
  const { load } = await import(pathToFileURL(join(root, 'dist/entry.js')));
  assert.deepEqual(Object.keys((await load('fr')).messages), ['greeting']);
  assert.equal((await load('fr')).messages.greeting({ name: 'Ada' }), 'Bonjour Ada');
});

test('Vite selections expose nested property calls without changing flat IDs', async t => {
  const { root } = await fixture(t);
  await writeFile(join(root, 'src/main.ts'), `import { selectMessages } from './i18n/index.js';
export const load = selectMessages('product.price');`);
  const result = await build({ ...config(root), build: output(root) });
  const all = result.output.filter(file => file.type === 'chunk').map(chunk => chunk.code).join('\n');
  assert.doesNotMatch(all, /UNUSED_SENTINEL|EN_TOTAL|Hello|Bonjour/);
  const { load } = await import(pathToFileURL(join(root, 'dist/entry.js')));
  const { messages } = await load('fr');
  assert.equal(messages.product.price({ amount: 20 }), 'FR_PRICE 20');
  assert.equal(messages.product.price, messages['product.price']);
  assert.deepEqual(Object.keys(messages), ['product.price']);
});

test('staticLocale emits one statically imported locale and rejects mismatches', async t => {
  const { root } = await fixture(t);
  await writeFile(join(root, 'src/main.ts'), `import { selectMessages } from './i18n/index.js'; export const load = selectMessages('greeting');`);
  const result = await build({ root, configFile: false, logLevel: 'silent', plugins: [nordbeamLocale({ baseLocale: 'en', staticLocale: 'fr' })], build: output(root) });
  const chunks = result.output.filter(file => file.type === 'chunk');
  const all = chunks.map(chunk => chunk.code).join('\n');
  assert.match(all, /Bonjour/);
  assert.doesNotMatch(all, /Hello|EN_TOTAL|FR_TOTAL|UNUSED_SENTINEL|import\(/);
  assert.equal(chunks.length, 1, 'the fixed locale projection should remain in the route chunk');
  const { load } = await import(pathToFileURL(join(root, 'dist/entry.js')));
  assert.equal((await load('fr')).messages.greeting({ name: 'Ada' }), 'Bonjour Ada');
  await assert.rejects(load('en'), /Static locale is fr/);

  const shared = await build({ root, configFile: false, logLevel: 'silent', plugins: [nordbeamLocale({ baseLocale: 'en', staticLocale: 'fr' })], build: {
    ...output(root), write: false, modulePreload: { polyfill: false },
  } });
  assert.equal(shared.output.filter(file => file.type === 'chunk').length, 1, 'static locale should also work with production sharing enabled');

  await writeFile(join(root, 'src/main.ts'), `import { loadLocale } from './i18n/index.js'; const { messages } = await loadLocale('en'); export const value = messages.greeting({name:'Ada'});`);
  await assert.rejects(build({ root, configFile: false, logLevel: 'silent', plugins: [nordbeamLocale({ baseLocale: 'en', staticLocale: 'fr' })], build: output(root) }), /staticLocale is "fr".*requests "en"/);
  await assert.rejects(build({ root, configFile: false, logLevel: 'silent', plugins: [nordbeamLocale({ baseLocale: 'en', staticLocale: 'missing' })], build: output(root) }), /not a configured locale/);
});

test('lexical import selection preserves shadowed functions and explains dynamic-key fallback', async t => {
  const { root } = await fixture(t);
  const warnings = [];
  await writeFile(join(root, 'src/main.ts'), `import { selectMessages as choose } from './i18n/index.js';
export const load = choose('greeting');
export const shadow = (choose: (x: string) => string) => choose('total');`);
  await build({ ...config(root), build: { ...output(root), rollupOptions: {
    ...output(root).rollupOptions, onwarn(warning) { warnings.push(warning.message); },
  } } });
  const module = await import(pathToFileURL(join(root, 'dist/entry.js')));
  assert.equal(module.shadow(value => `local:${value}`), 'local:total');
  assert.equal((await module.load('en')).messages.greeting({ name: 'Ada' }), 'Hello Ada');
  assert.equal(warnings.length,0,'unrelated local functions should not disable the imported selector');

  await writeFile(join(root, 'src/main.ts'), `import { selectMessages } from './i18n/index.js';
const keys = globalThis.keys || ['greeting']; export const load = selectMessages(...keys);`);
  const result = await build({ ...config(root), build: { ...output(root), write: false, rollupOptions:{...output(root).rollupOptions,onwarn(warning){warnings.push(warning.message);}} } });
  assert.ok(warnings.some(message=>message.includes('dynamic keys')));
  assert.match(result.output.filter(file => file.type === 'chunk').map(file => file.code).join('\n'), /UNUSED_SENTINEL/);
});

test('automatic selection fallbacks warn once with a source location and support error/off modes', async t => {
  const { root } = await fixture(t);
  await writeFile(join(root, 'src/main.ts'), `import {loadLocale} from './i18n/index.js';
export async function mutable(locale){let {messages:m}=await loadLocale(locale);return m.greeting({name:'Ada'});}
export async function escaped(locale){const {messages:m}=await loadLocale(locale);consume(m);return m.greeting({name:'Ada'});}`);
  const warnings = [];
  const baseLogger = createLogger('silent');
  const logger = { ...baseLogger, warn(message) { warnings.push(String(message)); } };
  await build({ ...config(root), customLogger: logger, build: { ...output(root), write: false } });
  const fallbackWarnings = warnings.filter(message => message.includes('selection fallback'));
  assert.equal(fallbackWarnings.length, 2);
  assert.ok(fallbackWarnings.some(message => message.includes('(mutable-binding)')));
  assert.ok(fallbackWarnings.some(message => message.includes('(message-object-escapes)')));
  assert.match(fallbackWarnings[0], /main\.ts:\d+:\d+/);

  await assert.rejects(build({ root, configFile: false, logLevel: 'silent', plugins: [nordbeamLocale({ baseLocale: 'en', selectionFallback: 'error' })], build: { ...output(root), write: false } }), /selection fallback.*mutable-binding/);
  warnings.length = 0;
  await build({ root, configFile: false, logLevel: 'silent', customLogger: logger, plugins: [nordbeamLocale({ baseLocale: 'en', selectionFallback: 'off' })], build: { ...output(root), write: false } });
  assert.equal(warnings.filter(message => message.includes('selection fallback')).length, 0);
});

test('selectionFallback validates direct and JSON config options', async t => {
  const { root } = await fixture(t);
  await writeFile(join(root, 'src/main.js'), `import {selectMessages} from './i18n/index.js';export const load=selectMessages('greeting');`);
  await assert.rejects(build({ root, configFile: false, logLevel: 'silent', plugins: [nordbeamLocale({ baseLocale: 'en', selectionFallback: 'invalid' })], build: { ...output(root), write: false } }), /selectionFallback must be/);
  await writeFile(join(root, 'nordbeam-i18n.config.json'), JSON.stringify({ baseLocale: 'en', selectionFallback: 'invalid' }));
  await assert.rejects(build({ root, logLevel: 'silent', plugins: [nordbeamLocale()], build: { ...output(root), write: false } }), /selectionFallback must be/);
});

test('unknown literal selections fail the build and special keys remain safe', async t => {
  const { root, en, fr } = await fixture(t);
  await writeFile(join(root, 'src/main.ts'), `import { selectMessages } from './i18n/index.js'; export const load = selectMessages('missing');`);
  await assert.rejects(build({ ...config(root), build: output(root) }), /unknown selected message/);
  for (const [locale, catalog] of [['en', en], ['fr', fr]]) {
    catalog.then = 'Then'; catalog.default = 'Default';
    await writeFile(join(root, `messages/${locale}.json`), JSON.stringify(catalog));
  }
  await writeFile(join(root, 'src/main.ts'), `import { selectMessages } from './i18n/index.js'; export const load = selectMessages('then', 'default');`);
  await build({ ...config(root), build: output(root) });
  const { load } = await import(pathToFileURL(join(root, 'dist/entry.js')));
  const { messages } = await load('en');
  assert.equal(messages.then(), 'Then'); assert.equal(messages.default(), 'Default');
  assert.deepEqual(Object.keys(messages), ['then', 'default']);
});

test('development selection loaders update when locales are added and deleted', async t => {
  const { root, en } = await fixture(t);
  await writeFile(join(root, 'src/main.ts'), `import { selectMessages } from './i18n/index.js'; export const load = selectMessages('greeting');`);
  const server = await createServer({ ...config(root), server: { host: '127.0.0.1', port: 0 } });
  t.after(() => server.close());
  await server.listen();
  const origin = server.resolvedUrls.local[0];
  const code = await (await fetch(new URL('/src/main.ts', origin))).text();
  const virtual = code.match(/from\s+"([^"\n]*virtual:nordbeam-locale\/selection\/[^"\n]+)"/)?.[1];
  assert.ok(virtual, code);
  const source = async () => (await fetch(new URL(virtual, origin))).text();
  assert.doesNotMatch(await source(), /"de"/);
  await writeFile(join(root, 'messages/de.json'), JSON.stringify(en));
  await waitFor(async () => /"de"/.test(await source()), 'selected loader did not add locale');
  await unlink(join(root, 'messages/de.json'));
  await waitFor(async () => !/"de"/.test(await source()), 'selected loader did not remove locale');
});

test('removing replaced selector imports preserves other imports, factory aliases and dynamic calls', async t => {
  const {root}=await fixture(t);
  await writeFile(join(root,'src/other.ts'),`import {selectMessages as choose,baseLocale,loadLocale} from './i18n/index.js';
export const load=choose('greeting');export const base=baseLocale;export const all=loadLocale;`);
  await writeFile(join(root,'src/alias.ts'),`import {selectMessages as choose} from './i18n/index.js';
export {choose};export const factory=choose;export const load=choose('greeting');`);
  await writeFile(join(root,'src/dynamic.ts'),`import {selectMessages as choose} from './i18n/index.js';
const keys=['greeting'];export const dynamic=choose(...keys);export const load=choose('total');`);
  const server=await createServer({...config(root),server:{host:'127.0.0.1',port:0}});
  t.after(()=>server.close());await server.listen();
  const origin=server.resolvedUrls.local[0];
  const otherCode=await (await fetch(new URL('/src/other.ts',origin))).text();
  assert.match(otherCode,/baseLocale/);assert.match(otherCode,/loadLocale/);
  assert.doesNotMatch(otherCode,/selectMessages as choose/);
  const other=await server.ssrLoadModule('/src/other.ts');
  assert.equal(other.base,'en');
  assert.equal((await other.all('en')).messages.unused(),'UNUSED_SENTINEL');
  assert.equal((await other.load('fr')).messages.greeting({name:'Ada'}),'Bonjour Ada');
  const alias=await server.ssrLoadModule('/src/alias.ts');
  assert.equal(alias.choose,alias.factory);
  assert.equal((await alias.factory('unused')('en')).messages.unused(),'UNUSED_SENTINEL');
  const dynamic=await server.ssrLoadModule('/src/dynamic.ts');
  assert.equal((await dynamic.dynamic('en')).messages.greeting({name:'Ada'}),'Hello Ada');
  assert.deepEqual(Object.keys((await dynamic.load('en')).messages),['total']);
});

test('Vite builds shared templates and one-off selections without retaining unused text',async t=>{
  const {root,en,fr}=await fixture(t);
  for(const [locale,catalog] of [['en',en],['fr',fr]]){
    catalog.welcome=`${locale} welcome {name}`;catalog.sharedUnused='SHARED_UNUSED_SENTINEL {name}';
    await writeFile(join(root,`messages/${locale}.json`),JSON.stringify(catalog));
  }
  await writeFile(join(root,'src/main.ts'),`import {selectMessages} from './i18n/index.js';export const pair=selectMessages('greeting','welcome');export const single=selectMessages('greeting');`);
  const result=await build({...config(root),build:output(root)});
  assert.match(await readFile(join(root,'src/i18n/locales/en.js'),'utf8'),/^const \$f\d+=\(\$s0/m,'fixture must use the real compiler factory path');
  const chunks=result.output.filter(file=>file.type==='chunk');assert.doesNotMatch(chunks.map(chunk=>chunk.code).join('\n'),/UNUSED_SENTINEL|EN_TOTAL|FR_TOTAL/);
  const entry=await import(pathToFileURL(join(root,'dist/entry.js')));
  for(const locale of ['en','fr']){
    const pair=(await entry.pair(locale)).messages,single=(await entry.single(locale)).messages;
    assert.deepEqual(Object.keys(pair),['greeting','welcome']);assert.deepEqual(Object.keys(single),['greeting']);
    assert.equal(pair.greeting({name:'Ada'}),`${locale==='en'?'Hello':'Bonjour'} Ada`);
    assert.equal(pair.welcome({name:'Ada'}),`${locale} welcome Ada`);assert.equal(single.greeting({name:'Ada'}),pair.greeting({name:'Ada'}));
  }
});
