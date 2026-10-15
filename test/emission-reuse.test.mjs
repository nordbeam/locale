import test from 'node:test';
import assert from 'node:assert/strict';
import { compileProject, compileSelection, createCompiler } from '../dist/compiler.js';
import { compileProject as beforeCompile, compileSelection as beforeSelection } from './baselines/before_emission_reuse_v0_2/dist/compiler.js';
import { normalizeLegacyFormatterCacheOutput, normalizeLegacyProject } from './helpers.mjs';

const catalog = {
  a: 'Hello {name}', b: 'Welcome {name}',
  c: 'Integer {n, number, integer}', d: 'Percent {n, number, percent}',
  e: 'Again integer {n, number, integer}', f: 'Again percent {n, number, percent}',
  g: '{choice, select, yes {She} other {They}} liked your post.',
  h: '{choice, select, yes {Her} other {Their}} post.',
  i: '<strong>Hello {name}</strong>', j: '<strong>Welcome {name}</strong>',
  k: Array.from({ length: 100 }, (_, i) => `part${i} {name}`).join('|'),
  l: 'x'.repeat(5000) + ' {name}', m: 'Short {name}',
  n: '{name}', o: '', p: '{n, plural, one {One #} other {Many #}}',
  q: '{n, selectordinal, one {First #} other {Other #}}',
};

test('emission reuse preserves independent text snapshots and formatter dependencies', async t => {
  let compared = 0;
  for (const development of [false, true]) {
    const options = { baseLocale: 'en', development, catalogs: { en: { ...catalog }, fr: { ...catalog }, ar: {} }, scopes: { mixed: ['a', 'c', 'd', 'g', 'i', 'k', 'l', 'm'] } };
    const current = compileProject(options), before = beforeCompile(options);
    assert.deepEqual(normalizeLegacyProject(current), before);
    for (const locale of ['en', 'fr', 'ar']) for (const keys of [Object.keys(catalog), ['m', 'l', 'k', 'b', 'a'], ['f', 'e', 'd', 'c'], ['g'], ['i', 'j']]) {
      const source = compileSelection(current, 'index.js', locale, keys);
      assert.equal(normalizeLegacyFormatterCacheOutput(source), beforeSelection(before, 'index.js', locale, keys));
      const actual = (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).default;
      for (const name of ['Ada', 'عائشة 👩🏽‍💻 $s0 \ud800']) {
        const args = { name, n: 1.25, choice: 'yes', strong: children => ({ children }) };
        if (actual.a) assert.equal(actual.a(args), 'Hello ' + name);
        if (actual.b) assert.equal(actual.b(args), 'Welcome ' + name);
        if (actual.k) assert.equal(actual.k(args), Array.from({ length: 100 }, (_, i) => `part${i} ${name}`).join('|'));
        if (actual.l) assert.equal(actual.l(args), 'x'.repeat(5000) + ' ' + name);
        if (actual.m) assert.equal(actual.m(args), 'Short ' + name);
        const formattingLocale = locale === 'ar' ? 'en' : locale;
        if (actual.c) assert.equal(actual.c(args), 'Integer ' + new Intl.NumberFormat(formattingLocale, { maximumFractionDigits: 0 }).format(args.n));
        if (actual.d) assert.equal(actual.d(args), 'Percent ' + new Intl.NumberFormat(formattingLocale, { style: 'percent' }).format(args.n));
        compared += keys.length;
      }
    }
  }
  t.diagnostic(`${compared} selected message entries across full, reordered and one-off selections`);
});

test('factory reuse survives patch restarts, cache eviction, schema changes and failed recovery', () => {
  for (const maxMessageCacheBytes of [0, 256, 64 * 1024 * 1024]) {
    const compile = createCompiler({ maxMessageCacheBytes });
    const options = { baseLocale: 'en', catalogs: { en: { ...catalog }, fr: { ...catalog } }, scopes: { small: ['a', 'b', 'c'] } };
    const verify = () => {
      const actual = compile(options), cold = compileProject(options), before = beforeCompile(options);
      assert.deepEqual(actual, cold); assert.deepEqual(normalizeLegacyProject(actual), before);
      for (const locale of ['en', 'fr']) for (const keys of [['a'], ['a', 'b'], ['c', 'd', 'g', 'h'], ['k', 'l', 'm']]) assert.equal(normalizeLegacyFormatterCacheOutput(compileSelection(actual, 'index.js', locale, keys)), beforeSelection(before, 'index.js', locale, keys));
    };
    verify();
    for (const [id, source] of [['a', '{name}'], ['b', 'Only {name}'], ['a', 'A {name}'], ['c', 'Now percent {n, number, percent}'], ['d', 'Now integer {n, number, integer}'], ['g', 'Changed {choice, select, yes {Yes} other {No}}!'], ['l', 'Tiny {name}'], ['k', 'Large ' + '界'.repeat(5000) + ' {name}'], ['m', 'No args']]) {
      if (id === 'm') delete options.catalogs.fr.m;
      options.catalogs.en[id] = source; verify();
    }
    options.catalogs.fr = {}; verify();
    options.catalogs.en.a = '{broken'; assert.throws(() => compile(options), /INVALID_ICU/);
    options.catalogs.en.a = catalog.a; verify();
    options.development = true; verify();
    options.catalogs.en.b = 'Different {n, number}'; verify();
    options.development = false; verify();
  }
});
