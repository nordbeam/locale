import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build, createServer } from 'vite';
import { compileProject, compileSelection } from '../dist/compiler.js';
import { generate, createGenerator } from '../dist/project.js';
import { nordbeamLocale } from '../dist/vite.js';
import { compiled, temporary, waitFor } from './helpers.mjs';
import { startLsp } from './lsp-client.mjs';

const loadSource = source => import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const illFormed = ['\ud800', '\udbff', '\udc00', '\udfff', 'a\ud800z', '\ud800\ud800', '\udc00\ud800', '\ud800\udc00\udfff', '\ud800\ud800\udc00', 'quote"\\\ud800'];
const wellFormed = ['\ud800\udc00', '\udbff\udfff', '👩🏽‍💻', 'العربية', 'é', 'e\u0301', 'replacement\ufffd', 'null\0', 'line\n', 'separator\u2028\u2029', '__proto__', 'then', 'default'];

test('unpaired surrogates and Unicode message IDs survive full, scoped, lazy and selected catalogs with exact errors', async t => {
  const names = [...illFormed, ...wellFormed];
  const en = Object.fromEntries(names.map((id, i) => [id, `English ${i}: {name}`]));
  // Exercise flattening when an unpaired surrogate appears in a parent key.
  en['parent\ud800'] = { child: 'Nested {name}' };
  const keys = [...names, 'parent\ud800.child'];
  const fr = Object.fromEntries(names.filter((_, i) => i % 2 === 0).map(id => [id, `French ${names.indexOf(id)}: {name}`]));
  for (const development of [false, true]) {
    const project = await compiled(t, { baseLocale: 'en', development, catalogs: { en, fr }, scopes: { all: keys } });
    for (const prefix of ['', 'scopes/all/']) {
      const loader = await project.load(prefix + 'index.js');
      for (const locale of ['en', 'fr']) {
        const namespace = await project.load(prefix + `locales/${locale}.js`);
        const { messages } = await loader.loadLocale(locale);
        assert.notEqual(messages, namespace.default, 'loadLocale uses its compact private catalog representation');
        assert.equal(Object.getPrototypeOf(messages), null);
        assert.deepEqual(Object.keys(messages).sort(), [...keys].sort());
        const chosen = [...keys].reverse();
        const selected = (await loadSource(compileSelection(project, prefix + 'index.js', locale, chosen))).default;
        const lazy = (await loader.selectMessages(...chosen)(locale)).messages;
        assert.deepEqual(Object.keys(selected), chosen);
        for (const id of keys) {
          const source = locale === 'fr' && Object.hasOwn(fr, id) ? fr[id] : id === 'parent\ud800.child' ? 'Nested {name}' : en[id];
          const expected = source.replace('{name}', 'Ada');
          for (const catalog of [messages, selected, lazy]) {
            assert.equal(catalog[id]({ name: 'Ada' }), expected, JSON.stringify({ id, prefix, locale, development }));
            if (development) {
              const origin = locale === 'fr' && Object.hasOwn(fr, id) ? 'fr' : 'en';
              assert.throws(() => catalog[id](), { name: 'TypeError', message: `${origin}:${id}: expected message arguments` });
              assert.throws(() => catalog[id]({}), { name: 'TypeError', message: `${origin}:${id}: argument "name" must be string or number` });
            }
          }
          if (!id.isWellFormed() || id === 'then') assert.equal(Object.hasOwn(namespace, id), false);
          else if (id !== 'default') assert.equal(namespace[id]({ name: 'Ada' }), expected);
        }
        assert.equal(namespace.default.default({ name: 'Ada' }), (locale === 'fr' && Object.hasOwn(fr, 'default') ? fr.default : en.default).replace('{name}', 'Ada'));
      }
    }
  }
});

test('Unicode catalog types and real definitions survive declaration grouping and incremental layout changes', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'messages'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'tsconfig.json'), '{"compilerOptions":{"module":"NodeNext","target":"ES2022","strict":true,"types":[]},"include":["main.ts"]}');
  const special = { ['a\ud800']: 'High {name}', ['z\udfff']: 'Low {count, number}', 'emoji👩': 'Emoji {name}', then: 'Then {name}', default: 'Default {name}', __proto__: null };
  special.__proto__ = 'Prototype {name}';
  const base = join(root, 'messages/en.json');
  const options = { root, baseLocale: 'en', development: true, scopes: { page: Object.keys(special) } };
  const run = createGenerator(options);
  for (const count of [256, 257, 600, 256]) {
    const catalog = { ...special, ...Object.fromEntries(Array.from({ length: count - Object.keys(special).length }, (_, i) => [`wide${i.toString().padStart(3, '0')}`, 'Wide {name}'])) };
    const source = JSON.stringify(catalog, null, 2);
    for (const locale of ['en', 'fr']) await writeFile(join(root, `messages/${locale}.json`), source);
    const project = await run();
    assert.deepEqual(project.files, (await generate(options)).files, `warm/cold ${count}`);
    assert.deepEqual((await run()).changed, []);
    const high = JSON.stringify('a\ud800'), low = JSON.stringify('z\udfff');
    const text = `import m from './src/i18n/locales/fr.js';
import page from './src/i18n/scopes/page/locales/en.js';
import {selectMessages, loadLocale} from './src/i18n/index.js';
const {messages:s}=await selectMessages(${high},${low})('fr');
const {messages:loaded}=await loadLocale('en');
const namespace=await import('./src/i18n/locales/en.js');
m[${high}]({name:'Ada'});
m[${low}]({count:2});
s[${high}]({name:'Ada'});
s[${low}]({count:2});
page[${high}]({name:'Ada'});
page[${low}]({count:2});
loaded[${high}]({name:'Ada'});
m['emoji👩']({name:'Ada'});m.then({name:'Ada'});m.default({name:'Ada'});m.__proto__({name:'Ada'});
const record: Record<string, (...args:any[])=>string> = m;
type Equal<A,B> = (<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2)?true:false;
type Assert<T extends true> = T;
type Keys = Assert<Equal<keyof typeof m, ${Object.keys(catalog).map(JSON.stringify).join(' | ')}>>;
// @ts-expect-error lone surrogate IDs are not named exports
namespace[${high}];
// @ts-expect-error low surrogates are not named exports either
namespace[${low}];
// @ts-expect-error then must not leak into named exports
namespace.then;
// @ts-expect-error generated keys remain readonly
m[${high}]=()=>'';
// @ts-expect-error selected arguments retain their number type
s[${low}]({count:'two'});
// @ts-expect-error selected keys stay narrow
s['emoji👩'];
// @ts-expect-error all required args survive the fallback type layout
m[${high}]({});
// @ts-expect-error scoped types retain required arguments
page[${low}]({});
`;
    const file = join(root, 'main.ts'); await writeFile(file, text);
    const check = spawnSync(resolve('node_modules/.bin/tsc'), ['--ignoreConfig', '--noEmit', '--strict', '--module', 'NodeNext', '--target', 'ES2022', file], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stdout + check.stderr);
    const lsp = await startLsp(root);
    try {
      const uri = pathToFileURL(file).href;
      lsp.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'typescript', version: 1, text } });
      const lines = text.split('\n');
      for (const [line, id] of [[6, 'a\ud800'], [7, 'z\udfff'], [8, 'a\ud800'], [9, 'z\udfff'], [10, 'a\ud800'], [11, 'z\udfff'], [12, 'a\ud800']]) {
        const definitions = await lsp.request('textDocument/definition', { textDocument: { uri }, position: { line, character: lines[line].indexOf('[') + 2 } });
        assert.equal(definitions.length, 1, JSON.stringify({ count, line, definitions }));
        const [definition] = definitions;
        assert.equal(definition.uri, pathToFileURL(base).href);
        const offset = source.indexOf(JSON.stringify(id) + ':');
        const before = source.slice(0, offset);
        assert.equal(definition.range.start.line, before.split('\n').length - 1);
        const column = offset - before.lastIndexOf('\n') - 1;
        assert.ok([column, column + 1].includes(definition.range.start.character), JSON.stringify({ count, id, definition }));
      }
    } finally { await lsp.close(); }
  }
});

test('split declarations use parser-safe aliases while retaining dotted, hyphenated and Unicode keys', () => {
  const ids = {
    safeName: 'Safe',
    then: 'Reserved then',
    default: 'Reserved default',
    ['__proto__']: 'Prototype key',
    'dotted.id': 'Dotted',
    'hyphen-id': 'Hyphen',
    'emoji👩': 'Emoji',
    'é': 'Unicode',
  };
  for (let index = 0; index < 300; index++) ids[`message${String(index).padStart(3, '0')}`] = `Message ${index}`;
  const project = compileProject({ baseLocale: 'en', catalogs: { en: ids } });
  const declarations = Object.entries(project.files).filter(([file]) => file.endsWith('.d.ts')).map(([, source]) => source);
  assert.ok(declarations.some(source => /export \{\$m\d+ as safeName\};/.test(source)), 'safe IDs remain direct named exports');
  assert.ok(declarations.some(source => /export \{[^}]*\bsafeName\b[^}]*\} from/.test(source)), 'safe IDs remain directly re-exported from the aggregate declaration');
  for (const id of ['then', 'default', '__proto__', 'emoji👩']) {
    assert.ok(declarations.some(source => source.includes(`readonly ${JSON.stringify(id)}: typeof $m`)), `${id} remains in a default catalog type`);
  }
  assert.ok(declarations.some(source => source.includes('readonly "dotted.id"')), 'dotted IDs remain in the flat object type');
  assert.ok(declarations.some(source => source.includes('readonly "hyphen-id"')), 'hyphenated IDs remain in the flat object type');
  assert.ok(declarations.some(source => source.includes('readonly "é"')), 'Unicode IDs remain in the flat object type');
  assert.ok(declarations.every(source => !/export \{[^}]* as "[^"\\]+"/.test(source)), 'split declarations contain no TS 5.5-incompatible quoted aliases');
});

test('Vite preserves lone-surrogate selections through bundling, full loaders and development edits', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'messages')); await mkdir(join(root, 'src'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  const id = 'message\ud800', other = 'message\udfff', literal = JSON.stringify(id), second = JSON.stringify(other);
  const en = { [id]: 'Hello {name}', [other]: 'Other {name}', unused: 'UNUSED_UNICODE_CATALOG', 'emoji👩': 'Emoji {name}' };
  const file = join(root, 'messages/en.json'); await writeFile(file, JSON.stringify(en));
  await writeFile(join(root, 'src/main.ts'), `import {selectMessages,loadLocale} from './i18n/index.js';
export const narrow=selectMessages(${literal});export const overlap=selectMessages(${literal},${second});
export const full=loadLocale;
export const dynamic=(key:string)=>selectMessages(key)('en');
export {'emoji👩' as emoji} from './i18n/locales/en.js';`);
  for (const sharing of [false, true]) {
    const outDir = 'dist-' + sharing;
    await build({ root, configFile: false, logLevel: 'silent', plugins: [nordbeamLocale({ baseLocale: 'en', shareMessages: sharing })],
      build: { ssr: join(root, 'src/main.ts'), outDir, minify: true, rollupOptions: { output: { entryFileNames: 'entry.js' } } } });
    const entry = await import(pathToFileURL(join(root, outDir, 'entry.js')).href);
    assert.equal((await entry.narrow('en')).messages[id]({ name: 'Ada' }), 'Hello Ada');
    assert.equal((await entry.overlap('en')).messages[other]({ name: 'Ada' }), 'Other Ada');
    assert.equal((await entry.full('en')).messages[id]({ name: 'Ada' }), 'Hello Ada');
    assert.equal((await entry.dynamic(other)).messages[other]({ name: 'Ada' }), 'Other Ada');
    assert.equal(entry.emoji({ name: 'Ada' }), 'Emoji Ada');
    assert.deepEqual(Object.keys((await entry.narrow('en')).messages), [id]);
  }
  const server = await createServer({ root, configFile: false, logLevel: 'silent', plugins: [nordbeamLocale({ baseLocale: 'en' })], server: { host: '127.0.0.1', port: 0 } });
  t.after(() => server.close()); await server.listen();
  const entry = await server.ssrLoadModule('/src/main.ts');
  assert.equal((await entry.full('en')).messages[id]({ name: 'Ada' }), 'Hello Ada');
  assert.equal((await entry.narrow('en')).messages[id]({ name: 'Ada' }), 'Hello Ada');
  en[id] = 'Changed {name}'; await writeFile(file, JSON.stringify(en));
  await waitFor(async () => (await (await server.ssrLoadModule('/src/main.ts')).narrow('en')).messages[id]({ name: 'Ada' }) === 'Changed Ada', 'Unicode selection did not update');
  const latest = await server.ssrLoadModule('/src/main.ts');
  assert.equal((await latest.full('en')).messages[id]({ name: 'Ada' }), 'Changed Ada');
  assert.equal((await latest.dynamic(id)).messages[id]({ name: 'Ada' }), 'Changed Ada');
});
