import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { IntlMessageFormat } from 'intl-messageformat';
import { compileProject, compileSelection, createCompiler } from '../dist/compiler.js';
import { compiled } from './helpers.mjs';

const loadSource=async source=>(await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))).default;
const locales=['en','fr','ar','pl','ru','cy','ja'];
const catalog={
  greeting:'Hello <strong>{name}</strong>!',
  nested:'<link>Open <strong>{name}</strong> now</link>',
  repeated:'<strong>A</strong><strong>B</strong>',
  empty:'<strong></strong>',
  quoted:"'<em>' '{name}' <strong>{name}</strong> '</em>'",
  plural:'Before {n, plural, =0 {none} one {<strong># item</strong>} other {<link># items</link>}} after',
  offset:'{n, plural, offset:1 =0 {<strong>nobody</strong>} one {<link>outer # {inner, plural, one {inner <strong>#</strong>} other {inner #}} outer #</link>} other {<strong># guests</strong>}}',
  select:'{choice, select, a {<strong>{n, number, percent}</strong>} b {<link>{d, date, short}</link>} other {No formatting}}',
  ordinal:'{n, selectordinal, one {<strong>#st</strong>} two {#nd} few {#rd} other {<strong>#th</strong>}}',
};

test('compiled rich parts match FormatJS trees across locales, nesting, plurals and selections', async t=>{
  const project=await compiled(t,{baseLocale:'en',catalogs:Object.fromEntries(locales.map(locale=>[locale,catalog])),timeZone:'UTC'});
  let comparisons=0;
  for(const locale of locales){
    const full=(await project.load(`locales/${locale}.js`)).default;
    const selected=await loadSource(compileSelection(project,'index.js',locale,Object.keys(catalog)));
    const reference=Object.fromEntries(Object.entries(catalog).map(([key,source])=>[key,new IntlMessageFormat(source,locale,undefined,{formatters:{
      getNumberFormat:(l,o)=>new Intl.NumberFormat(l,o),getPluralRules:(l,o)=>new Intl.PluralRules(l,o),
      getDateTimeFormat:(l,o)=>new Intl.DateTimeFormat(l,{...o,timeZone:'UTC'}),
    }})]));
    for(const n of [-1,0,0.5,1,2,3,4,5,11,21,100,NaN,Infinity])for(const choice of ['a','b','other']){
      const args={n,inner:3,choice,name:'عائشة 👩🏽‍💻 <script> $parts $f0',d:new Date('2026-01-02T13:04:05Z'),
        strong:children=>({tag:'strong',children}),link:children=>({tag:'link',children})};
      for(const key of Object.keys(catalog)){
        const output=reference[key].format(args),expected=Array.isArray(output)?output:[output];
        assert.deepEqual(full[key](args),expected,`${locale}/${key}/${n}/${choice}`);
        assert.deepEqual(selected[key](args),expected,`selected ${locale}/${key}/${n}/${choice}`);
        comparisons+=2;
      }
    }
  }
  t.diagnostic(`${comparisons} rich full/selected tree comparisons`);
});

test('rich contracts validate slots, preserve fallback and omit rich helpers from plain selections',async t=>{
  const project=await compiled(t,{baseLocale:'en',catalogs:{en:{plain:'Text',rich:'Hi <strong>{name}</strong>',count:'<strong>{n, number}</strong>'},fr:{plain:'Texte',rich:'Bonjour {name}'}},development:true});
  const fr=(await project.load('locales/fr.js')).default;
  const args={name:'Ada',strong:children=>({children})};
  assert.deepEqual(fr.rich(args),['Bonjour Ada']);
  assert.deepEqual(fr.count({n:1234.5,strong:children=>({children})}),[{children:['1,234.5']}]);
  const en=(await project.load('locales/en.js')).default;
  assert.throws(()=>en.rich({name:'Ada'}),/strong.*slot function/);
  assert.throws(()=>en.rich({name:'Ada',strong:'b'}),/strong.*slot function/);
  assert.throws(()=>en.rich(Object.assign(Object.create({strong:args.strong}),{name:'Ada'})),/strong.*slot function/);
  assert.equal(en.plain(),'Text');
  assert.doesNotMatch(compileSelection(project,'index.js','en',['plain']),/\$parts/);
  for(const source of ['<strong>{strong}</strong>','{strong}<strong>text</strong>','<strong>{strong, number}</strong>']){
    assert.throws(()=>compileProject({baseLocale:'en',catalogs:{en:{bad:source}}}),/ARGUMENT_TYPE_CONFLICT/);
  }
  assert.throws(()=>compileProject({baseLocale:'en',catalogs:{en:{message:'<strong>A</strong>'},fr:{message:'<link>A</link>'}}}),/UNKNOWN_ARGUMENT/);
  assert.throws(()=>compileProject({baseLocale:'en',catalogs:{en:{message:'<a href="https://example.com">Link</a>'}}}),/INVALID_ICU/);
});

test('rich incremental assembly agrees with cold output through slot, formatter and schema edits',()=>{
  for(const maxMessageCacheBytes of [0,256,64*1024*1024]){
    const compile=createCompiler({maxMessageCacheBytes});
    const options={baseLocale:'en',catalogs:{en:{a:'<b>{n, number}</b> <i>{name}</i>',z:'Value {n, number}'},fr:{a:'<b>{name}: {n, number}</b><i>!</i>',z:'Valeur {n, number}'}},development:true,scopes:{small:['a']}};
    const verify=()=>{const result=compile(options),cold=compileProject(options);assert.deepEqual(result,cold);for(const locale of ['en','fr'])assert.equal(compileSelection(result,'index.js',locale,['a']),compileSelection(cold,'index.js',locale,['a']));};
    verify();
    for(const source of ['<i>{name}</i>: <b>{n, number, percent}</b>','<b>{n, plural, one {<i>{name} #</i>} other {#}}</b>','<i>{name}</i><b>{n, number}</b> $parts $f1']){options.catalogs.en.a=source;verify();}
    options.catalogs.fr.a='{name}: {n, number}';verify();
    delete options.catalogs.fr.a;verify();
    options.catalogs.en.a='<b>{name}</b> <i>{n, number}</i> <link>New slot</link>';verify();
    options.catalogs.en.a='{name}: {n, number}';verify();
    options.catalogs.en.a='<b>{name}</b> {n, number}';verify();
    options.catalogs.en.a='<b>{name}</i>';assert.throws(()=>compile(options),/INVALID_ICU/);
    options.catalogs.en.a='<b>{name}</b> {n, number}';verify();
  }
});

test('generated rich types and React helper infer required slots, values and selected contracts',async t=>{
  const project=await compiled(t,{baseLocale:'en',catalogs:{en:{plain:'Text',code:'Your code is {code}.',count:'{n, number} items',choice:'{g, select, a {A} other {B}} {name}',rich:'Hello <strong>{name}</strong>, <link>{n, number}</link>'},fr:{plain:'Texte',code:'Votre code est {code}.',count:'{n, number} articles',choice:'{g, select, a {A} other {B}} {name}',rich:'Bonjour <link>{name}</link><strong>{n, number}</strong>'}},scopes:{small:['rich']}});
  await symlink(resolve('node_modules'),join(project.dir,'node_modules'),'dir');
  await writeFile(join(project.dir,'consumer.ts'),`
import { selectMessages } from './index.js';
import {rich} from ${JSON.stringify(resolve('packages/locale/dist/react.js'))};
import {createElement as h} from 'react';
const {messages:m}=await selectMessages('rich')('fr');
type Node={tag:string;children:Array<string|Node>};
const tree:Array<string|Node>=m.rich<Node>({name:'Ada',n:2,strong:children=>({tag:'strong',children}),link:children=>({tag:'link',children})});
rich(m.rich,{name:'Ada',n:2,strong:children=>h('strong',null,children),link:children=>h('a',{href:'/docs'},children)});
// @ts-expect-error required slot
rich(m.rich,{name:'Ada',n:2,strong:children=>h('strong',null,children)});
// @ts-expect-error wrong value type
rich(m.rich,{name:'Ada',n:'two',strong:children=>h('strong',null,children),link:children=>h('a',null,children)});
// @ts-expect-error invented slot
rich(m.rich,{name:'Ada',n:2,strong:children=>h('strong',null,children),link:children=>h('a',null,children),wrong:()=>null});
// @ts-expect-error callbacks must return a React node
rich(m.rich,{name:'Ada',n:2,strong:()=>({bad:true}),link:()=>null});
// @ts-expect-error required value
m.rich<Node>({n:2,strong:children=>({tag:'strong',children}),link:children=>({tag:'link',children})});
// @ts-expect-error selection excludes plain
m.plain();
import plain from './locales/en.js';
// @ts-expect-error ordinary string functions do not need the rich helper
rich(plain.plain,{});
// A plain argument also takes a React element, with or without tags in the message.
rich(plain.code,{code:h('b',null,'X')});
rich(plain.code,{code:'X'});
rich(m.rich,{name:h('em',null,'Ada'),n:2,strong:children=>h('strong',null,children),link:children=>h('a',null,children)});
rich(plain.choice,{g:'a',name:h('em',null,'Ada')});
// @ts-expect-error number arguments take no element
rich(m.rich,{name:'Ada',n:h('b',null,'2'),strong:children=>h('strong',null,children),link:children=>h('a',null,children)});
// @ts-expect-error select arguments take no element
rich(plain.choice,{g:h('b',null,'a'),name:'Ada'});
// @ts-expect-error a message with only number arguments does not need the rich helper
rich(plain.count,{n:2});
import scoped from './scopes/small/locales/fr.js';
rich(scoped.rich,{name:'Ada',n:2,strong:children=>h('strong',null,children),link:children=>h('a',null,children)});
`);
  const result=spawnSync(resolve('node_modules/.bin/tsc'),['--ignoreConfig','--noEmit','--strict','--skipLibCheck','--module','nodenext','--target','es2022',join(project.dir,'consumer.ts')],{encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+result.stderr);
});
