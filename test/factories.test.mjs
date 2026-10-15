import test from 'node:test';
import assert from 'node:assert/strict';
import {compileProject,compileSelection,createCompiler} from '../dist/compiler.js';
import {compileProject as beforeCompile,compileSelection as beforeSelection} from './baselines/before_message_factories_v0_2/compiler.js';
import {compileProject as beforeDevCompile,compileSelection as beforeDevSelection} from './baselines/before_dev_factories_v0_2/compiler.js';
import {normalizeLegacyFormatterCacheOutput,normalizeLegacyProject} from './helpers.mjs';
const load=source=>import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const factory=/^const \$f\d+=\(\$s0/gm;

test('repeated templates preserve values, formatter locales, rich trees and declarations',async()=>{
  const en={
    a:'Hello {name}: {n, number}',b:'Welcome {name}: {n, number}',
    c:'{n, plural, one {One: #} other {Many: #}}',d:'{n, plural, one {Single: #} other {Several: #}}',
    e:'<strong>Hello {name}</strong>!',f:'<strong>Welcome {name}</strong>.',
    g:'$s0 "$f0" \\ {name}',h:'$s10 "$f1" \\ {name}',
    then:'Then {name}',default:'Default {name}',
  };
  const options={baseLocale:'en',catalogs:{en,fr:{...en,a:'Salut {name}: {n, number}'}},scopes:{small:['a','b']}};
  delete options.catalogs.fr.b;
  const project=compileProject(options),old=beforeCompile(options);
  assert.ok([...project.files['locales/en.js'].matchAll(factory)].length>=3);
  const legacy=normalizeLegacyProject(project);
  for(const [name,code] of Object.entries(legacy.files))if(!/locales\/[^/]+\.js$/.test(name))assert.equal(code,old.files[name]);
  const args={name:'عائشة 👩🏽‍💻 e\u0301 $s0 </script> \u2028',n:3,strong:children=>({children})};
  for(const locale of ['en','fr']){
    const actual=(await load(project.files[`locales/${locale}.js`])).default,expected=(await load(old.files[`locales/${locale}.js`])).default;
    assert.notEqual(actual.a,actual.b);assert.equal(Object.getPrototypeOf(actual),null);
    for(const id of Object.keys(en))for(const n of [-1,0,1,2,1.5,1000,NaN,Infinity])assert.deepEqual(actual[id]({...args,n}),expected[id]({...args,n}));
  }
  assert.match(compileProject({...options,development:true}).files['locales/en.js'],factory);
});

test('development factories preserve exact validation errors, message identity and fallback across projections',async()=>{
  const en=Object.fromEntries([
    ['first','Hello {name}: {n, number}'],['second','Welcome {name}: {n, number}'],
    ['numberA','{n, number}'],['numberB','{n, number}'],
    ['dateA','First {d, date, short}'],['dateB','Second {d, date, short}'],
    ['choiceA','{choice, select, a {First {name}} other {Other {name}}}'],['choiceB','{choice, select, a {Next {name}} other {Last {name}}}'],
    ['richA','<strong>Hello {name}</strong>'],['richB','<strong>Welcome {name}</strong>'],
    ['__proto__','Prototype {name}'],['then','Then {name}'],['default','Default {name}'],
    ['quote"\\\n$s0\u2028👩🏽‍💻','Literal $s0 "$f0" {name}'],['fallback','Fallback {name}: {n, number}'],
  ]);
  const fr={...en,first:'Bonjour {name}: {n, number}'};delete fr.fallback;
  const options={baseLocale:'en',development:true,timeZone:'UTC',catalogs:{en,fr},scopes:{one:['first'],mixed:['second','first','richA','richB','fallback']}};
  const actual=compileProject(options),before=beforeDevCompile(options),keys=Object.keys(en);
  const capture=fn=>{try{return {value:fn()};}catch(error){return {error:error.constructor.name,message:error.message};}};
  // Development output now names the message for invalid Dates; the frozen baseline threw Intl's bare RangeError.
  const upgraded=(result,locale,id)=>result.error==='RangeError'&&result.message==='Invalid time value'?{error:'TypeError',message:`${locale}:${id}: argument "d" must be a valid Date`}:result;
  const valid={name:'Ada $s0 \u2028',n:3,d:new Date('2026-01-02T00:00:00Z'),choice:'a',strong:children=>({strong:children})};
  const args=[undefined,null,false,3,'text',[],{},()=>{},Object.create(valid),valid,
    {...valid,name:Symbol('name')},{...valid,n:'3'},{...valid,n:NaN},{...valid,n:Infinity},
    {...valid,d:'today'},{...valid,d:new Date(NaN)},{...valid,choice:3},{...valid,strong:'b'},
    {...valid,strong:()=>{throw new RangeError('slot failure');}},
    Object.defineProperty({...valid},'name',{get(){throw new Error('getter failure');}})];
  assert.match(actual.files['locales/en.js'],factory);
  const legacy=normalizeLegacyProject(actual);
  for(const [file,code] of Object.entries(before.files))if(!/locales\/[^/]+\.js$/.test(file))assert.equal(legacy.files[file],code);
  for(const locale of ['en','fr'])for(const selection of [keys,['first'],['second','first','richB','richA','fallback'],['numberA','numberB']]){
    const code=normalizeLegacyFormatterCacheOutput(compileSelection(actual,'index.js',locale,selection)),oldCode=beforeDevSelection(before,'index.js',locale,selection);
    const current=(await load(code)).default,old=(await load(oldCode)).default;
    assert.deepEqual(Object.keys(current),selection);
    for(const id of selection)for(const input of args)assert.deepEqual(capture(()=>current[id](input)),capture(()=>old[id](input)),`${locale}:${id}`);
    if(selection.length===1)assert.doesNotMatch(code,factory);
  }
  for(const file of Object.keys(actual.files).filter(file=>/locales\/[^/]+\.js$/.test(file)&&!file.includes('internal/locales/'))){
    const current=(await load(actual.files[file])).default,old=(await load(before.files[file])).default;
    for(const id of Object.keys(old))for(const input of args)assert.deepEqual(capture(()=>current[id](input)),upgraded(capture(()=>old[id](input)),file.match(/locales\/([^/]+)\.js$/)[1],id),`${file}:${id}`);
    if(current.first&&current.second)assert.notEqual(current.first,current.second);
  }
});

test('inlined development validation preserves escaped labels and direct selection bytes',async()=>{
  for(const id of ['end\\','quote"','</script>\u2028\u2029','lone\ud800','lone\udc00','$s0+"suffix"']){
    const options={baseLocale:'en',development:true,catalogs:{en:{[id]:'Hello {name}',other:'Welcome {name}'}}};
    const project=compileProject(options),old=beforeDevCompile(options);
    const selected=compileSelection(project,'index.js','en',[id]);
    assert.equal(normalizeLegacyFormatterCacheOutput(selected),beforeDevSelection(old,'index.js','en',[id]));
    const direct=(await load(selected)).default[id],shared=(await load(compileSelection(project,'index.js','en',[id,'other']))).default[id];
    for(const message of [direct,shared]){
      assert.equal(message({name:'Ada'}),'Hello Ada');
      assert.throws(()=>message(),{name:'TypeError',message:`en:${id}: expected message arguments`});
      assert.throws(()=>message({name:false}),{name:'TypeError',message:`en:${id}: argument "name" must be string or number`});
    }
    options.catalogs.en.other='No arguments';
    assert.equal(compileSelection(compileProject(options),'index.js','en',[id]),selected);
  }
});

test('one-off selected templates inline and unrelated template edits leave selected bytes stable',async()=>{
  for(const development of [false,true]){
  const options={baseLocale:'en',development,catalogs:{en:{a:'First {n, number}',b:'Second {n, number}',c:'Third {n, number}',r:'<b>Hello {name}</b>',s:'<b>Welcome {name}</b>',odd:'$s0 {name}',other:'$s1 {name}'}}};
  const project=compileProject(options),old=beforeCompile(options),keys=['a','r','odd'];
  const selected=compileSelection(project,'index.js','en',keys);
  const expected=(await load(beforeSelection(old,'index.js','en',keys))).default;
  const actual=(await load(selected)).default;
  for(const n of [0,1,3])for(const key of keys){
    const args={n,name:'Ada $s0',b:children=>({children})};
    assert.deepEqual(actual[key](args),expected[key](args));
  }
  assert.doesNotMatch(selected,factory);
  for(const change of ['Second {n, number, percent}','{n, number}','Text only']){
    options.catalogs.en.b=change;assert.equal(compileSelection(compileProject(options),'index.js','en',keys),selected);
  }
  const both=compileSelection(project,'index.js','en',['b','a','b']);assert.equal([...both.matchAll(factory)].length,1);
  assert.doesNotMatch(both,/Third|Welcome|\$parts/);
  const messages=(await load(both)).default;assert.equal(messages.a({n:3}),'First 3');assert.deepEqual(Object.keys(messages),['b','a']);
  // Crossing the last shared-contract boundary must not change a selection
  // whose own message and arguments stayed identical.
  const small={baseLocale:'en',development,catalogs:{en:{a:'Hello {name}',b:'Welcome {name}'}}};
  const first=compileSelection(compileProject(small),'index.js','en',['a']);
  small.catalogs.en.b='Static';assert.equal(compileSelection(compileProject(small),'index.js','en',['a']),first);
  }
});

test('incremental factories cross one/two-use boundaries and renumber dependencies exactly',()=>{
  for(const maxMessageCacheBytes of [0,128,64*1024*1024]){
    const compile=createCompiler({maxMessageCacheBytes});
    const options={baseLocale:'en',catalogs:{en:{a:'One {n, number}',b:'Two {n, number}',c:'Three {n, number}',d:'Fourth {n, number, percent}',e:'Fifth {name}',r:'<b>Hello {name}</b>',s:'<b>Welcome {name}</b>'}},scopes:{small:['a','b'],single:['a'],different:['a','e']}};
    const verify=()=>{
      const actual=compile(options),expected=compileProject(options);assert.deepEqual(actual,expected);
      for(const keys of [['a'],['a','b','c'],['r','s'],['d','a','r']])assert.equal(compileSelection(actual,'index.js','en',keys),compileSelection(expected,'index.js','en',keys));
      return actual;
    };
    verify();
    for(const [id,value] of [
      ['a','Edited $s0 {n, number}'],['a','Edited {n, number, percent}'], // 3->2, 1->2
      ['b','Changed {n, number, percent}'], // 2->1, 2->3
      ['c','Last {n, number, percent}'], // 1->0
      ['a','Restored {n, number}'],['b','Again {n, number}'], // 0->1->2
      ['r','<b>Hello {name}</b>!'],['s','<b>Welcome {name}</b>.'],
      ['s','{name}'],['r','{name}'],['d','Different {n, number, ::currency/EUR}'],
    ]){options.catalogs.en[id]=value;verify();}
    options.catalogs.en.a='{broken';assert.throws(()=>compile(options),/INVALID_ICU/);
    options.catalogs.en.a='Recovered {n, number}';verify();
    options.catalogs.fr={...options.catalogs.en};delete options.catalogs.fr.a;verify();
    options.catalogs.en.e=options.catalogs.fr.e='Another {n, number}';verify();
    options.catalogs.en.e=options.catalogs.fr.e='Unique {name}';verify();
    options.catalogs.en.a='Base edit {n, number, percent}';verify();
    options.development=true;verify();options.development=false;verify();
  }
});

test('shared base contracts retain independent translated types and select choices',async()=>{
  const options={baseLocale:'en',timeZone:'UTC',catalogs:{
    en:{a:'First {x}',b:'Second {x}',c:'{x, select, a {A} other {Other}}',d:'{x, select, a {A} other {Other}}'},
    fr:{a:'Nombre {x, number}',b:'Date {x, date}',c:'{x, select, b {B} other {Autre}}',d:'{x, select, c {C} other {Autre}}'},
  }};
  for(const development of [false,true]){
    const current=compileProject({...options,development}),before=beforeCompile({...options,development});
    for(const [name,code] of Object.entries(before.files))if(name.endsWith('.d.ts'))assert.equal(normalizeLegacyFormatterCacheOutput(current.files[name]),code);
    for(const locale of ['en','fr']){
      const actual=(await load(current.files[`locales/${locale}.js`])).default,expected=(await load(before.files[`locales/${locale}.js`])).default;
      for(const id of ['a','b'])assert.equal(actual[id]({x:Date.UTC(2026,0,2)}),expected[id]({x:Date.UTC(2026,0,2)}));
      for(const id of ['c','d'])for(const x of ['a','b','c','other'])assert.equal(actual[id]({x}),expected[id]({x}));
    }
  }
});
