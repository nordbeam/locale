import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseAst } from 'rolldown/parseAst';
import { build, createServer } from 'vite';
import { inferSelections, inferSelectionResults } from '../dist/infer-selections.js';
import { nordbeamLocale } from '../dist/vite.js';
import { temporary, waitFor } from './helpers.mjs';

test('inference requires complete local knowledge of every message reference', () => {
  const prefix = 'import {loadLocale} from "./i18n/index.js";';
  const cases = [
    ['const {messages:m}=await loadLocale("en"); m.greeting(); m["total"]();', ['greeting', 'total']],
    ['const {messages:m}=await loadLocale("en"); m.product.price();', ['product.price']],
    ['const {messages}=await loadLocale("en"); messages.greeting();', ['greeting']],
    ['const {messages:{greeting:g,total}}=await loadLocale("en"); g(); total();', ['greeting', 'total']],
    ['const {locale, messages:m}=await loadLocale("en"); console.log(locale); m.greeting();', ['greeting']],
    ['const {messages:m}=await loadLocale("en"); export function render(){return m.greeting();}', ['greeting']],
    ['const {messages:m}=await loadLocale("en"); m["__proto__"](); m["العربية"]();', ['__proto__', 'العربية']],
    ['const {messages:m}=await loadLocale("en"); m.greeting?.();', ['greeting']],
    ['const {messages:m}=await loadLocale("en"); function f(m){m.total();} m.greeting();', ['greeting']],
    ['const {messages:m}=await loadLocale("en"); {const m=other; m.total();} m.greeting();', ['greeting']],
    ['const {messages:m}=await loadLocale("en"); try{}catch(m){m.total();}m.greeting();', ['greeting']],
    ...[
      'const {messages:m}=await loadLocale("en"); Object.keys(m); m.greeting();',
      'const {messages:m}=await loadLocale("en"); console.log({...m}); m.greeting();',
      'const {messages:m}=await loadLocale("en"); m[globalThis.key]();',
      'const {messages:m}=await loadLocale("en"); consume(m); m.greeting();',
      'const {messages:m}=await loadLocale("en"); export {m}; m.greeting();',
      'export const {messages:m}=await loadLocale("en"); m.greeting();',
      'const {messages:m}=await loadLocale("en"); export const g=m.greeting;',
      'const {messages:m}=await loadLocale("en"); m.greeting=()=>"new"; m.greeting();',
      'const {messages:m}=await loadLocale("en"); delete m.total; m.greeting();',
      'const {messages:m}=await loadLocale("en"); eval("m.total()"); m.greeting();',
      'const {messages:m,...rest}=await loadLocale("en"); m.greeting();',
      'const {messages:{greeting,...rest}}=await loadLocale("en"); greeting();',
      'const {messages:{greeting:g}}=await loadLocale("en"); export {g};',
      'let {messages:m}=await loadLocale("en"); m.greeting();',
      'const {messages:m}=await loadLocale("en"); m.greeting.call(null);',
      'const {messages:m}=await loadLocale("en"); const g=m.greeting; g();',
      'const {messages:m}=await loadLocale("en"); const other={m}; m.greeting();',
      'const {messages:m}=await loadLocale("en"); globalThis.save=()=>m; m.greeting();',
      'async function f(loadLocale){const {messages:m}=await loadLocale("en");m.greeting();}',
      'const load=loadLocale; const {messages:m}=await load("en");m.greeting();',
    ].map(source => [source, undefined]),
  ];
  for (const [source, keys] of cases) {
    const results = [...inferSelections(parseAst(prefix + source), new Set(['loadLocale'])).values()];
    assert.deepEqual(results, keys ? [keys] : [], source);
  }
});

test('inference classifies every automatic fallback with a stable reason', () => {
  const prefix = 'import {loadLocale} from "./i18n/index.js";';
  const cases = [
    ['let {messages:m}=await loadLocale("en");m.greeting();', 'mutable-binding'],
    ['const data=await loadLocale("en");data.messages.greeting();', 'loaded-result-retained'],
    ['const {messages:m}=await loadLocale("en");consume(m);m.greeting();', 'message-object-escapes'],
    ['const {messages:m}=await loadLocale("en");export {m};m.greeting();', 'exported-binding'],
    ['const {messages:m}=await loadLocale("en");m[key]();', 'dynamic-access'],
    ['const {messages:m}=await loadLocale("en");m.greeting.call(null);', 'unsupported-property-use'],
    ['const {messages:m}=await loadLocale("en");loadLocale=other;m.greeting();', 'ambiguous-loader-binding'],
    ['const load=loadLocale;const {messages:m}=await load("en");m.greeting();', 'ambiguous-loader-binding'],
    ['const {messages:m}=await loadLocale("en");eval("m.total()");m.greeting();', 'direct-eval'],
  ];
  for (const [source, reason] of cases) {
    const outcomes = [...inferSelectionResults(parseAst(prefix + source), new Set(['loadLocale'])).values()];
    assert.deepEqual(outcomes, [{ kind: 'full', reason }], source);
  }
  const selected = [...inferSelectionResults(parseAst(prefix + 'const {messages:m}=await loadLocale("en");m.greeting();'), new Set(['loadLocale'])).values()];
  assert.deepEqual(selected, [{ kind: 'selected', keys: ['greeting'] }]);
});

async function fixture(t) {
  const root = await temporary(t);
  await mkdir(join(root, 'messages')); await mkdir(join(root, 'src'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  const catalogs = {
    en: {greeting:'Hello {name}',total:'TOTAL_EN {count, number}',unused:'UNUSED_EN',then:'THEN_EN',default:'DEFAULT_EN','product.price':'PRICE_EN {amount}'},
    fr: {greeting:'Bonjour {name}',total:'TOTAL_FR {count, number}',unused:'UNUSED_FR',then:'THEN_FR',default:'DEFAULT_FR','product.price':'PRICE_FR {amount}'},
  };
  for (const [locale, catalog] of Object.entries(catalogs)) await writeFile(join(root, `messages/${locale}.json`), JSON.stringify(catalog));
  return {root, catalogs};
}
const configuration = root => ({root, configFile:false, logLevel:'silent', plugins:[nordbeamLocale({baseLocale:'en'})]});
const output = root => ({modulePreload:false, minify:false, rollupOptions:{input:join(root,'src/main.ts'),preserveEntrySignatures:'strict',output:{entryFileNames:'entry.js'}}});

test('ordinary typed locale loads infer route selections without changing arguments or locale behavior', async t => {
  const {root} = await fixture(t);
  await writeFile(join(root,'src/main.ts'), 'export const a=()=>import("./a");export const b=()=>import("./b");');
  await writeFile(join(root,'src/a.ts'), `import {loadLocale as load, baseLocale} from './i18n/index.js';
export async function render(locale:string,name:string){
  const events:string[]=[];const {messages:m,locale:resolved}=await load((events.push('locale'),locale), events.push('extra'));
  return [m.greeting({name}),m.product.price({amount:12}),resolved,baseLocale,events];
}`);
  await writeFile(join(root,'src/b.ts'), `import {loadLocale} from './i18n/index.js';
export async function render(locale:string){const {messages:{total,then,default:d}}=await loadLocale(locale);return [total({count:1234}),then(),d()];}`);
  const result = await build({...configuration(root),build:output(root)});
  const chunks = result.output.filter(item=>item.type==='chunk');
  const all = chunks.map(item=>item.code).join('\n');
  assert.doesNotMatch(all, /UNUSED_EN|UNUSED_FR|\.product\.price|Object\.defineProperty/);
  const greeting = chunks.find(item=>item.code.includes('Hello'));
  assert.ok(greeting); assert.doesNotMatch(greeting.code,/Bonjour|TOTAL_EN|THEN_EN/);
  const entry = await import(pathToFileURL(join(root,'dist/entry.js')));
  const [a,b] = await Promise.all([entry.a(),entry.b()]);
  assert.deepEqual(await a.render('fr','Ada'),['Bonjour Ada','PRICE_FR 12','fr','en',['locale','extra']]);
  assert.deepEqual(await b.render('en'),['TOTAL_EN 1,234','THEN_EN','DEFAULT_EN']);
  await assert.rejects(a.render('__proto__','Ada'),/Unsupported locale/);
});

test('escaping, dynamic and unknown-property loads retain full catalogs beside inferred loads', async t => {
  const {root} = await fixture(t);
  await writeFile(join(root,'src/main.ts'), `import {loadLocale} from './i18n/index.js';
export async function narrow(locale){const {messages:m}=await loadLocale(locale);return m.greeting({name:'Ada'});}
export async function dynamic(locale,key){const {messages:all}=await loadLocale(locale);return all[key]();}
export async function reflect(locale){const {messages:catalog}=await loadLocale(locale);return Object.keys(catalog);}
export async function unknown(locale){const {messages:missing}=await loadLocale(locale);return missing.absent?.();}
export async function escaped(locale){const {messages:escape}=await loadLocale(locale);return {messages:escape};}`);
  const result = await build({...configuration(root),build:output(root)});
  const code=result.output.filter(item=>item.type==='chunk').map(item=>item.code).join('\n');
  assert.match(code,/UNUSED_EN/);
  const entry = await import(pathToFileURL(join(root,'dist/entry.js')));
  assert.equal(await entry.narrow('fr'),'Bonjour Ada');
  assert.equal(await entry.dynamic('en','unused'),'UNUSED_EN');
  assert.deepEqual(await entry.reflect('en'),['default','greeting','product.price','then','total','unused']);
  assert.equal(await entry.unknown('en'),undefined);
  assert.equal((await entry.escaped('fr')).messages.unused(),'UNUSED_FR');
});

test('inferred development selections follow source usage and catalog repairs', async t => {
  const {root, catalogs} = await fixture(t);
  const file=join(root,'src/main.ts');
  const source=key=>`import {loadLocale} from './i18n/index.js';export async function render(locale){const {messages}=await loadLocale(locale);return messages.${key}(${key==='greeting'?"{name:'Ada'}":""});}`;
  await writeFile(file,source('greeting'));
  const server=await createServer({...configuration(root),server:{host:'127.0.0.1',port:0}});
  const sent=[];
  for (const environment of Object.values(server.environments)) {
    const send=environment.hot.send.bind(environment.hot);
    environment.hot.send=(...args)=>{if(typeof args[0]==='object')sent.push(args[0]);return send(...args);};
  }
  try {
    await server.listen();
    const origin=server.resolvedUrls.local[0];
    const code=await (await fetch(new URL('/src/main.ts',origin))).text();
    assert.match(code,/virtual:nordbeam-locale\/selection/);
    assert.doesNotMatch(code,/from "\/src\/i18n\/index.js"/);
    const render=async()=> (await server.ssrLoadModule('/src/main.ts')).render('fr');
    assert.equal(await render(),'Bonjour Ada');
    catalogs.fr.greeting='Salut {name}';
    await writeFile(join(root,'messages/fr.json'),JSON.stringify(catalogs.fr));
    await waitFor(async()=>await render()==='Salut Ada','inferred message did not update');
    await writeFile(file,source('unused'));
    await waitFor(async()=>await render()==='UNUSED_FR','newly used message did not load');
    catalogs.fr.unused='{bad';
    await writeFile(join(root,'messages/fr.json'),JSON.stringify(catalogs.fr));
    await waitFor(()=>sent.some(event=>event.type==='error' && event.err.message.includes('unused')),'invalid translation did not produce a development error');
    assert.equal(await render(),'UNUSED_FR','the last successful SSR module remains usable during repair');
    catalogs.fr.unused='Repaired';
    await writeFile(join(root,'messages/fr.json'),JSON.stringify(catalogs.fr));
    await waitFor(async()=>{try{return await render()==='Repaired';}catch{return false;}},'inferred selection did not recover');
  } finally { await server.close(); }
});

test('inferred routes share overlapping rich messages in client and SSR builds', async t => {
  const {root,catalogs}=await fixture(t);
  catalogs.en.rich='<b>Hello {name}</b>';
  delete catalogs.fr.default;
  for(const [locale,catalog] of Object.entries(catalogs)) await writeFile(join(root,`messages/${locale}.json`),JSON.stringify(catalog));
  await writeFile(join(root,'src/main.ts'),'export const pages=[()=>import("./a"),()=>import("./b")];');
  await writeFile(join(root,'src/a.ts'),`import {loadLocale} from './i18n/index.js';export async function render(locale){const {messages:m}=await loadLocale(locale);return [m.greeting({name:'Ada'}),m.rich({name:'Ada',b:children=>({strong:children})}),m.total({count:12})];}`);
  await writeFile(join(root,'src/b.ts'),`import {loadLocale} from './i18n/index.js';export async function render(locale){const {messages:m}=await loadLocale(locale);return [m.greeting({name:'Ada'}),m.rich({name:'Ada',b:children=>({strong:children})}),m.default()];}`);
  for(const ssr of [false,true]){
    const result=await build({...configuration(root),build:{...output(root),modulePreload:true,ssr,write:ssr}});
    const chunks=result.output.filter(item=>item.type==='chunk');
    assert.ok(chunks.flatMap(chunk=>Object.keys(chunk.modules)).some(id=>id.startsWith('\0virtual:nordbeam-locale/shared/')));
    assert.doesNotMatch(chunks.map(chunk=>chunk.code).join('\n'),/UNUSED_EN|UNUSED_FR|THEN_EN|THEN_FR/);
    const graph=new Map(chunks.map(chunk=>[chunk.fileName,chunk]));
    const a=chunks.find(chunk=>chunk.facadeModuleId?.endsWith('/a.ts'));
    const en=a.dynamicImports.map(file=>graph.get(file)).find(chunk=>chunk.facadeModuleId?.endsWith('/en'));
    assert.ok(en);
    const reached=new Set();const visit=file=>{if(reached.has(file))return;reached.add(file);for(const child of graph.get(file).imports)visit(child);};
    visit(en.fileName);
    assert.doesNotMatch([...reached].map(file=>graph.get(file).code).join('\n'),/DEFAULT_EN|Bonjour/);
  }
  const entry=await import(pathToFileURL(join(root,'dist/entry.js')));
  const [a,b]=await Promise.all(entry.pages.map(page=>page()));
  assert.deepEqual(await a.render('fr'),['Bonjour Ada',[{strong:['Hello Ada']}],'TOTAL_FR 12']);
  assert.deepEqual(await b.render('fr'),['Bonjour Ada',[{strong:['Hello Ada']}],'DEFAULT_EN']);
});

test('inference recognizes scoped generated imports and ignores unrelated loader APIs', async t => {
  const {root}=await fixture(t);
  await writeFile(join(root,'src/other.ts'),`export async function loadLocale(){return {messages:{unused:()=>"OTHER_API"}};}`);
  await writeFile(join(root,'src/main.ts'),`import {loadLocale as scoped} from './i18n/scopes/small/index.js';import {loadLocale as unrelated} from './other';
export async function render(locale){const {messages:m}=await scoped(locale);const {messages:other}=await unrelated();return [m.greeting({name:'Ada'}),other.unused()];}`);
  const result=await build({...configuration(root),plugins:[nordbeamLocale({baseLocale:'en',scopes:{small:['greeting','total']}})],build:output(root)});
  assert.doesNotMatch(result.output.filter(item=>item.type==='chunk').map(item=>item.code).join('\n'),/TOTAL_EN|UNUSED_EN/);
  const entry=await import(pathToFileURL(join(root,'dist/entry.js')));
  assert.deepEqual(await entry.render('fr'),['Bonjour Ada','OTHER_API']);
});
