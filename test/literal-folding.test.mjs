import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IntlMessageFormat } from 'intl-messageformat';
import { compileProject, compileSelection, createCompiler } from '../dist/compiler.js';
import { generate } from '../dist/project.js';
import { compileProject as beforeCompile, compileSelection as beforeSelection } from './baselines/before_literal_folding_v0_2/dist/compiler.js';
import { generate as beforeGenerate } from './baselines/before_literal_folding_v0_2/dist/project.js';
import { normalizeLegacyDeclarationMap, normalizeLegacyFormatterCacheOutput, temporary } from './helpers.mjs';

const load = async code => (await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))).default;
const catalog = {
  select: '{gender, select, female {She} male {He} other {They}} liked your post.',
  prefix: 'Hello {gender, select, female {her} male {him} other {them}}!',
  nested: 'Hello {gender, select, female {dear {kind, select, a {friend} other {guest}}} other {{kind, select, a {pal} other {visitor}}}}!',
  serial: '{gender, select, female {She} other {They}} said {kind, select, a {yes} other {no}}.',
  adjacent: '{gender, select, female {She} other {They}}{kind, select, a {A} other {B}}',
  dynamic: '{gender, select, female {She} other {They}} invited {name}.',
  branchValue: 'Hi {gender, select, female {{name}} other {guest}}!',
  empty: '({gender, select, female {} other {}})',
  escaped: "'{'{gender, select, female {'<b>'\\\"\u2028\ud800} other {'</script>'\u2029\udc00}}'}'",
  plural: '{count, plural, offset:1 =0 {Nobody} one {{gender, select, female {She} other {They}} and # guest} other {{gender, select, female {She} other {They}} and # guests}}',
  quotedPound: "{count, plural, one {Start '#' {gender, select, female {her} other {them}} end} other {#}}",
  rich: 'Hi <b>{gender, select, female {her} other {them}}!</b> {name}',
  richBranch: '{gender, select, female {<b>Her</b>} other {Them}}: {name}',
};
const locales = ['en', 'fr', 'ar', 'pl', 'ru', 'cy', 'ja'];
const capture = action => { try { return { value: action() }; } catch (error) { return { name: error.name, message: error.message }; } };

test('literal folding preserves ICU, Unicode, rich output and fallback through full and selected catalogs', async t => {
  let outputs = 0;
  for (const development of [false, true]) {
    const options = { baseLocale: 'en', development, catalogs: Object.fromEntries(locales.map(locale => [locale, { ...catalog }])), scopes: { small: ['select', 'nested', 'rich'] } };
    delete options.catalogs.fr.plural;
    const actual = compileProject(options), previous = beforeCompile(options);
    for (const [file, code] of Object.entries(previous.files)) if (!file.endsWith('.js')) assert.equal(normalizeLegacyFormatterCacheOutput(actual.files[file]), code, file);
    for (const locale of locales) {
      const messages = await load(actual.files[`locales/${locale}.js`]);
      const selected = await load(compileSelection(actual, 'index.js', locale, Object.keys(catalog)));
      const old = await load(previous.files[`locales/${locale}.js`]);
      const references = Object.fromEntries(Object.entries(catalog).map(([id, source]) => [id, new IntlMessageFormat(source, locale === 'fr' && id === 'plural' ? 'en' : locale)]));
      for (const gender of ['female', 'male', 'other', 'unknown', '__proto__']) for (const kind of ['a', 'unknown']) for (const count of [-1.5, 0, 1, 2, 3, 101, NaN, Infinity]) {
        const args = { gender, kind, count, name: 'عائشة 👩🏽‍💻 é \ud800 \u0000', b: children => ({ b: children }) };
        for (const id of Object.keys(catalog)) {
          let expected = references[id].format(args);
          if (id.startsWith('rich') && !Array.isArray(expected)) expected = [expected];
          assert.deepEqual(messages[id](args), expected, `${locale}:${id}`);
          assert.deepEqual(selected[id](args), expected, `selected ${locale}:${id}`);
          assert.deepEqual(messages[id](args), old[id](args), `previous ${locale}:${id}`);
          outputs += 3;
        }
      }
    }
  }
  t.diagnostic(`${outputs} output comparisons`);
});

test('folding bounds escaped text growth and avoids distributing dynamic or serial selections', async () => {
  const controls = {
    long: '{s, select, a {A} other {B}}' + '界'.repeat(129),
    escaped: '{s, select, a {A} other {B}}' + '\ud800'.repeat(22),
    many: '{s, select, ' + Array.from({ length: 17 }, (_, i) => `c${i} {${i}}`).join(' ') + ' other {other}}!',
    dynamic: 'Hi {s, select, a {{name}} other {B}}!',
    partial: '{s, select, a {A} other {B}} invited {name}.',
    pound: 'Hi {s, select, a {{n, plural, one {#} other {#}}} other {#}}!',
    adjacent: '{s, select, a {A} other {B}}{k, select, a {C} other {D}}',
  };
  for (const [id, source] of Object.entries(controls)) for (const development of [false, true]) {
    const options = { baseLocale: 'en', development, catalogs: { en: { [id]: source } } };
    assert.equal(normalizeLegacyFormatterCacheOutput(compileProject(options).files['locales/en.js']), beforeCompile(options).files['locales/en.js'], id);
  }
  const repeated = Array.from({ length: 40 }, (_, i) => `{s${i}, select, a {A} other {B}}abcdefgh`).join('');
  const options = { baseLocale: 'en', catalogs: { en: { repeated, select: catalog.select } } };
  const current = compileProject(options), previous = beforeCompile(options);
  assert.ok(normalizeLegacyFormatterCacheOutput(current.files['locales/en.js']).length <= previous.files['locales/en.js'].length + 128);
  const optimized = await load(compileSelection(current, 'index.js', 'en', ['select']));
  assert.equal(optimized.select({ gender: 'female' }), 'She liked your post.');
  assert.notEqual(compileSelection(current, 'index.js', 'en', ['select']), beforeSelection(previous, 'index.js', 'en', ['select']));
});

test('folding retains getter, slot and validation order including unused branches', async () => {
  for (const development of [false, true]) {
    const options = { baseLocale: 'en', development, catalogs: { en: catalog } };
    const current = await load(compileProject(options).files['locales/en.js']);
    const previous = await load(beforeCompile(options).files['locales/en.js']);
    for (const id of ['nested', 'serial', 'dynamic', 'rich', 'richBranch']) for (const fail of [undefined, 'gender', 'kind', 'name', 'b']) {
      const run = fn => {
        const accesses = [];
        const args = {};
        for (const [key, value] of Object.entries({ gender: 'female', kind: 'a', name: 'Ada', b: children => { accesses.push('slot'); return { children }; } })) {
          Object.defineProperty(args, key, { enumerable: true, get() { accesses.push(key); if (fail === key) throw new Error('read ' + key); return value; } });
        }
        return { result: capture(() => fn(args)), accesses };
      };
      assert.deepEqual(run(current[id]), run(previous[id]), `${development}:${id}:${fail}`);
    }
    for (const args of [undefined, null, {}, { gender: 3 }, Object.create({ gender: 'female' })]) assert.deepEqual(capture(() => current.select(args)), capture(() => previous.select(args)));
  }
});

test('folding stays canonical through cache, sharing, fallback, schema and failed-parse edits', () => {
  for (const maxMessageCacheBytes of [0, 256, 64 * 1024 * 1024]) {
    const compile = createCompiler({ maxMessageCacheBytes });
    const options = { baseLocale: 'en', catalogs: { en: { ...catalog }, fr: { ...catalog } }, scopes: { small: ['select', 'nested'] } };
    const verify = () => {
      const warm = compile(options), cold = compileProject(options);
      assert.deepEqual(warm, cold);
      for (const locale of ['en', 'fr']) for (const keys of [['select'], ['nested', 'select', 'rich']]) assert.equal(compileSelection(warm, 'index.js', locale, keys), compileSelection(cold, 'index.js', locale, keys));
      return cold;
    };
    verify();
    for (const source of [catalog.select + '界'.repeat(129), catalog.select, catalog.dynamic, '{gender, select, female {Her} other {Them}}!', catalog.nested]) { options.catalogs.en.select = source; verify(); }
    options.catalogs.fr = {}; verify();
    options.catalogs.en.select = '{broken'; assert.throws(() => compile(options), /INVALID_ICU/);
    options.catalogs.en.select = catalog.select;
    options.development = true; verify();
    options.development = false; verify();
    const selected = compileSelection(verify(), 'index.js', 'en', ['select']);
    options.catalogs.en.extra = catalog.select;
    assert.equal(compileSelection(verify(), 'index.js', 'en', ['select']), selected);
  }
});

test('literal folding leaves generated declarations and declaration maps unchanged', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'messages'));
  await writeFile(join(root, 'messages/en.json'), JSON.stringify(catalog, null, 2));
  const options = { root, baseLocale: 'en', scopes: { small: ['select', 'nested'] } };
  const previous = await beforeGenerate({ ...options, outDir: 'before' });
  const current = await generate({ ...options, outDir: 'current' });
  const files = Object.keys(current.files).filter(file => file.endsWith('.d.ts') || file.endsWith('.d.ts.map'));
  assert.ok(files.some(file => file.endsWith('.map')));
  for (const file of files) assert.equal(
    normalizeLegacyFormatterCacheOutput(file.endsWith('.map') ? normalizeLegacyDeclarationMap(current.files[file], current.files[file.slice(0, -'.map'.length)]) : current.files[file]),
    normalizeLegacyFormatterCacheOutput(previous.files[file]),
    file,
  );
});

test('shared literal initializers inline exactly and preserve compiler-like names in user text', async () => {
  const source = 'Start $c0 $s1 {choice, select, a {"\\\\\ud800 $c1} other {\udc00 </script>}} end $c2'.replace('</script>', "'</script>'");
  for (const development of [false, true]) {
    const options = { baseLocale: 'en', development, catalogs: { en: { a: source, b: source.replace('Start', 'Next') } } };
    const shared = compileProject(options);
    const selected = compileSelection(shared, 'index.js', 'en', ['a']);
    const sharedMessages = await load(shared.files['locales/en.js']);
    const selectedMessages = await load(selected);
    for (const choice of ['a', 'other', 'unknown']) {
      const expected = new IntlMessageFormat(source, 'en').format({ choice });
      assert.equal(sharedMessages.a({ choice }), expected);
      assert.equal(selectedMessages.a({ choice }), expected);
    }
    delete options.catalogs.en.b;
    assert.equal(compileSelection(compileProject(options), 'index.js', 'en', ['a']), selected);
  }
});
