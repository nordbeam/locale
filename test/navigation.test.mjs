import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, stat, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { generate, createGenerator } from '../dist/project.js';
import { temporary } from './helpers.mjs';
import { startLsp } from './lsp-client.mjs';

test('real TypeScript definitions navigate selected, named, scoped and escaped messages to base JSON', async t => {
  const root = await temporary(t);
  await mkdir(join(root,'messages'));
  const source = '{\r\n  "greeting": "Hello\u2028{name}\u2029!",\r\n  "checkout": {"total": "Total {count, number}"},\r\n  "\\u0065scaped": "Escaped",\r\n  "🐈": "Cat",\r\n  "then": "Then",\r\n  "default": "Default",\r\n  "earlier": "Earlier",\r  "duplicate": "Later"\r\n}\r\n';
  const base=join(root,'messages/en.json');
  await writeFile(base,source);
  await writeFile(join(root,'messages/fr.json'),source);
  await writeFile(join(root,'package.json'),'{"type":"module"}');
  await writeFile(join(root,'tsconfig.json'),'{"compilerOptions":{"target":"ES2022","module":"NodeNext","strict":true},"include":["*.ts"]}');
  await generate({root,baseLocale:'en',scopes:{checkout:['checkout.*']}});
  const lines = [
    "import {loadLocale, selectMessages} from './src/i18n/index.js';",
    "import {greeting} from './src/i18n/locales/fr.js';",
    "import checkout from './src/i18n/scopes/checkout/locales/en.js';",
    "const total=checkout['checkout.total'];",
    "const {messages:m}=await loadLocale('fr');",
    "greeting({name:'Ada'});",
    "total({count:2});",
    "m.greeting({name:'Ada'});",
    "m['checkout.total']({count:2});",
    "m.escaped();",
    "m['🐈']();",
    "m.then();",
    "m.default();",
    "m.duplicate();",
    "const {messages:s}=await selectMessages('greeting','checkout.total')('en');",
    "s.greeting({name:'Ada'});",
    "s['checkout.total']({count:2});",
  ];
  const text=lines.join('\n')+'\n';
  const file=join(root,'main.ts');await writeFile(file,text);
  const lsp=await startLsp(root);
  try {
    const uri=pathToFileURL(file).href;
    lsp.notify('textDocument/didOpen',{textDocument:{uri,languageId:'typescript',version:1,text}});
    for(const [line,character,key] of [[5,2,'greeting'],[7,4,'greeting'],[8,7,'total'],[9,4,'\\u0065scaped'],[10,4,'🐈'],[11,4,'then'],[12,4,'default'],[13,4,'duplicate'],[15,4,'greeting'],[16,7,'total']]) {
      const result=await lsp.request('textDocument/definition',{textDocument:{uri},position:{line,character}});
      assert.equal(result.length,1,JSON.stringify({line,result}));
      const [definition]=result;
      assert.equal(definition.uri,pathToFileURL(base).href);
      const offset=source.lastIndexOf('"'+key+'"');
      const expectedLine=source.slice(0,offset).split(/\r\n|\r|\n/).length-1;
      const column=offset-(Math.max(source.lastIndexOf('\n',offset),source.lastIndexOf('\r',offset))+1);
      assert.equal(definition.range.start.line,expectedLine,JSON.stringify({line,definition}));
      assert.ok([column,column+1].includes(definition.range.start.character),JSON.stringify({line,definition,column}));
      assert.ok(definition.range.end.character<=column+key.length+2,JSON.stringify({line,definition,column,key}));
      assert.ok(definition.range.end.character>definition.range.start.character,JSON.stringify({line,definition}));
    }
  } finally {await lsp.close();}
});

test('source layout edits update maps without rewriting JS/types; sessions match cold generation and remove stale maps', async t => {
  const root=await temporary(t);
  await mkdir(join(root,'messages'));
  const source='{"greeting":"Hello {name}","checkout":{"total":"{count, number}"}}';
  const file=join(root,'messages/en.json');await writeFile(file,source);
  const options={root,baseLocale:'en',scopes:{checkout:['checkout.*']}};
  const run=createGenerator(options);
  const first=await run();
  const declaration=join(root,'src/i18n/messages.d.ts');
  const before=(await stat(declaration)).mtimeMs;
  assert.deepEqual((await run()).changed,[]);
  await writeFile(file,'\n\n'+source);
  const edited=await run();
  assert.equal((await stat(declaration)).mtimeMs,before);
  assert.ok(edited.changed.length===2 && edited.changed.every(file=>file.endsWith('.d.ts.map')));
  assert.equal(first.files['locales/en.js'],edited.files['locales/en.js']);
  const cold=await generate(options);
  assert.deepEqual(edited.files,cold.files);
  assert.deepEqual((await run()).changed,[]);
  await generate({...options,scopes:{}});
  await assert.rejects(access(join(root,'src/i18n/scopes/checkout/messages.d.ts.map')),{code:'ENOENT'});
  const map=JSON.parse(await readFile(join(root,'src/i18n/messages.d.ts.map'),'utf8'));
  assert.equal(map.sources.length,1);
  assert.equal(map.sources[0],'../../messages/en.json');
  assert.equal(map.sourcesContent,undefined);
});

test('the language server reaches the last message in a 50k-key catalog within its request deadline', async t => {
  const root=await temporary(t);
  await mkdir(join(root,'messages'));
  const catalog=Object.fromEntries(Array.from({length:50000},(_,i)=>[`m${i}`,`Message ${i}`]));
  const base=join(root,'messages/en.json');
  const source=JSON.stringify(catalog);
  await writeFile(base,source);
  await writeFile(join(root,'package.json'),'{"type":"module"}');
  await writeFile(join(root,'tsconfig.json'),'{"compilerOptions":{"target":"ES2022","module":"NodeNext","strict":true,"types":[]},"include":["main.ts"]}');
  await generate({root,baseLocale:'en'});
  const text="import {loadLocale} from './src/i18n/index.js';\nconst {messages:m}=await loadLocale('en');\nm.m49999();\n";
  const file=join(root,'main.ts');await writeFile(file,text);
  const uri=pathToFileURL(file).href;
  const lsp=await startLsp(root);
  try {
    lsp.notify('textDocument/didOpen',{textDocument:{uri,languageId:'typescript',version:1,text}});
    const [definition]=await lsp.request('textDocument/definition',{textDocument:{uri},position:{line:2,character:4}});
    assert.equal(definition.uri,pathToFileURL(base).href);
    assert.equal(definition.range.start.line,0);
    assert.ok([source.indexOf('"m49999"'),source.indexOf('"m49999"')+1].includes(definition.range.start.character));
  } finally {await lsp.close();}
});

test('large declaration groups preserve types and remove old type/map files after shrinking', async t => {
  const root=await temporary(t);
  await mkdir(join(root,'messages'));
  const catalog=JSON.parse('{"then":"Then {name}","default":"Default","__proto__":"Prototype","$Messages":"Messages","$T0":"Type","Key":"Key","messages":"Catalog"}');
  catalog.wide=Object.fromEntries(Array.from({length:300},(_,i)=>[`m${i}`,`Message ${i}: {count, number}`]));
  const source=JSON.stringify(catalog);
  for(const locale of ['en','fr'])await writeFile(join(root,`messages/${locale}.json`),source);
  await writeFile(join(root,'package.json'),'{"type":"module"}');
  const run=createGenerator({root,baseLocale:'en',scopes:{wide:['wide.*']}});
  const project=await run();
  const parts=Object.keys(project.files).filter(name=>name.includes('/types/')||name.startsWith('types/'));
  assert.ok(parts.length>0);
  const main = `
import {loadLocale,selectMessages} from './src/i18n/index.js';
import catalog from './src/i18n/locales/fr.js';
import scoped from './src/i18n/scopes/wide/locales/en.js';
const {messages:m}=await loadLocale('fr');
m['wide.m299']({count:2}); catalog['wide.m299']({count:3}); scoped['wide.m299']({count:4});
m['$Messages']();
m.then({name:'Ada'});m.default();m.__proto__();
m.$Messages();m.$T0();m.Key();m.messages();
const namespace = await import('./src/i18n/locales/en.js');
// @ts-expect-error then must not leak into public named exports
namespace.then;
// @ts-expect-error the public default is the catalog, not the message named default
namespace.default();
const record: Record<string, unknown> = m;
const functions: Record<string, (...args: any[]) => string> = m;
const scopedRecord: Record<string, unknown> = scoped;
// @ts-expect-error flattening the declaration groups preserves readonly properties
m['wide.m299'] = () => 'changed';
const {messages:s}=await selectMessages('wide.m299','then')('en');
s['wide.m299']({count:4});s.then({name:'Ada'});
// @ts-expect-error required number survives declaration re-exports
catalog['wide.m299']({count:'two'});
// @ts-expect-error scoped types preserve their number argument
scoped['wide.m299']({});
// @ts-expect-error selected types remain narrow across declaration groups
s['wide.m298']({count:2});
// @ts-expect-error special IDs retain their arguments
m.then({});
`;
  const mainFile=join(root,'main.ts');await writeFile(mainFile,main);
  const result=spawnSync(resolve('node_modules/.bin/tsc'),['--ignoreConfig','--noEmit','--strict','--module','NodeNext','--target','ES2022',join(root,'main.ts')],{encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+result.stderr);
  const lsp=await startLsp(root);
  try {
    const uri=pathToFileURL(mainFile).href;
    lsp.notify('textDocument/didOpen',{textDocument:{uri,languageId:'typescript',version:1,text:main}});
      for (const [call,key] of [["m['wide.m299']",'m299'],["catalog['wide.m299']",'m299'],["scoped['wide.m299']",'m299'],['m.then','then'],['m.default','default'],['m.__proto__','__proto__'],['m.$Messages','$Messages'],["s['wide.m299']",'m299']]) {
      const offset=main.indexOf(call)+(call.includes('[')?call.indexOf('[')+3:call.startsWith('m.')?3:1);
      const prefix=main.slice(0,offset), line=prefix.split('\n').length-1, character=offset-prefix.lastIndexOf('\n')-1;
      const [definition]=await lsp.request('textDocument/definition',{textDocument:{uri},position:{line,character}});
      assert.equal(definition.uri,pathToFileURL(join(root,'messages/en.json')).href,call);
      assert.equal(definition.range.start.line,0,call);
      const column=source.indexOf('"'+key+'"');
      assert.ok([column,column+1].includes(definition.range.start.character),JSON.stringify({call,definition,column}));
    }
  } finally {await lsp.close();}
  for(const locale of ['en','fr'])await writeFile(join(root,`messages/${locale}.json`),'{"wide":{"m0":"Now small {count, number}"}}');
  const small=await run();
  for(const name of parts){assert.equal(Object.hasOwn(small.files,name),false);await assert.rejects(access(join(root,'src/i18n',name)),{code:'ENOENT'});}
  assert.deepEqual((await run()).changed,[]);
});

test('one language-server session follows updated map coordinates after catalog edits', async t => {
  const root=await temporary(t);
  await mkdir(join(root,'messages'));
  const catalog={greeting:'Hello {name}',escaped:'Escaped',wide:Object.fromEntries(Array.from({length:300},(_,i)=>[`m${i}`,`Message ${i}`]))};
  const base=join(root,'messages/en.json');let source=JSON.stringify(catalog);
  await writeFile(base,source);
  await writeFile(join(root,'package.json'),'{"type":"module"}');
  await writeFile(join(root,'tsconfig.json'),'{"compilerOptions":{"module":"NodeNext","target":"ES2022","strict":true,"types":[]},"include":["main.ts"]}');
  const run=createGenerator({root,baseLocale:'en',scopes:{page:['greeting','escaped','wide.m299']}});
  await run();
  const lines=[
    "import {loadLocale} from './src/i18n/index.js';",
    "import page from './src/i18n/scopes/page/locales/en.js';",
    "const {messages:m}=await loadLocale('en');",
    "m.greeting({name:'Ada'});",
    "m.escaped();",
    "m['wide.m299']();",
    "page['wide.m299']();",
  ];
  const text=lines.join('\n')+'\n',file=join(root,'main.ts');await writeFile(file,text);
  const uri=pathToFileURL(file).href,baseUri=pathToFileURL(base).href;
  const lsp=await startLsp(root);let version=1;
  const check=async()=>{
    for(const [line,character,key] of [[3,4,'greeting'],[4,4,source.includes('"\\u0065scaped"')?'\\u0065scaped':'escaped'],[5,7,'m299'],[6,10,'m299']]){
      const result=await lsp.request('textDocument/definition',{textDocument:{uri},position:{line,character}});
      assert.equal(result.length,1,JSON.stringify({line,result}));
      const definition=result[0];assert.equal(definition.uri,baseUri);
      const offset=source.lastIndexOf('"'+key+'"');
      const before=source.slice(0,offset),expectedLine=before.split(/\r\n|\r|\n/).length-1;
      const column=offset-Math.max(before.lastIndexOf('\n'),before.lastIndexOf('\r'))-1;
      assert.equal(definition.range.start.line,expectedLine,JSON.stringify({line,definition,expectedLine}));
      assert.ok([column,column+1].includes(definition.range.start.character),JSON.stringify({line,definition,column}));
    }
  };
  try {
    lsp.notify('textDocument/didOpen',{textDocument:{uri,languageId:'typescript',version:1,text}});
    lsp.notify('textDocument/didOpen',{textDocument:{uri:baseUri,languageId:'json',version,text:source}});
    await check();
    for(const edit of [
      ()=>{catalog.greeting='Hallo {name}';return JSON.stringify(catalog);},
      ()=>JSON.stringify(catalog,null,2).replaceAll('\n','\r\n'),
      ()=>{catalog.greeting='Hello\u2028{name}\u2029!';return JSON.stringify(catalog).replace('"escaped"','"\\u0065scaped"');},
      ()=>{catalog.aaa='Earlier sorted key';return JSON.stringify(catalog,null,4);},
    ]){
      source=edit();await writeFile(base,source);
      const result=await run();
      lsp.notify('textDocument/didChange',{textDocument:{uri:baseUri,version:++version},contentChanges:[{text:source}]});
      lsp.notify('workspace/didChangeWatchedFiles',{changes:result.changed.map(path=>({uri:pathToFileURL(path).href,type:2}))});
      await check();
    }
  } finally {await lsp.close();}
});
