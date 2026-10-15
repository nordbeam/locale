import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompiler, compileProject, compileSelection } from '../dist/compiler.js';
import { parseCatalogSnapshot } from '../dist/catalog-input.js';
import { normalizeLegacyFormatterCacheOutput, normalizeLegacyProject } from './helpers.mjs';
import { createCompiler as beforeCreate, compileProject as beforeCompile, compileSelection as beforeSelection } from './baselines/before_catalog_reuse_v0_2/dist/compiler.js';

const initial = () => ({
  baseLocale: 'en', timeZone: 'UTC', scopes: { page: ['page.*', 'baseOnly'] },
  catalogs: {
    en: { page: { greeting: 'Hi {name}', count: '{n, plural, one {One #} other {Many #}}' }, baseOnly: 'Base {n, number}', kind: '{x}', empty: {} },
    fr: { 'page.greeting': 'Salut {name}', 'page.count': '{n, plural, one {Un #} other {Plusieurs #}}', baseOnly: 'French {n, number}', kind: '{x, number}' },
    ar: {},
  },
});
const capture = fn => {
  try { return { value: fn() }; }
  catch (error) { return { name: error.name, message: error.message, diagnostics: error.diagnostics }; }
};

test('validated catalog reuse preserves cold output through mutable, equivalent and snapshot inputs', t => {
  let checks = 0;
  for (const maxMessageCacheBytes of [0, 256, 64 * 1024 * 1024]) for (const development of [false, true]) {
    const options = { ...initial(), development };
    const compile = createCompiler({ maxMessageCacheBytes }), before = beforeCreate({ maxMessageCacheBytes });
    const verify = () => {
      const actual = compile(options), cold = compileProject(options), old = beforeCompile(options);
      assert.deepEqual(actual, cold); assert.deepEqual(normalizeLegacyProject(actual), old); assert.deepEqual(normalizeLegacyProject(actual), before(options));
      for (const locale of actual.locales) for (const entry of Object.keys(actual.groups)) {
        const keys = [...actual.groups[entry]].reverse().slice(0, 3);
        if (keys.length) assert.equal(normalizeLegacyFormatterCacheOutput(compileSelection(actual, entry, locale, keys)), beforeSelection(old, entry, locale, keys));
      }
      checks++; return actual;
    };
    verify(); verify();
    options.catalogs.en.page.greeting = 'Welcome {name}'; verify();
    options.catalogs.en = { kind: '{x}', baseOnly: 'Base {n, number}', 'page.count': options.catalogs.en.page.count, 'page.greeting': 'Welcome {name}', anotherEmpty: { deep: {} } }; verify();
    options.catalogs.fr = Object.fromEntries(Object.entries(options.catalogs.fr).reverse()); verify();
    options.catalogs.en.baseOnly = 'Changed {n, number, percent}'; verify();
    options.catalogs.en['page.greeting'] = '{name, select, formal {Hello} other {Hi}}'; verify();
    options.catalogs.fr.kind = '{x, date}'; verify();
    delete options.catalogs.fr.kind; verify();
    options.catalogs.ja = { ...options.catalogs.fr }; verify();
    delete options.catalogs.ja; verify();
    // New private snapshots with equal text must retain every argument contract.
    for (const snapshot of [true, true, false, true]) {
      options.catalogs = Object.fromEntries(Object.entries(options.catalogs).map(([locale, catalog]) => [locale, snapshot ? parseCatalogSnapshot(JSON.stringify(catalog)) : JSON.parse(JSON.stringify(catalog))]));
      verify(); verify();
    }
    options.catalogs.fr = { ...options.catalogs.fr, kind: '{x, number}' }; verify();
    options.development = !development; verify();
    options.timeZone = 'Asia/Tokyo'; verify();
    options.missing = 'error';
    assert.deepEqual(capture(() => compile(options)), capture(() => before(options)));
    delete options.missing; verify();
    options.catalogs.fr = { ...options.catalogs.fr, 'page.greeting': '{broken' };
    assert.deepEqual(capture(() => compile(options)), capture(() => before(options)));
    options.catalogs.fr['page.greeting'] = 'Recovered {name}'; verify();
    const returned = verify(); returned.files['locales/en.js'] = 'corrupt'; returned.locales.length = 0; returned.groups['index.js'].length = 0; verify();
    options.catalogs = { en: {}, fr: {} }; options.scopes = {}; verify(); verify();
    options.catalogs.en.value = 'Value {n}'; verify();
    options.catalogs.fr.value = 'Nombre {n, number}'; verify();
    options.baseLocale = 'fr'; verify();
  }
  t.diagnostic(`${checks} state comparisons with cold and preceding compilers, plus selected output`);
});

test('equal-source detection preserves structural errors, getter order and recovery', () => {
  const factories = [
    log => { const page = {}; Object.defineProperty(page, 'text', { enumerable: true, get() { log.push('nested'); return 'Hello {name}'; } }); return { page }; },
    log => { const page = {}; Object.defineProperty(page, 'text', { enumerable: true, get() { log.push('duplicate nested'); return 'Hello {name}'; } }); return { page, 'page.text': 'Hello {name}' }; },
    log => { const page = {}; Object.defineProperty(page, 'text', { enumerable: true, get() { log.push('changed duplicate'); return 'Changed {name}'; } }); return { page, 'page.text': 'Hello {name}' }; },
    () => ({ page: { text: 'Hello {name}', invalid: 42 } }),
    () => { const root = { page: { text: 'Hello {name}' } }; root.cycle = root; return root; },
    () => ({ page: { text: 'Hello {name}' }, '': {} }),
    log => { const root = {}; Object.defineProperty(root, 'page', { enumerable: true, get() { log.push('throws'); throw new Error('catalog getter'); } }); return root; },
    log => { const root = Object.create(null), page = {}; Object.defineProperty(page, 'text', { enumerable: true, get() { log.push('nested'); return 'Hello {name}'; } }); Object.defineProperty(root, 'page', { enumerable: true, get() { log.push('page'); return page; } }); Object.defineProperty(root, 'tail', { enumerable: true, get() { log.push('tail'); return 'Tail'; } }); return root; },
    () => JSON.parse('{"page.text":"Hello {name}","__proto__":"Prototype","default":"Default","then":"Then"}'),
  ];
  for (const maxMessageCacheBytes of [0, 256, 64 * 1024 * 1024]) for (const make of factories) {
    const compile = createCompiler({ maxMessageCacheBytes }), before = beforeCreate({ maxMessageCacheBytes });
    const good = { baseLocale: 'en', catalogs: { en: { page: { text: 'Hello {name}' } } } };
    assert.deepEqual(normalizeLegacyProject(compile(good)), before(good));
    for (let repeat = 0; repeat < 2; repeat++) {
      const aLog = [], bLog = [];
      const actual = capture(() => compile({ ...good, catalogs: { en: make(aLog) } }));
      const expected = capture(() => before({ ...good, catalogs: { en: make(bLog) } }));
      const comparable = actual.value ? { value: normalizeLegacyProject(actual.value) } : actual;
      assert.deepEqual(comparable, expected); assert.deepEqual(aLog, bLog);
    }
    assert.deepEqual(normalizeLegacyProject(compile(good)), before(good));
    good.catalogs.en.page.text = 'Repaired {name}';
    assert.deepEqual(normalizeLegacyProject(compile(good)), beforeCompile(good));
  }
});

test('cold catalog sharing preserves locale ownership, fallbacks and skeleton output', () => {
  const common = {
    plain: 'Static text',
    greeting: 'Hello {name}',
    count: '{n, plural, one {# item} other {# items}}',
  };
  const shared = compileProject({ baseLocale: 'en', catalogs: { de: common, en: common, fr: {} } });
  const cloned = compileProject({ baseLocale: 'en', catalogs: {
    de: structuredClone(common), en: structuredClone(common), fr: {},
  } });
  assert.deepEqual(shared, cloned);
  assert.match(shared.files['locales/fr.js'], /PluralRules\("en"/);

  const skeleton = { date: '{value, date, ::yyyyMMdd}' };
  assert.deepEqual(
    compileProject({ baseLocale: 'en', catalogs: { de: skeleton, en: skeleton, fr: skeleton } }),
    compileProject({ baseLocale: 'en', catalogs: {
      de: structuredClone(skeleton), en: structuredClone(skeleton), fr: structuredClone(skeleton),
    } }),
  );
});

test('flat cold-catalog detection never bypasses public accessors', () => {
  const reads = [];
  const translated = {};
  Object.defineProperty(translated, 'plain', { enumerable: true, get() { reads.push('plain'); return 'Static text'; } });
  Object.defineProperty(translated, 'greeting', { enumerable: true, get() { reads.push('greeting'); return 'Hello {name}'; } });
  const project = compileProject({ baseLocale: 'en', catalogs: {
    de: { plain: 'Static text', greeting: 'Hello {name}' },
    en: translated,
  } });
  assert.deepEqual(reads, ['plain', 'greeting']);
  assert.match(project.files['locales/en.js'], /Hello /);
});
