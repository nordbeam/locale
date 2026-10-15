import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {compileProject,CompileError,createCompiler,formatDiagnostic} from '../dist/compiler.js';
import {generate,createGenerator} from '../dist/project.js';
import {temporary,waitFor} from './helpers.mjs';

async function fixture(t,en,fr=en){
  const root=await temporary(t);await mkdir(join(root,'messages'));
  await writeFile(join(root,'messages/en.json'),en);await writeFile(join(root,'messages/fr.json'),fr);
  return {root,baseLocale:'en',outDir:'generated'};
}

test('ICU diagnostics explain the parser reason and locate cached cross-locale arguments',()=>{
  assert.throws(()=>compileProject({baseLocale:'en',catalogs:{en:{items:'{n, plural, one {one}}'}}}),error=>{
    const diagnostic=error.diagnostics[0];
    assert.equal(diagnostic.code,'INVALID_ICU');assert.equal(diagnostic.reason,'MISSING_OTHER_CLAUSE');
    assert.match(diagnostic.message,/missing its other branch/);assert.match(diagnostic.hint,/other/);
    assert.equal(diagnostic.offset,21);assert.equal(diagnostic.file,undefined);
    assert.match(formatDiagnostic(diagnostic),/\^/);
    assert.equal([diagnostic].map(formatDiagnostic)[0],formatDiagnostic(diagnostic));return true;
  });
  const compile=createCompiler();const options={baseLocale:'en',catalogs:{en:{greeting:'Hello {name}'},fr:{greeting:'Bonjour {name}'}}};
  compile(options);options.catalogs.en.greeting='Hello';
  assert.throws(()=>compile(options),error=>{
    const d=error.diagnostics[0];assert.equal(d.code,'UNKNOWN_ARGUMENT');assert.equal(d.locale,'fr');
    assert.equal(d.offset,8);assert.equal(d.source,'Bonjour {name}');return true;
  });
});

test('file diagnostics map JSON escapes and Unicode to exact catalog coordinates',async t=>{
  const variants=[
    'Prefix 😀 "quoted" \\ tab\t newline\n<b>{name}</i>',
    'Prefix 😀 CRLF\r\n<b>{name}</i>',
    'Prefix\u2028separator\u2029<b>{name}</i>',
  ];
  for(const [index,message] of variants.entries()){
    const encoded=JSON.stringify(message).replace('Prefix','\\u0050refix').replace('😀','\\ud83d\\ude00');
    const text=`{\r\n\t"checkout": {\r\n\t\t"greet\\u0069ng": ${encoded}\r\n\t}\r\n}\r\n`;
    const options=await fixture(t,text);
    const wanted=text.indexOf('</i>')+2;
    await assert.rejects(generate(options),error=>{
      assert.ok(error instanceof CompileError);const d=error.diagnostics[0];
      assert.equal(d.messageId,'checkout.greeting');assert.equal(d.location.offset,wanted);
      assert.equal(d.location.line,3,'JSON editor lines do not split at raw LS/PS characters');
      const lastBreak=text.lastIndexOf('\n',wanted-1);
      assert.equal(d.location.column,wanted-lastBreak);
      assert.equal(d.file,join(options.root,'messages/en.json'));assert.match(d.frame,/\^/);
      if(index===2){assert.ok(d.frame.includes('\\u2028'));assert.ok(d.frame.includes('\\u2029'));}
      assert.ok(error.message.includes(`${d.file}:${d.location.line}:${d.location.column}`));
      assert.doesNotMatch(error.message,/\(message /);return true;
    });
  }
});

test('file errors cover contracts, JSON/read failures and recovery without replacing good output',async t=>{
  const options=await fixture(t,'{"greeting":"Hello {name}"}','{"greeting":"Bonjour {name}"}');
  const run=createGenerator(options);await run();
  const file=join(options.root,'messages/fr.json'),output=join(options.root,'generated/locales/fr.js');
  const previous=await readFile(output,'utf8');
  const text='{\n  "greeting": "Bonjour {person}"\n}\n';await writeFile(file,text);
  await assert.rejects(run(),error=>{
    const d=error.diagnostics[0];assert.equal(d.code,'UNKNOWN_ARGUMENT');assert.equal(d.file,file);
    assert.equal(d.location.offset,text.indexOf('{person}'));assert.equal(d.location.line,2);return true;
  });
  assert.equal(await readFile(output,'utf8'),previous);
  await writeFile(file,'{\n  broken\n}');
  await assert.rejects(run(),error=>{const d=error.diagnostics[0];assert.equal(d.code,'INVALID_JSON');assert.equal(d.file,file);assert.equal(d.location.line,2);assert.equal(d.location.column,3);return true;});
  await writeFile(file,'{"greeting":');
  await assert.rejects(run(),error=>{assert.equal(error.diagnostics[0].location.offset,12);return true;});
  await assert.rejects(run(async source=>{if(source===file)throw new Error('read denied');return readFile(source,'utf8');}),error=>{assert.equal(error.diagnostics[0].code,'CATALOG_READ_ERROR');assert.equal(error.diagnostics[0].file,file);return true;});
  await writeFile(file,'{"greeting":"Salut {name}"}');const repaired=await run();assert.match(repaired.files['locales/fr.js'],/Salut/);
  await writeFile(file,'{}');
  await assert.rejects(generate({...options,missing:'error'}),error=>{assert.equal(error.diagnostics[0].file,file);assert.equal(error.diagnostics[0].location,undefined);return true;});
  await writeFile(file,'{"greeting":7}');
  await assert.rejects(run(),error=>{const d=error.diagnostics[0];assert.equal(d.code,'INVALID_CATALOG');assert.equal(d.location.offset,1);return true;});
});

test('CLI generation and init show catalog frames, and watch repairs an initially invalid catalog',async t=>{
  const text='{\n  "greeting": "Hello {name"\n}\n';const options=await fixture(t,text);
  const config=join(options.root,'nordbeam-i18n.config.json');await writeFile(config,JSON.stringify({baseLocale:'en',outDir:'generated'}));
  for(const args of [[],['init']]){
    const result=spawnSync(process.execPath,[resolve('dist/cli.js'),...args,'--config',config],{encoding:'utf8'});
    assert.equal(result.status,1);assert.match(result.stderr,/messages\/en\.json:2:22/);
    assert.match(result.stderr,/closing brace/);assert.match(result.stderr,/2 \|/);assert.match(result.stderr,/Hint:/);
  }
  const child=spawn(process.execPath,[resolve('dist/cli.js'),'--config',config,'--watch'],{stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  const exit=once(child,'exit');t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await exit;});
  await waitFor(()=>stderr.includes('closing brace'),'watch did not show initial diagnostic');
  await waitFor(()=>stdout.includes('nordbeam-locale watch — watching'),'watch did not print its startup banner');
  assert.equal(child.exitCode,null);
  for(const locale of ['en','fr'])await writeFile(join(options.root,`messages/${locale}.json`),'{"greeting":"Hello {name}"}');
  await waitFor(()=>stdout.includes('files updated'),'watch did not recover after repair');
  assert.match(stdout, /\[\d{4}-\d{2}-\d{2}T[^\]]+\] nordbeam-locale:/);
  assert.match(stdout, /updated in \d+ms/);
  await access(join(options.root,'generated/locales/en.js'));
});

test('minified error frames stay bounded and use the snapshot that was compiled',async t=>{
  const prefix='x'.repeat(10000);const text=JSON.stringify({first:prefix,last:'Hello {name'});
  const options=await fixture(t,'{}');let reads=0;
  await assert.rejects(generate(options,async()=>{reads++;return text;}),error=>{
    const d=error.diagnostics[0];assert.equal(d.location.offset,text.indexOf('{name'));
    assert.ok(d.frame.length<250);assert.match(d.frame,/…/);return true;
  });
  assert.equal(reads,2,'diagnostics must not reread potentially changed files');
});
