import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,stat,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {checkProject,compileProject,CompileError} from '../dist/compiler.js';
import {check,generate} from '../dist/project.js';
import {temporary} from './helpers.mjs';

async function fixture(t,files){
  const root=await temporary(t);await mkdir(join(root,'messages'));
  for(const [locale,text] of Object.entries(files))await writeFile(join(root,`messages/${locale}.json`),typeof text==='string'?text:JSON.stringify(text,null,2));
  return {root,baseLocale:'en',outDir:'generated'};
}
const codes=result=>result.errors.map(d=>[d.locale,d.messageId,d.code]);

test('read-only compiler validation shares the generation rules',()=>{
  const input=(en,fr=en,extra={})=>({baseLocale:'en',catalogs:{en,fr},...extra});
  const cyclic={};cyclic.loop=cyclic;
  const invalid=[
    {baseLocale:'en',catalogs:{fr:{g:'Hello'}}},
    {baseLocale:'en',catalogs:{en:{},'en-us':{}}},
    {baseLocale:'en',catalogs:{en:{},'bad_locale':{}}},
    input(null),input({bad:[]}),input(cyclic),input({'':'bad'}),input({a:{b:'one'},'a.b':'two'}),
    input({x:'Hello {name'}),input({x:'{n, plural, one {one}}'}),
    input({x:'{x, number} {x, date}'}),input({x:'<x>{x}</x>'}),
    input({x:'Hello'}, {y:'Salut'}),input({x:'{name}'},{x:'{person}'}),
    input({x:'{n, number}'},{x:'{n, date}'}),input({x:'one'},{},{missing:'error'}),
    input({x:'{n, number, nope}'}),input({x:'{n, number, currency}'}),
    input({x:'{d, date}'},undefined,{timeZone:'bad/timezone'}),
    input({x:'one'},undefined,{scopes:{'bad/path':['x']}}),
    input({x:'one'},undefined,{scopes:{empty:[]}}),
    input({x:'one'},undefined,{scopes:{shop:['missing.*']}}),
    input({x:'one'},undefined,{includeSources:['missing']}),
  ];
  for(const options of invalid){
    let first;
    assert.throws(()=>compileProject(options),error=>{assert.ok(error instanceof CompileError);first=error.diagnostics[0];return true;});
    const result=checkProject(options);assert.equal(result.ok,false);
    assert.ok(result.errors.some(d=>d.code===first.code&&d.locale===first.locale&&(first.messageId===undefined||d.messageId===first.messageId)),JSON.stringify({first,result}));
  }
  const valid=[
    input({x:'text',y:'{n, number, integer}'},{x:'traduit'}),
    input({x:'<b>{n, plural, =0 {none} one {# item} other {# items}}</b>',d:'{d, date, ::yyyyMMdd}'},undefined,{timeZone:'UTC',scopes:{items:['x']}}),
    {baseLocale:'fr',catalogs:{en:{x:'{n, number}'},fr:{x:'{n}'},ar:{x:'{n, number, percent}'}}},
    input({x:'{n, number, money}'},undefined,{formats:{number:{money:{style:'currency',currency:'EUR'}}}}),
    input({x:'<b>rich</b>',plain:'plain'},undefined,{includeSources:['x','plain']}),
  ];
  for(const options of valid){
    const result=checkProject(options);assert.equal(result.ok,true,JSON.stringify(result.errors));
    assert.deepEqual(result.warnings,compileProject(options).warnings);assert.equal('files' in result,false);
  }
});

test('check collects independent errors, contract conflicts, warnings and stable ordering',()=>{
  const options={baseLocale:'en',catalogs:{
    en:{broken:'{name',count:'{n, number}',greet:'{name}',missing:'English',format:'{n, number, nope}',bad:42,child:{oops:false},extra:'base'},
    fr:{broken:'{other}',count:'{n, date}',greet:'{person} {someone}',format:'{n, number, currency}',bad:{child:'text'},child:{oops:{leaf:'text'}},unknown:'new',extra:'<b>unclosed'},
  },scopes:{invalid:[],unmatched:['absent','nothing.*'],'bad/path':['count']}};
  const result=checkProject(options);
  assert.deepEqual(codes(result).filter(x=>x[0]==='en'),[
    ['en','bad','INVALID_CATALOG'],['en','broken','INVALID_ICU'],['en','child.oops','INVALID_CATALOG'],['en','format','UNKNOWN_FORMAT'],
  ]);
  assert.deepEqual(codes(result).filter(x=>x[0]==='fr'),[
    ['fr','count','ARGUMENT_TYPE_CONFLICT'],['fr','extra','INVALID_ICU'],['fr','format','INVALID_FORMAT'],
    ['fr','greet','UNKNOWN_ARGUMENT'],['fr','greet','UNKNOWN_ARGUMENT'],['fr','unknown','UNKNOWN_MESSAGE'],
  ]);
  assert.deepEqual(result.warnings.map(d=>d.messageId),['missing']);
  assert.equal(result.errors.filter(d=>d.code==='EMPTY_SCOPE_PATTERN').length,2);
  assert.equal(result.errors.filter(d=>d.code==='INVALID_SCOPE').length,2);
  const reversed={...options,catalogs:Object.fromEntries(Object.entries(options.catalogs).reverse().map(([locale,catalog])=>[locale,Object.fromEntries(Object.entries(catalog).reverse())]))};
  assert.deepEqual(checkProject(reversed),result);
  const strict=checkProject({...options,missing:'error'});
  assert.equal(strict.warnings.length,0);assert.ok(strict.errors.some(d=>d.code==='MISSING_MESSAGE'&&d.messageId==='missing'));
  const merge={baseLocale:'en',catalogs:{en:{x:'{n}'},de:{x:'{n, number}'},fr:{x:'{n, date}'}}};
  assert.deepEqual(codes(checkProject(merge)),[['fr','x','ARGUMENT_TYPE_CONFLICT']]);
});

test('broken base catalogs and translated subtrees suppress dependent errors',()=>{
  for(const base of [null,{'':'ignored'},undefined]){
    const catalogs={fr:{a:'{new}',b:'<b>broken',c:'{n, number, missing}'}};
    if(base!==undefined)catalogs.en=base;
    const result=checkProject({baseLocale:'en',catalogs,scopes:{x:['whatever.*']}});
    assert.equal(result.errors.length,3,JSON.stringify(result.errors));
    assert.ok(result.errors.some(d=>d.code==='INVALID_ICU'));assert.ok(result.errors.some(d=>d.code==='UNKNOWN_FORMAT'));
    assert.ok(!result.errors.some(d=>['UNKNOWN_MESSAGE','UNKNOWN_ARGUMENT','EMPTY_SCOPE_PATTERN'].includes(d.code)));
  }
  const result=checkProject({baseLocale:'en',catalogs:{en:{a:{b:'{name}'},x:'text'},fr:{a:null,x:'{broken'}},missing:'error'});
  assert.deepEqual(codes(result),[['fr','a','INVALID_CATALOG'],['fr','x','INVALID_ICU']]);
  const scope=checkProject({baseLocale:'en',catalogs:{en:{checkout:{broken:42}}},scopes:{shop:['checkout.*']}});
  assert.deepEqual(codes(scope),[['en','checkout.broken','INVALID_CATALOG']]);
  const duplicate=checkProject({baseLocale:'en',catalogs:{en:{a:{b:'{old}'},'a.b':'{new}'},fr:{'a.b':'{person}'}}});
  assert.deepEqual(codes(duplicate),[['en','a.b','DUPLICATE_KEY']]);
});

test('file validation combines load and ICU errors, maps sources, and never writes output',async t=>{
  const options=await fixture(t,{en:{g:'Hello {name}',n:'{n, number}',omitted:'base'},fr:{g:'Bonjour {person}',n:'{n, number}'},de:'{"bad":',ar:'{no}'});
  const result=await check(options);assert.equal(result.ok,false);assert.equal(result.locales.length,4);
  assert.deepEqual(result.errors.map(d=>d.code),['INVALID_JSON','INVALID_JSON','UNKNOWN_ARGUMENT']);
  const d=result.errors[2];const text=await readFile(d.file,'utf8');assert.equal(d.location.offset,text.indexOf('{person}'));assert.equal(d.location.line,2);
  assert.equal(result.warnings.length,1);assert.equal(result.warnings[0].file,join(options.root,'messages/fr.json'));assert.equal(result.warnings[0].location,undefined);
  assert.deepEqual((await readdir(options.root)).sort(),['messages']);
  // Read failures are collected and the exact read snapshot supplies coordinates.
  let reads=0;
  const changed=await check(options,async file=>{reads++;if(file.endsWith('/de.json'))throw new Error('denied');return readFile(file,'utf8');});
  assert.equal(reads,4);assert.ok(changed.errors.some(d=>d.code==='CATALOG_READ_ERROR'&&d.locale==='de'));
  await writeFile(join(options.root,'messages/en.json'),'{');
  const noBase=await check(options);assert.ok(noBase.errors.some(d=>d.code==='INVALID_JSON'&&d.locale==='en'));
  assert.ok(!noBase.errors.some(d=>['BASE_LOCALE_MISSING','UNKNOWN_MESSAGE','UNKNOWN_ARGUMENT'].includes(d.code)));
  const valid=await fixture(t,{en:{g:'Hello'},fr:{g:'Salut'}});await generate(valid);
  const file=join(valid.root,'generated/locales/en.js'),before=await stat(file,{bigint:true}),content=await readFile(file,'utf8');
  assert.equal((await check({...valid,outDir:'messages'})).ok,true);
  assert.equal((await stat(file,{bigint:true})).mtimeNs,before.mtimeNs);assert.equal(await readFile(file,'utf8'),content);
  const absent=await check({...valid,catalogs:'absent'});assert.equal(absent.errors[0].code,'CATALOG_READ_ERROR');
});

test('batch source locations stay exact for many errors in minified and multiline catalogs',async t=>{
  const catalog=Object.fromEntries(Array.from({length:500},(_,i)=>[`key${i}`,`😀 \\ "line"\n\t\u2028 ${i} {name`]));
  for(const pretty of [undefined,2]){
    const text=JSON.stringify(catalog,null,pretty).replaceAll('key','k\\u0065y');
    const options=await fixture(t,{en:text});const result=await check(options);
    assert.equal(result.errors.length,500);
    for(const d of result.errors){
      assert.equal(d.code,'INVALID_ICU');assert.equal(text.slice(d.location.offset,d.location.offset+5),'{name');
      assert.equal(d.location.line,pretty?Number(d.messageId.slice(3))+2:1);
      assert.ok(d.frame.length<270);
    }
    assert.equal(new Set(result.errors.map(d=>d.location.offset)).size,500);
  }
});

test('CLI check supports human diagnostics, versioned JSON, strict CI and config failures',async t=>{
  const options=await fixture(t,{en:{g:'Hello {name}',only:'English'},fr:{g:'Bonjour {person}'}});
  await writeFile(join(options.root,'nordbeam-i18n.config.json'),JSON.stringify({baseLocale:'en',outDir:'generated'}));
  const cli=(...args)=>spawnSync(process.execPath,[resolve('dist/cli.js'),'check',...args],{cwd:options.root,encoding:'utf8'});
  let result=cli('--json');assert.equal(result.status,1);assert.equal(result.stderr,'');
  let json=JSON.parse(result.stdout);assert.equal(json.version,1);assert.equal(json.ok,false);assert.equal(json.errors[0].code,'UNKNOWN_ARGUMENT');
  result=cli();assert.equal(result.status,1);assert.match(result.stderr,/fr\.json:2:/);assert.match(result.stderr,/\^/);assert.match(result.stdout,/1 error, 1 warning\./);
  await writeFile(join(options.root,'messages/fr.json'),JSON.stringify({g:'Bonjour {name}'}));
  result=cli('--json');assert.equal(result.status,0);json=JSON.parse(result.stdout);assert.equal(json.ok,true);assert.equal(json.warnings.length,1);
  result=cli('--strict','--json');assert.equal(result.status,1);assert.equal(JSON.parse(result.stdout).errors[0].code,'MISSING_MESSAGE');
  assert.deepEqual((await readdir(options.root)).sort(),['messages','nordbeam-i18n.config.json']);
  await writeFile(join(options.root,'nordbeam-i18n.config.json'),'false');
  result=cli('--json');assert.equal(result.status,1);assert.equal(JSON.parse(result.stdout).errors[0].code,'INVALID_CONFIG');
  result=cli('--watch','--json');assert.equal(result.status,2);assert.match(JSON.parse(result.stdout).errors[0].message,/one-shot/);
  result=spawnSync(process.execPath,[resolve('dist/cli.js'),'--json'],{cwd:options.root,encoding:'utf8'});assert.equal(result.status,2);assert.match(result.stderr,/available with nordbeam-locale check/);
});
