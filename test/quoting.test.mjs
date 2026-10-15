import test from 'node:test';
import assert from 'node:assert/strict';
import { quote } from '../dist/codegen.js';
import { quote as beforeQuote } from './baselines/before_fold_compiler_v0_2/dist/codegen.js';
import { compileProject, compileSelection } from '../dist/compiler.js';
import { compileProject as beforeCompile, compileSelection as beforeSelection } from './baselines/before_fold_compiler_v0_2/dist/compiler.js';
import { normalizeLegacyFormatterCacheOutput, normalizeLegacyProject } from './helpers.mjs';

test('source quoting preserves every UTF-16 unit, script escaping and JSON behavior', t => {
  let checked = 0;
  for (let code = 0; code <= 0xffff; code++) {
    const unit = String.fromCharCode(code);
    for (const value of [unit, 'safe ' + unit + ' trailing', '\ud800' + unit + '\udc00', '\u2028</script>"\\' + unit + '\u2029']) {
      const actual = quote(value);
      assert.equal(actual, beforeQuote(value), 'code unit ' + code.toString(16));
      assert.equal(JSON.parse(actual), value);
      checked++;
    }
  }
  for (const value of ['', 'plain'.repeat(10000), '界مرحباé'.repeat(10000), '👩🏽‍💻'.repeat(10000), '"\\</script>\u2028\u2029'.repeat(10000), null, true, false, -0, NaN, Infinity, -Infinity, 1e30, ['plain', '<', '\ud800'], { value: '</script>' }, new String('boxed'), new Date('2026-01-02T00:00:00Z')]) assert.equal(quote(value), beforeQuote(value));
  const capture = action => { try { return { value: action() }; } catch (error) { return { name: error.name, message: error.message }; } };
  for (const value of [undefined, Symbol('symbol'), 1n, () => {}]) assert.deepEqual(capture(() => quote(value)), capture(() => beforeQuote(value)));
  const cyclic = {}; cyclic.self = cyclic;
  assert.deepEqual(capture(() => quote(cyclic)), capture(() => beforeQuote(cyclic)));
  const run = format => {
    const events = [];
    const value = { toJSON(key) { events.push(['toJSON', key]); return { get data() { events.push('getter'); return '<\ud800'; } }; } };
    return { output: format(value), events };
  };
  assert.deepEqual(run(quote), run(beforeQuote));
  t.diagnostic(`${checked} exact quoted-string comparisons and JSON round trips`);
});

test('quoting optimization keeps full, scoped and selected generated files identical', () => {
  const keys = ['normal', '__proto__', 'then', 'quote"', 'slash\\', 'line\n', 'x\u2028\u2029', '<script>', '\ud800', '\udc00', '👩🏽‍💻', '$c0', '$s1'];
  const forms = ['Text', 'Hello {name}', '{gender, select, female {She} other {They}} liked your post.', '<b>{name}</b>', '" \\ \u2028\u2029 \ud800 {count, number}', "'</script>' {name}"];
  const catalog = Object.fromEntries(keys.map((key, i) => [key, forms[i % forms.length]]));
  for (const development of [false, true]) {
    const options = { baseLocale: 'en', development, catalogs: { en: catalog, fr: { ...catalog }, ar: {} }, scopes: { small: keys.slice(0, 4) } };
    const current = compileProject(options), before = beforeCompile(options);
    assert.deepEqual(normalizeLegacyProject(current), before);
    for (const locale of ['en', 'fr', 'ar']) for (const selection of [keys, keys.slice(0, 4), [keys[2]], [keys[8], keys[11]]]) assert.equal(normalizeLegacyFormatterCacheOutput(compileSelection(current, 'index.js', locale, selection)), beforeSelection(before, 'index.js', locale, selection));
  }
});
