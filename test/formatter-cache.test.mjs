import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { compileProject, compileSelection } from '../dist/compiler.js';

function instrument(catalog, locale = 'en', keys = Object.keys(catalog)) {
  const calls = { number: 0, plural: 0, constructors: 0 };
  const intl = Object.create(Intl);
  intl.NumberFormat = class extends Intl.NumberFormat {
    constructor(...args) { super(...args); calls.constructors++; }
    get format() { const format = super.format; return value => { calls.number++; return format(value); }; }
  };
  intl.PluralRules = class extends Intl.PluralRules {
    constructor(...args) { super(...args); calls.constructors++; }
    select(value) { calls.plural++; return super.select(value); }
  };
  const project = compileProject({ baseLocale: locale, catalogs: { [locale]: catalog } });
  const source = compileSelection(project, 'index.js', locale, keys);
  const context = { Intl: intl };
  vm.runInNewContext(source.replace('export default ', 'globalThis.messages='), context);
  return { messages: context.messages, source, calls };
}

test('numeric memo is lazy, bounded by collisions, and distinguishes signed zero', () => {
  const { messages: m, calls } = instrument({ number: '{n, number}' });
  const native = new Intl.NumberFormat('en');
  assert.equal(calls.constructors, 0);
  // Integers below 1000 use plain digits without Intl, so memo slots are checked with larger values.
  for (const n of [1002, 1002]) assert.equal(m.number({ n }), native.format(n));
  assert.equal(calls.number, 1);
  for (const n of [1066, 1002]) assert.equal(m.number({ n }), native.format(n));
  assert.equal(calls.number, 3, 'values sharing a slot replace one another');
  // Signed zero stays on the memoized formatter; plain zero takes the integer path.
  for (const n of [-0, -0, 0, 0, -0]) assert.equal(m.number({ n }), native.format(n));
  assert.equal(calls.number, 4);
  for (const n of [NaN, NaN, Infinity, Infinity, -Infinity, -Infinity]) assert.equal(m.number({ n }), native.format(n));
  assert.equal(calls.number, 7);
  assert.equal(calls.constructors, 1);
});

test('non-number inputs preserve native coercion and throwing calls do not corrupt cached values', () => {
  const { messages: m, calls } = instrument({ number: '{n, number}' });
  const native = new Intl.NumberFormat('en');
  assert.equal(m.number({ n: 5 }), native.format(5));
  assert.throws(() => m.number({ n: Symbol('bad') }), /Symbol/);
  const afterThrow = calls.number;
  assert.equal(m.number({ n: 5 }), native.format(5));
  assert.equal(calls.number, afterThrow);
  let current = 2;
  const object = { valueOf: () => current };
  assert.equal(m.number({ n: object }), native.format(2));
  current = 7;
  assert.equal(m.number({ n: object }), native.format(7));
  for (const n of [123456789012345678901n, '123.25', null, undefined]) {
    assert.equal(m.number({ n }), native.format(n));
  }
});

test('formatter options, locales, cardinal and ordinal caches remain independent', () => {
  const catalog = {
    decimal: '{n, number}', percent: '{n, number, percent}',
    money: '{n, number, ::currency/USD}',
    cardinal: '{n, plural, one {one} other {other}}',
    ordinal: '{n, selectordinal, one {one} two {two} few {few} other {other}}',
    offset: '{n, plural, offset:1 =0 {none} one {# guest} other {# guests}}',
  };
  for (const locale of ['en', 'fr', 'ar']) {
    const { messages: m, calls } = instrument(catalog, locale);
    for (const n of [1, 1, 2, 2, -1, 1.0001, 1234.5]) {
      assert.equal(m.decimal({ n }), new Intl.NumberFormat(locale).format(n));
      assert.equal(m.percent({ n }), new Intl.NumberFormat(locale, { style: 'percent' }).format(n));
      assert.equal(m.money({ n }), new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(n));
      const category = new Intl.PluralRules(locale).select(n);
      assert.equal(m.cardinal({ n }), category === 'one' ? 'one' : 'other');
      const ordinal = new Intl.PluralRules(locale, { type: 'ordinal' }).select(n);
      assert.equal(m.ordinal({ n }), ['one', 'two', 'few'].includes(ordinal) ? ordinal : 'other');
      assert.equal(m.offset({ n }), new Intl.NumberFormat(locale).format(n - 1) + (new Intl.PluralRules(locale).select(n - 1) === 'one' ? ' guest' : ' guests'));
    }
    // Integers below 200 select from the precomputed table; other numbers keep the memoized selector.
    const before = calls.plural;
    m.cardinal({ n: 17.5 }); m.cardinal({ n: 17.5 });
    assert.equal(calls.plural, before + 1);
  }
});

test('projection retains memo only for numeric helpers and preserves quoted identifiers', () => {
  const catalog = {
    number: '{n, number}', date: '{when, date, short}',
    text: '$memo $f0Cache {name}', literal: 'Hello',
    rich: '<b>{n, number}</b>',
  };
  const project = compileProject({ baseLocale: 'en', catalogs: { en: catalog } });
  for (const keys of [[], ['literal'], ['text'], ['date']]) {
    const source = compileSelection(project, 'index.js', 'en', keys);
    assert.doesNotMatch(source, /^const \$memo=/m);
  }
  for (const keys of [['number'], ['rich']]) {
    assert.match(compileSelection(project, 'index.js', 'en', keys), /^const \$memo=/m);
  }
  const { messages: m, calls } = instrument(catalog, 'en', ['text', 'literal']);
  assert.equal(m.text({ name: 'Ada' }), '$memo $f0Cache Ada');
  assert.equal(m.literal(), 'Hello');
  assert.equal(calls.constructors, 0);
});
