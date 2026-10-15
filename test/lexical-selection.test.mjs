import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseAst } from 'rolldown/parseAst';
import { build } from 'vite';
import { inferSelections } from '../dist/infer-selections.js';
import { Selections } from '../dist/selection.js';
import { compileProject } from '../dist/compiler.js';
import { nordbeamLocale } from '../dist/vite.js';
import { fasti18n as before } from './baselines/before_lexical_selections_v0_2/vite.js';
import { temporary } from './helpers.mjs';

test('inference resolves lexical bindings across functions, defaults, blocks, loops and classes',()=>{
  const prefix='import {loadLocale} from "./i18n/index.js";';
  const outer='const {messages:m}=await loadLocale("en");';
  const cases=[
    ['async function a(){const {messages:m}=await loadLocale("en");m.alpha();} async function b(){const {messages:m}=await loadLocale("en");m.beta();}',[['alpha'],['beta']]],
    [outer+'function f(m){m.other();} m.alpha();',[['alpha']]],
    [outer+'function f(x=m.beta()){var m; m.other();} m.alpha();',[['alpha','beta']]],
    [outer+'function f(x=()=>m.beta()){var m; m.other();} m.alpha();',[['alpha','beta']]],
    [outer+'function f({m=m.other()}={}){} m.alpha();',[['alpha']]],
    [outer+'function f(){m.other();if(false){var m;}}m.alpha();',[['alpha']]],
    [outer+'const f=function m(){m.other();};m.alpha();',[['alpha']]],
    [outer+'{const m=local;m.other();}m.alpha();',[['alpha']]],
    [outer+'for(const m of values)m.other();m.alpha();',[['alpha']]],
    [outer+'for(const value of [m.beta()]){const m=local;m.other();}m.alpha();',[['alpha','beta']]],
    [outer+'for(let m=m.other();false;){}m.alpha();',[['alpha']]],
    [outer+'for(let m of m.other()){}m.alpha();',[['alpha']]],
    [outer+'switch(m.alpha()){case "x":const m=local;m.other();}',[['alpha']]],
    [outer+'switch("x"){case m.other():const m=local;}m.alpha();',[['alpha']]],
    [outer+'try{}catch(m){m.other();}m.alpha();',[['alpha']]],
    [outer+'class C{static{var m=local;m.other();}static value=m.alpha();}',[['alpha']]],
    [outer+'const C=class m{[m.name](){return m;}};m.alpha();',[['alpha']]],
    [outer+'class C{[m.beta()](){return m.alpha();}}',[['alpha','beta']]],
    [outer+'m:for(;;){m.alpha();break m;}const x={m:42};',[['alpha']]],
    ['async function f(){const {messages:m}=await loadLocale("en");m.alpha();async function loadLocale(){return other;}}',[]],
    ['async function f(loadLocale){const {messages:m}=await loadLocale("en");m.alpha();}',[]],
    ['const f=async function loadLocale(){const {messages:m}=await loadLocale("en");m.alpha();};',[]],
    [outer+'function f(x=()=>m){var m;}m.alpha();',[]],
    [outer+'function f(){return m;}m.alpha();',[]],
    [outer+'eval("m.beta()");m.alpha();',[]],
    [outer+'@decorate(m) class C{}m.alpha();',[]],
    ['async function f(){const {messages:m}=await loadLocale("en");return m.alpha();}async function g(){const {messages:m}=await loadLocale("en");return m;}',[['alpha']]],
  ];
  for(const [source,expected] of cases)assert.deepEqual([...inferSelections(parseAst(prefix+source),new Set(['loadLocale'])).values()],expected,source);
});

const bodies=[
  `const {messages:m}=await loadLocale('en');function read(first=m.beta()){var m={other:()=>"LOCAL"};return[first,m.other()];}return[m.alpha(),...read()];`,
  `const {messages:m}=await loadLocale('en');function read(first=()=>m.beta()){var m={other:()=>"LOCAL"};return first();}return[m.alpha(),read()];`,
  `const {messages:m}=await loadLocale('en');const result=[];for(const m of [{other:()=>"LOCAL"}])result.push(m.other());for(const value of [m.beta()]){const m={other:()=>"INNER"};result.push(value,m.other());}return[m.alpha(),...result];`,
  `const {messages:m}=await loadLocale('en');let result;switch(m.alpha()){case 'ALPHA':const m={other:()=>"LOCAL"};result=m.other();}return[result,m.beta()];`,
  `const {messages:m}=await loadLocale('en');const errors=[];try{for(let m of m.other()){} }catch(error){errors.push(error.name);}try{switch('x'){case m.other():const m={};}}catch(error){errors.push(error.name);}return[m.alpha(),...errors];`,
  `const {messages:m}=await loadLocale('en');class C{static{var m={other:()=>"LOCAL"};this.local=m.other();}static value=m.alpha();[m.beta()](){return m.alpha();}}const D=class m{static value=m.name;};return[C.local,C.value,new C().BETA(),D.value];`,
  `const {messages:m}=await loadLocale('en');async function custom(loadLocale){const {messages:m}=await loadLocale('en');return m.other();}return[m.alpha(),await custom(async()=>({messages:{other:()=>"LOCAL"}}))];`,
  `const {messages:m}=await loadLocale('en');let value;{value=(await loadLocale()).messages.other();async function loadLocale(){return{messages:{other:()=>"LOCAL"}};}}return[m.alpha(),value];`,
  `const {messages:m}=await loadLocale('en');function local(){return typeof loadLocale;var loadLocale;}const f=function m(){return m.name;};return[m.alpha(),local(),f()];`,
  `class C{static async loadLocale(){const {messages:m}=await loadLocale('en');return m.beta();}}const {messages:m}=await loadLocale('en');return[m.alpha(),await C.loadLocale()];`,
];

test('lexical pruning preserves executable JavaScript scope semantics and removes unused messages',async t=>{
  const root=await temporary(t);await mkdir(join(root,'messages'));await mkdir(join(root,'src'));
  await writeFile(join(root,'package.json'),'{"type":"module"}');
  await writeFile(join(root,'messages/en.json'),JSON.stringify({alpha:'ALPHA',beta:'BETA',unused:'UNUSED_SENTINEL'}));
  const source='import {loadLocale} from "./i18n/index.js";'+bodies.map((body,i)=>`export async function run${i}(){${body}}`).join('\n');
  await writeFile(join(root,'src/main.js'),source);
  const outcomes=[];
  for(const [variant,plugin] of [['before',before],['current',nordbeamLocale]]){
    const result=await build({root,configFile:false,logLevel:'silent',plugins:[plugin()],build:{outDir:variant,ssr:true,minify:false,rollupOptions:{input:join(root,'src/main.js'),preserveEntrySignatures:'strict',output:{entryFileNames:'entry.js'}}}});
    const code=result.output.filter(item=>item.type==='chunk').map(item=>item.code).join('\n');
    if(variant==='before')assert.match(code,/UNUSED_SENTINEL/);else assert.doesNotMatch(code,/UNUSED_SENTINEL/);
    const entry=await import(pathToFileURL(join(root,variant,'entry.js')));
    outcomes.push(await Promise.all(bodies.map((_,i)=>entry[`run${i}`]())));
  }
  assert.deepEqual(outcomes[1],outcomes[0]);
  assert.deepEqual(outcomes[1],[['ALPHA','BETA','LOCAL'],['ALPHA','BETA'],['ALPHA','LOCAL','BETA','INNER'],['LOCAL','BETA'],['ALPHA','ReferenceError','ReferenceError'],['LOCAL','ALPHA','ALPHA','m'],['ALPHA','LOCAL'],['ALPHA','LOCAL'],['ALPHA','undefined','m'],['ALPHA','BETA']]);
});

test('direct eval leaves explicit and inferred imports untouched',async()=>{
  const project={...compileProject({baseLocale:'en',catalogs:{en:{alpha:'ALPHA',beta:'BETA'}}}),outDir:'/fixture/src/i18n'};
  const selections=new Selections(()=>project);
  for(const code of [
    'import {selectMessages as choose} from "./i18n/index.js";export const load=choose("alpha");export const other=eval("choose");',
    'import {loadLocale} from "./i18n/index.js";const {messages:m}=await loadLocale("en");m.alpha();eval("m.beta()");',
  ])assert.equal(await selections.transform(code,'/fixture/src/main.js',parseAst,async()=>'/fixture/src/i18n/index.js',()=>{}),undefined);
});
