import test from 'node:test';
import assert from 'node:assert/strict';
import { compiled } from './helpers.mjs';

const locales = ['en', 'fr', 'pl', 'ru', 'ar', 'cy', 'ja', 'pt-PT', 'he', 'lt'];
const values = [-1, -0, ...Array.from({ length: 251 }, (_, i) => i), 999, 1000, 1001, 1e6, 1.5, 0.1, NaN];
const cardinal = { zero: 'Z', one: 'O', two: 'T', few: 'F', many: 'M', other: 'X' };
const ordinal = cardinal;
const binary = { one: 'O', other: 'X' };
const catalog = {
  cardinal: '{n, plural, zero {Z#} one {O#} two {T#} few {F#} many {M#} other {X#}}',
  ordinal: '{n, selectordinal, zero {Z#} one {O#} two {T#} few {F#} many {M#} other {X#}}',
  exact: '{n, plural, =0 {exact} one {O#} other {X#}}',
  offset: '{n, plural, offset:1 =1 {exact#} one {O#} other {X#}}',
  number: '{n, number}',
  pound: '{n, plural, other {#}}',
};

// Expected output is built only from Intl, so the fast path can be compared with it exactly.
function expected(locale, id, n) {
  const format = new Intl.NumberFormat(locale).format;
  if (id === 'number') return format(n);
  if (id === 'pound') return format(n);
  if (id === 'exact') return n === 0 ? 'exact' : `${branch(new Intl.PluralRules(locale).select(n), binary)}${format(n)}`;
  if (id === 'offset') {
    const m = n - 1;
    if (n === 1) return `exact${format(m)}`;
    return `${branch(new Intl.PluralRules(locale).select(m), binary)}${format(m)}`;
  }
  const type = id === 'ordinal' ? 'ordinal' : 'cardinal';
  return `${branch(new Intl.PluralRules(locale, { type }).select(n), id === 'ordinal' ? ordinal : cardinal)}${format(n)}`;
}
function branch(category, table) {
  return table[category] ?? table.other;
}

test('generated plural, ordinal, and number fast paths match Intl exactly', async t => {
  const project = await compiled(t, { baseLocale: 'en', catalogs: Object.fromEntries(locales.map(locale => [locale, catalog])), timeZone: 'UTC' });
  let comparisons = 0;
  for (const locale of locales) {
    const { default: messages } = await project.load(`locales/${locale}.js`);
    for (const id of Object.keys(catalog)) {
      for (const n of values) {
        const actual = messages[id]({ n });
        const want = expected(locale, id, n);
        assert.equal(actual, want, `${locale} ${id} n=${Object.is(n, -0) ? '-0' : n}`);
        comparisons++;
      }
    }
  }
  assert.equal(comparisons, locales.length * Object.keys(catalog).length * values.length);
});

test('fast paths fall back to Intl for non-number inputs and bigints', async t => {
  const project = await compiled(t, { baseLocale: 'en', catalogs: { en: catalog, 'ar-EG': catalog }, timeZone: 'UTC' });
  const { default: en } = await project.load('locales/en.js');
  const { default: arEG } = await project.load('locales/ar-EG.js');
  assert.equal(en.cardinal({ n: '1' }), 'O1');
  assert.equal(en.cardinal({ n: '5' }), 'X5');
  assert.equal(en.number({ n: '12' }), '12');
  assert.equal(en.number({ n: 7n }), '7');
  assert.equal(en.exact({ n: 0 }), 'exact');
  // Egyptian Arabic uses Arabic-Indic digits, so number output never takes the plain-digit path.
  assert.equal(arEG.number({ n: 7 }), new Intl.NumberFormat('ar-EG').format(7));
  assert.notEqual(arEG.number({ n: 7 }), '7');
});
