import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, unlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import { nordbeamLocale } from '../dist/vite.js';
import { temporary, waitFor } from './helpers.mjs';

test('real Vite updates only changed selections in client and SSR, and recovers removed keys/locales', async t => {
  const root = await temporary(t);
  await mkdir(join(root,'messages'));await mkdir(join(root,'src'));
  await writeFile(join(root,'package.json'),'{"type":"module"}');
  const en = {earlier:'{n, number}',greeting:'Hello {name}',total:'Total {n, number, ::currency/USD}',unused:'Unused'};
  const fr = {...en,greeting:'Bonjour {name}'};
  for(const [locale,catalog] of [['en',en],['fr',fr]])await writeFile(join(root,`messages/${locale}.json`),JSON.stringify(catalog));
  for(const [page,key] of [['a','greeting'],['b','total']])await writeFile(join(root,`src/${page}.ts`),
    `import {selectMessages as choose} from './i18n/index.js';export const load=choose('${key}');if(import.meta.hot)import.meta.hot.accept();`);
  const plugin=nordbeamLocale({baseLocale:'en'}),hook=plugin.hotUpdate,events=[],sent=[];
  plugin.hotUpdate=async function(ctx){
    let result;
    try {result=await hook.call(this,ctx);}
    catch(error){events.push({environment:this.environment.name,file:ctx.file,error:error.message,ids:[]});throw error;}
    if(ctx.file.includes('/messages/'))events.push({environment:this.environment.name,file:ctx.file,type:ctx.type,ids:(result??ctx.modules).map(module=>module.id)});
    return result;
  };
  const server=await createServer({root,configFile:false,logLevel:'silent',plugins:[plugin],server:{host:'127.0.0.1',port:0}});
  const send=server.environments.client.hot.send.bind(server.environments.client.hot);
  server.environments.client.hot.send=(...args)=>{if(typeof args[0]==='object')sent.push(args[0]);return send(...args);};
  t.after(()=>server.close());await server.listen();
  const origin=server.resolvedUrls.local[0];
  const request=async path=>{const response=await fetch(new URL(path,origin));return {status:response.status,text:await response.text()};};
  const paths={};
  for(const page of ['a','b']){
    const main=await request(`/src/${page}.ts`);
    assert.equal(main.status,200);
    assert.doesNotMatch(main.text,/from\s+['"][^'"]*\/i18n\/index\.js/,'fully static selectors must not retain the full loader dependency');
    const loader=main.text.match(/from\s+"([^"\n]*virtual:nordbeam-locale\/selection\/[^"\n]+)"/)[1];
    const parent=await request(loader);
    const locales=Object.fromEntries([...parent.text.matchAll(/import\("([^"\n]+\/(en|fr))"\)/g)].map(match=>[match[2],match[1]]));
    assert.deepEqual(Object.keys(locales).sort(),['en','fr']);
    paths[page]={loader,...locales};
    for(const locale of ['en','fr'])assert.equal((await request(locales[locale])).status,200);
    const ssr=await server.ssrLoadModule(`/src/${page}.ts`);
    for(const locale of ['en','fr'])await ssr.load(locale);
  }
  const id=async path=>{
    const internal=decodeURIComponent(path).replace('/@id/__x00__','\0');
    const module=server.environments.client.moduleGraph.getModuleById(internal);
    assert.ok(module,JSON.stringify({path,internal,known:[...server.environments.client.moduleGraph.idToModuleMap.keys()]}));
    return module.id;
  };
  const ids={a:await id(paths.a.loader),b:await id(paths.b.loader),aEn:await id(paths.a.en),aFr:await id(paths.a.fr),bEn:await id(paths.b.en),bFr:await id(paths.b.fr)};
  const change=async(action,expected)=>{
    // Vite's native watcher throttles same-path changes for 50 ms. Keep
    // distinct fixture edits outside that window; otherwise an event can be
    // dropped before our plugin sees it, especially for unchanged projections.
    await delay(75);
    events.length=0;await action();
    const ready = environment => {
      const matching = events.filter(event => event.environment === environment);
      if (!matching.length) return false;
      const seen = new Set(matching.flatMap(event => event.ids.filter(id => id?.startsWith('\0virtual:nordbeam-locale/'))));
      return expected.every(id => seen.has(id));
    };
    try {await waitFor(()=>ready('client')&&ready('ssr'),'catalog update did not reach both environments');}
    catch(error){throw new Error(error.message+JSON.stringify({events,environments:Object.keys(server.environments)}));}
    for(const environment of ['client','ssr']){
      const seen=new Set(events.filter(event=>event.environment===environment).flatMap(event=>event.ids.filter(id=>id?.startsWith('\0virtual:nordbeam-locale/'))));
      assert.deepEqual([...seen].sort(),[...expected].sort(),environment+JSON.stringify(events));
    }
  };
  const save=locale=>writeFile(join(root,`messages/${locale}.json`),JSON.stringify(locale==='en'?en:fr));
  // An identical write may be coalesced by the OS; inject a duplicate watcher
  // event to exercise Vite's no-op path deterministically. Other edits use disk.
  await change(()=>server.watcher.emit('change',join(root,'messages/en.json')),[]);
  await change(()=>writeFile(join(root,'messages/en.json'),JSON.stringify(en,null,2)),[]);
  sent.length=0;
  await change(()=>{en.unused='{broken';return save('en');},[]);
  await waitFor(()=>sent.some(event=>event.type==='error'),'invalid ICU did not report a browser error');
  const error=sent.find(event=>event.type==='error').err;
  const encoded=JSON.stringify(en),offset=encoded.indexOf('{broken');
  assert.equal(error.id,await realpath(join(root,'messages/en.json')));
  assert.deepEqual(error.loc,{file:error.id,line:1,column:offset+1});
  assert.match(error.frame,/\{broken/);assert.match(error.frame,/\^/);
  assert.match(error.message,/closing brace/);assert.match(error.message,/Hint:/);
  sent.length=0;
  await change(()=>{en.unused='Unused';return save('en');},[]);
  await waitFor(()=>sent.some(event=>event.type==='update'&&event.updates.length===0),'restoring identical output did not clear the error state');
  await change(()=>{fr.unused='Changed elsewhere';return save('fr');},[]);
  await change(()=>{fr.earlier='{n, number, percent}';return save('fr');},[]);
  await change(()=>{fr.greeting='Salut {name}';return save('fr');},[ids.aFr]);
  assert.match((await request(paths.a.fr)).text,/Salut/);
  assert.doesNotMatch((await request(paths.a.en)).text,/Salut/);
  assert.equal((await (await server.ssrLoadModule('/src/a.ts')).load('fr')).messages.greeting({name:'Ada'}),'Salut Ada');
  // Adding an earlier ID renumbers the full catalog but should not change either selection.
  await change(()=>{en.aaa='Earlier ID';return save('en');},[]);
  await change(()=>{delete fr.greeting;return save('fr');},[ids.aFr]);
  assert.equal((await (await server.ssrLoadModule('/src/a.ts')).load('fr')).messages.greeting({name:'Ada'}),'Hello Ada');
  // Removing the base key is now legal because the translation also omits it.
  await change(()=>{delete en.greeting;return save('en');},[ids.a,ids.aEn,ids.aFr]);
  assert.equal((await request(paths.a.en)).status,500);
  await change(()=>{en.greeting='Restored {name}';return save('en');},[ids.a,ids.aEn,ids.aFr]);
  assert.match((await request(paths.a.en)).text,/Restored/);
  await change(()=>writeFile(join(root,'messages/de.json'),JSON.stringify(en)),[ids.a,ids.b]);
  assert.match((await request(paths.a.loader)).text,/"de"/);
  await change(()=>unlink(join(root,'messages/fr.json')),[ids.a,ids.b,ids.aFr,ids.bFr]);
  assert.equal((await request(paths.a.fr)).status,500);
  await change(()=>save('fr'),[ids.a,ids.b,ids.aFr,ids.bFr]);
  assert.equal((await request(paths.a.fr)).status,200);
});
