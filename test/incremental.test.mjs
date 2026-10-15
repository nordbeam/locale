import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, readFile, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { compileProject, createCompiler, compileSelection } from '../dist/compiler.js';
import { createGenerator, generate } from '../dist/project.js';
import { markGenerated } from '../dist/codegen.js';
import { normalizeLegacyProject, temporary } from './helpers.mjs';
import { compileProject as beforeColdCompile } from './baselines/before_cold_compile_v0_2/compiler.js';

test('cross-locale schema merging isolates messages and recovers conflicts without retaining narrowed types', () => {
  const options={baseLocale:'en',timeZone:'UTC',catalogs:{
    en:{a:'Base {x}',b:'Second {x}',c:'Choice {x}',d:'Other {x}'},
    fr:{a:'Nombre {x, number}',b:'Date {x, date}',c:'{x, select, yes {Oui} other {Autre}}',d:'{x, select, yes {Oui} other {Autre}}'},
    ja:{a:'数 {x, number}',b:'日 {x, date}',c:'{x, select, no {No} other {Other}}',d:'{x, select, maybe {Maybe} other {Other}}'},
  }};
  const diagnostic=fn=>{try{fn();assert.fail('Expected a compilation error');}catch(error){assert.ok(error.diagnostics);return {message:error.message,diagnostics:error.diagnostics};}};
  for(const maxMessageCacheBytes of [0,64*1024*1024])for(const development of [false,true]){
    const current=createCompiler({maxMessageCacheBytes});options.development=development;
    const check=()=>{
      const old=beforeColdCompile(options),expected=compileProject(options);
      if(!development)assert.deepEqual(normalizeLegacyProject(expected),old);
      else { const legacy=normalizeLegacyProject(expected); for(const [file,code] of Object.entries(old.files))if(!/locales\/[^/]+\.js$/.test(file))assert.equal(legacy.files[file],code); }
      assert.deepEqual(current(options),expected);return expected;
    };
    const initial=check(),original=options.catalogs.ja.a;
    options.catalogs.ja.a='Conflict {x, date}';
    assert.deepEqual(diagnostic(()=>current(options)),diagnostic(()=>beforeColdCompile(options)));
    options.catalogs.ja.a=original;assert.deepEqual(check(),initial);
    const fr=options.catalogs.fr.a,ja=options.catalogs.ja.a;
    delete options.catalogs.fr.a;delete options.catalogs.ja.a;
    const widened=check();assert.match(widened.files['messages.d.ts'],/"x": string \| number/);
    options.catalogs.fr.a=fr;options.catalogs.ja.a=ja;assert.deepEqual(check(),initial);
  }
});

test('incremental output equals cold compilation after text, schema, fallback, locale, scope and option changes', () => {
  const compile = createCompiler();
  const options = { baseLocale: 'en', development: true, timeZone: 'UTC', scopes: { page: ['greeting', 'count'] }, catalogs: {
    en: { greeting: 'Hi {name}', count: '{n, plural, one {{d, date, short} # item} other {{n, number} items}}', fallback: 'Base {x, number}', format: '{n, number, integer}' },
    fr: { greeting: 'Salut {name}', count: '{n, plural, one {{d, date, short} # article} other {{n, number} articles}}', format: '{n, number, integer}' },
  } };
  const check = () => {
    const expected = compileProject(options);
    const actual = compile(options);
    assert.deepEqual(actual, expected);
    assert.equal(compileSelection(actual, 'index.js', 'fr', ['greeting', 'count']), compileSelection(expected, 'index.js', 'fr', ['greeting', 'count']));
    return actual;
  };
  const initial = check();
  check();
  options.catalogs.fr.greeting = "Bonjour {name} \u00000\u0000 $f0 '</script>'";
  check();
  options.catalogs.en.fallback = 'Updated base {x, number}';
  check();
  options.catalogs.fr.fallback = 'Translated {x, number}';
  check();
  delete options.catalogs.fr.fallback;
  check();
  options.catalogs.fr.count = '{n, plural, =0 {{d, date, long}} one {# article} other {{n, number, percent} articles}}';
  check();
  options.catalogs.en.greeting = 'Hi {name, select, formal {Hello} other {Hi}}';
  check(); // merged select type also changes French development guards
  options.catalogs.fr.greeting = 'Bonjour {name, select, informal {Salut} other {Bonjour}}';
  check();
  options.catalogs.en.added = '{a} and {b}';
  check();
  options.catalogs.en.added = '{b} and {a}';
  check(); // argument order and message indices must agree with a cold build
  delete options.catalogs.en.added;
  options.catalogs.ar = { ...options.catalogs.fr };
  check();
  delete options.catalogs.ar;
  options.scopes = { page: ['count'], second: ['greeting', 'fallback'] };
  check();
  options.development = false;
  options.timeZone = 'America/New_York';
  options.formats = { number: { integer: {} } };
  check();
  options.formats.number.integer.maximumFractionDigits = undefined;
  check(); // explicit undefined overrides integer's default of 0
  options.formats.number.integer.maximumFractionDigits = NaN;
  assert.throws(() => compile(options), /INVALID_FORMAT/);
  options.formats.number.integer.maximumFractionDigits = 2;
  check();
  options.missing = 'error';
  assert.throws(() => compile(options), /MISSING_MESSAGE/);
  options.missing = 'fallback';
  check();
  options.catalogs.fr.greeting = '{broken';
  assert.throws(() => compile(options), /INVALID_ICU/);
  options.catalogs.fr.greeting = 'Salut {unknown}';
  assert.throws(() => compile(options), /UNKNOWN_ARGUMENT/);
  options.catalogs.fr.greeting = 'Salut {name}';
  check();
  options.catalogs.fr.extra = 'extra';
  assert.throws(() => compile(options), /UNKNOWN_MESSAGE/);
  delete options.catalogs.fr.extra;
  const returned = check();
  returned.files['locales/en.js'] = 'corrupted';
  returned.groups['index.js'].splice(0);
  returned.warnings[0].message = 'corrupted';
  returned.locales.splice(0);
  check();
  assert.ok(initial.files['locales/en.js'].includes('Hi '), 'earlier results are not mutated');
});

test('deterministic mixed ICU edits keep cached formatter numbering and selected code identical', () => {
  const compile = createCompiler();
  const evict = createCompiler({ maxMessageCacheBytes: 256 });
  assert.throws(() => createCompiler({ maxMessageCacheBytes: -1 }), /nonnegative/);
  const templates = [
    'Plain text', 'Hello {name}', '{n, number}', '{n, number, percent}',
    '{n, plural, =0 {zero} one {# one} other {# many}}',
    '{choice, select, a {{n, number, percent}} other {{d, date, short}}}',
    '{n, plural, one {{d, date, short} {n, number}} other {{d, time, short} # {name}}}',
  ];
  const options = { baseLocale: 'en', timeZone: 'UTC', catalogs: { en: {}, fr: {}, ar: {} }, development: true };
  for (let i = 0; i < 40; i++) for (const locale of Object.keys(options.catalogs)) options.catalogs[locale]['m' + i] = templates[i % templates.length];
  let random = 143;
  for (let step = 0; step < 60; step++) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    const id = 'm' + (random % 40);
    for (const locale of Object.keys(options.catalogs)) options.catalogs[locale][id] = `${locale} edit ${step}: ${templates[(random >>> 8) % templates.length]}`;
    if (step % 7 === 0) options.development = !options.development;
    assert.deepEqual(compile(options), compileProject(options), `step ${step}`);
    assert.deepEqual(evict(options), compileProject(options), `evicted step ${step}`);
  }
});

test('generation sessions recover failed edits, repair external output changes and serialize calls', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'messages'));
  const source = join(root, 'messages/en.json');
  await writeFile(source, '{"greeting":"Hello {name}"}');
  const run = createGenerator({ root, baseLocale: 'en' });
  const first = await run();
  const file = join(first.outDir, 'locales/en.js');
  const original = await readFile(file, 'utf8');
  const before = (await stat(file)).mtimeMs;
  assert.deepEqual((await run()).changed, []);
  assert.equal((await stat(file)).mtimeMs, before);
  // Same size with changed content must not be mistaken for an unchanged file.
  await writeFile(file, original.replace('Hello', 'XXXXX'));
  assert.deepEqual((await run()).changed, [file]);
  assert.equal(await readFile(file, 'utf8'), original);
  await unlink(file);
  assert.deepEqual((await run()).changed, [file]);
  const manifest = join(first.outDir, '.nordbeam-locale-manifest.json');
  const ownership = await readFile(manifest, 'utf8');
  await unlink(manifest);
  await writeFile(source, '{"greeting":"Uncommitted {name}"}');
  await assert.rejects(run(), /Refusing to overwrite unowned/);
  await writeFile(manifest, ownership);
  await writeFile(source, '{"greeting":"Hello {name}"}');
  await run();
  assert.equal(await readFile(file, 'utf8'), original, 'a write failure must not commit mismatched source/output caches');
  await writeFile(source, '{"greeting":"{broken"}');
  await assert.rejects(run(), /INVALID_ICU/);
  assert.equal(await readFile(file, 'utf8'), original);
  await writeFile(source, '{invalid');
  await assert.rejects(run(), /INVALID_JSON/);
  await writeFile(source, '{"greeting":"Bonjour {name}"}');
  await Promise.all([run(), run(), run()]);
  assert.match(await readFile(file, 'utf8'), /Bonjour/);
  assert.deepEqual((await run()).changed, []);
  await writeFile(join(root, 'messages/fr.json'), '{"greeting":"Salut {name}"}');
  assert.deepEqual((await run()).locales, ['en', 'fr']);
  await unlink(join(root, 'messages/fr.json'));
  assert.deepEqual((await run()).locales, ['en']);
  await assert.rejects(readFile(join(first.outDir, 'locales/fr.js')), { code: 'ENOENT' });
});

test('generation preserves externally updated matching output when its source changes', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'messages'));
  const source = join(root, 'messages/en.json');
  await writeFile(source, '{"greeting":"Hello {name}"}');
  const run = createGenerator({ root, baseLocale: 'en' });
  const first = await run(), file = join(first.outDir, 'locales/en.js');
  const next = { greeting: 'Already updated {name}' };
  const expected = markGenerated(compileProject({ baseLocale: 'en', catalogs: { en: next } }).files['locales/en.js'], false, 'messages');
  await writeFile(source, JSON.stringify(next));
  await writeFile(file, expected);
  const stamp = await stat(file, { bigint: true });
  const result = await run();
  assert.equal(result.files['locales/en.js'], expected);
  assert.ok(!result.changed.includes(file));
  const after = await stat(file, { bigint: true });
  assert.equal(after.ino, stamp.ino, 'Matching external output must not be replaced');
  assert.equal(after.mtimeNs, stamp.mtimeNs, 'Matching external output must not be rewritten');
  await unlink(file);
  assert.ok((await run()).changed.includes(file));
  assert.equal(await readFile(file, 'utf8'), expected, 'A missing cached output must be recreated');
});

test('private file snapshots match cold output through nested, contract, fallback and failed edits', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'messages'));
  const catalogs = {
    en: {page:{greeting:'Hi {name}', count:'{n, number}'}, fallback:'Base {n, number}', mode:'{choice}'},
    fr: {page:{greeting:'Salut {name}', count:'{n, number}'}, mode:'{choice}'},
    ar: {page:{greeting:'Hello {name}', count:'{n, number}'}, mode:'{choice}'},
  };
  const options = {root, baseLocale:'en', development:true, scopes:{page:['page.*','fallback','mode']}};
  const run = createGenerator(options);
  const save = locale => writeFile(join(root,`messages/${locale}.json`),JSON.stringify(catalogs[locale]));
  for (const locale of Object.keys(catalogs)) await save(locale);
  const check = async () => {
    const actual = await run();
    // Matching directory depth keeps declaration-map relative sources equal.
    const cold = await generate({...options,outDir:'cold/i18n'});
    assert.deepEqual(actual.files,cold.files);
    assert.deepEqual(actual.groups,cold.groups);
    assert.deepEqual(actual.warnings,cold.warnings);
    assert.deepEqual(actual.locales,cold.locales);
    return actual;
  };
  await check();
  for (const [locale,edit] of [
    ['fr',()=>{catalogs.fr.page.greeting='Bonjour {name}';}],
    ['en',()=>{catalogs.en.fallback='Changed fallback {n, number, percent}';}],
    ['fr',()=>{catalogs.fr.fallback='French {n, number}';}],
    ['en',()=>{catalogs.en.fallback='Base changes with one complete and one sparse locale {n, number}';}],
    ['en',()=>{catalogs.en.mode='{choice, select, formal {Formal} other {Other}}';}],
    ['fr',()=>{catalogs.fr.mode='{choice, select, casual {Salut} other {Bonjour}}';}],
    ['ar',()=>{delete catalogs.ar.page.greeting;}],
    ['en',()=>{catalogs.en.page.greeting='Welcome {name}';catalogs.en.aaa='Earlier key';}],
    ['fr',()=>{delete catalogs.fr.fallback;}],
  ]) {edit();await save(locale);await check();}
  const valid = catalogs.fr.page.count;
  catalogs.fr.page.count='{broken';await save('fr');await assert.rejects(run(),/INVALID_ICU/);
  catalogs.fr.page.count='{unknown}';await save('fr');await assert.rejects(run(),/UNKNOWN_ARGUMENT/);
  catalogs.fr.page.count=valid;await save('fr');await check();
  await writeFile(join(root,'messages/fr.json'),JSON.stringify(catalogs.fr,null,2));await check();
  await unlink(join(root,'messages/ar.json'));await check();
  await save('ar');const returned=await check();
  returned.groups['index.js'].splice(0);returned.locales.splice(0);
  returned.files['locales/en.js']='corrupted';await check();
});

test('incremental assembly preserves full bytes across offset shifts, evicted bodies and formatter fallback', () => {
  for (const maxMessageCacheBytes of [0,256,64*1024*1024]) {
    const compile=createCompiler({maxMessageCacheBytes});
    const catalog=Object.assign(Object.create(null),{then:'Then',default:'Default'},
      Object.fromEntries(Array.from({length:100},(_,i)=>[`m${String(i).padStart(3,'0')}`,i%2?'Plain':'Value {n, number}'])));
    // Define the prototype-shaped key as data rather than an object-literal setter.
    catalog.__proto__='Prototype';
    const options={baseLocale:'en',catalogs:{en:catalog,fr:{...catalog}},development:true,
      scopes:{small:['m000','m098','then','default','__proto__']}};
    const check=()=>{
      const actual=compile(options),cold=compileProject(options);
      assert.deepEqual(actual,cold,`cache budget ${maxMessageCacheBytes}`);
      assert.equal(compileSelection(actual,'index.js','en',['m000','m098','then','default']),compileSelection(cold,'index.js','en',['m000','m098','then','default']));
      return actual;
    };
    const initial=check(),initialCode=initial.files['locales/en.js'];
    for(let step=0;step<12;step++){
      catalog.m000=`${'first '.repeat(step%4)}{n, number} \u00000\u0000 $f0 '</script>'`;
      catalog.m098=`${'last '.repeat((step+1)%5)}{n, number}`;
      catalog.then=`Then ${step}\u2028\u2029`;
      catalog.default=`Default ${step}`;
      check();
    }
    catalog.m000='{n, number, percent}';check(); // formatter table changes
    catalog.m098='{n, number, ::currency/EUR}';check();
    catalog.m000='Back to {n, number}';check(); // removes the first formatter
    catalog.m098='Back to {n, number}';check();
    for(let i=0;i<80;i++)catalog[`m${String(i).padStart(3,'0')}`]+=' bulk';
    check(); // bulk edits use full assembly
    catalog.m000='After bulk {n, number}';check();
    catalog.m000='{n, number, unknownStyle}';assert.throws(()=>compile(options),/UNKNOWN_FORMAT/);
    catalog.m000='Recovered {n, number}';check();
    delete options.catalogs.fr.m000;check(); // base fallback participates in both outputs
    catalog.m000='Updated fallback {n, number}';check();
    assert.equal(initial.files['locales/en.js'],initialCode,'later patches must not mutate earlier results');
  }
});

test('formatter edits renumber unchanged definitions without rewriting quoted text or retaining old styles', async () => {
  for (const maxMessageCacheBytes of [0,256,64*1024*1024]) {
    const number=Object.fromEntries(Array.from({length:14},(_,i)=>[`s${i}`,{minimumFractionDigits:i,maximumFractionDigits:i}]));
    number.invalid={style:'currency',currency:'INVALID'};
    const catalog=Object.fromEntries(Array.from({length:40},(_,i)=>[`m${String(i).padStart(2,'0')}`,
      `Quoted "$f0 $f9 $f10 $f10Cache $literal" \\ {n, number, s${i%13}}`]));
    catalog['$f10']='An export named $f10';
    catalog.then='Then';catalog.default='Default';
    const options={baseLocale:'en',catalogs:{en:catalog,fr:{...catalog}},formats:{number},development:true,
      scopes:{small:['m00','m12','m39','$f10','then','default']}};
    const compile=createCompiler({maxMessageCacheBytes});
    const verify=()=>{
      const actual=compile(options),cold=compileProject(options);
      assert.deepEqual(actual,cold,`formatter edits, cache budget ${maxMessageCacheBytes}`);
      assert.equal(compileSelection(actual,'index.js','en',['m00','m12','m39','$f10']),compileSelection(cold,'index.js','en',['m00','m12','m39','$f10']));
      return actual;
    };
    verify();
    // Move first-use order across single-/double-digit helper names. Repeated
    // styles and multiple changed definitions exercise sequence interning.
    for(let step=0;step<24;step++){
      catalog.m00=`Changed ${step}: {n, number, s${step%14}}`;
      catalog.m01=`Changed ${step}: {n, number, s${(step+5)%14}}`;
      if(step%3===0)catalog.m02='{n, plural, =0 {{n, number, s12}} one {# item} other {{n, number, s7}}}';
      else catalog.m02=`Reordered {n, number, s${step%14}} {n, number, s${(step+1)%14}}`;
      verify();
    }
    // A failed Intl option must not poison the previous assembly metadata.
    catalog.m00='{n, number, invalid}';
    assert.throws(()=>compile(options),/INVALID_FORMAT/);
    catalog.m00='Recovered {n, number, s1}';
    const final=verify();
    const actual=await import('data:text/javascript,'+encodeURIComponent(final.files['locales/en.js']));
    assert.equal(actual.default.m39({n:2}),`Quoted "$f0 $f9 $f10 $f10Cache $literal" \\ ${new Intl.NumberFormat('en',number.s0).format(2)}`);
    assert.equal(actual.default['$f10'](),'An export named $f10');
  }
});
