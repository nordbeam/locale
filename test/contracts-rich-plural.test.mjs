import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareContract, describeMessageContract, pluralCategoryDiagnostics } from '../dist/contracts.js';

const codes = diagnostics => diagnostics.map(diagnostic => diagnostic.code);

test('DROPPED_RICH_TAG warns once with the dropped tag, locale and hint', () => {
  const diagnostics = compareContract('Hello <b>{name}</b>', 'Bonjour {name}', { id: 'greeting', locale: 'fr' });
  assert.deepEqual(codes(diagnostics), ['DROPPED_RICH_TAG']);
  const [dropped] = diagnostics;
  assert.equal(dropped.severity, 'warning');
  assert.equal(dropped.messageId, 'greeting');
  assert.deepEqual(dropped.tags, ['b']);
  assert.match(dropped.message, /<b>/);
  assert.match(dropped.hint, /<b>…<\/b>/);
});

test('DROPPED_RICH_TAG lists every dropped tag in one diagnostic', () => {
  const [dropped, ...rest] = compareContract('<a>x</a> and <b>y</b>', 'x and y', { id: 'pair' });
  assert.equal(rest.length, 0);
  assert.equal(dropped.code, 'DROPPED_RICH_TAG');
  assert.deepEqual(dropped.tags, ['a', 'b']);
});

test('kept rich tags and extra translation tags do not produce DROPPED_RICH_TAG', () => {
  assert.deepEqual(compareContract('Hello <b>{name}</b>', 'Bonjour <b>{name}</b>', { id: 'kept' }), []);
  const extra = compareContract('Hello {name}', 'Bonjour <b>{name}</b>', { id: 'extra' });
  assert.deepEqual(codes(extra), ['UNEXPECTED_SLOT']);
  assert.equal(extra[0].severity, 'error');
});

test('MISSING_PLURAL_CATEGORY warns for Arabic zero, two, few and many', () => {
  const [diagnostic] = compareContract('{n, plural, one {# item} other {# items}}', '{n, plural, one {# عنصر} other {# عناصر}}', { id: 'count', locale: 'ar' });
  assert.equal(diagnostic.code, 'MISSING_PLURAL_CATEGORY');
  assert.equal(diagnostic.severity, 'warning');
  assert.equal(diagnostic.locale, 'ar');
  assert.equal(diagnostic.messageId, 'count');
  assert.equal(diagnostic.argument, 'n');
  assert.deepEqual(diagnostic.categories, ['zero', 'two', 'few', 'many']);
});

test('MISSING_PLURAL_CATEGORY warns for Polish few and many', () => {
  const diagnostics = pluralCategoryDiagnostics(describeMessageContract('{n, plural, one {# plik} other {# plików}}', 'files'), 'pl');
  assert.deepEqual(codes(diagnostics), ['MISSING_PLURAL_CATEGORY']);
  assert.deepEqual(diagnostics[0].categories, ['few', 'many']);
  assert.equal(diagnostics[0].locale, 'pl');
});

test('MISSING_PLURAL_CATEGORY applies to the base locale and to selectordinal', () => {
  const [diagnostic] = pluralCategoryDiagnostics(describeMessageContract('{n, selectordinal, one {#st} other {#th}}', 'rank'), 'en');
  assert.equal(diagnostic.code, 'MISSING_PLURAL_CATEGORY');
  assert.deepEqual(diagnostic.categories, ['two', 'few']);
  assert.match(diagnostic.message, /selectordinal "n"/);
});

test('exact =N branches do not count as plural categories', () => {
  const [diagnostic] = pluralCategoryDiagnostics(describeMessageContract('{n, plural, =0 {none} other {# items}}', 'empty'), 'en');
  assert.deepEqual(diagnostic.categories, ['one']);
});

test('MISSING_PLURAL_CATEGORY reports nested plurals with their path', () => {
  const [diagnostic] = pluralCategoryDiagnostics(describeMessageContract('{g, select, a {{n, plural, one {#} other {#}}} other {x}}', 'nested'), 'pl');
  assert.equal(diagnostic.argument, 'n');
  assert.match(diagnostic.branch, /under select:g=a/);
});

test('no MISSING_PLURAL_CATEGORY for complete plurals, =0 extras or other-only locales', () => {
  assert.deepEqual(compareContract('{n, plural, one {# item} other {# items}}', '{n, plural, one {# élément} other {# éléments}}', { id: 'en', locale: 'fr' }), []);
  assert.deepEqual(pluralCategoryDiagnostics(describeMessageContract('{n, plural, =0 {none} one {# item} other {# items}}', 'extra'), 'en'), []);
  assert.deepEqual(pluralCategoryDiagnostics(describeMessageContract('{n, plural, =0 {none} zero {z} one {o} two {t} few {f} many {m} other {#}}', 'ar-complete'), 'ar'), []);
  assert.deepEqual(pluralCategoryDiagnostics(describeMessageContract('{n, plural, other {# 件}}', 'count'), 'ja'), []);
});

test('unsupported and invalid locales are skipped without throwing', () => {
  const contract = describeMessageContract('{n, plural, one {# x} other {# y}}', 'skip');
  assert.deepEqual(pluralCategoryDiagnostics(contract, 'xx-ZZ'), []);
  assert.deepEqual(pluralCategoryDiagnostics(contract, 'not_valid'), []);
});

test('compareContract runs the plural check only when a locale is given', () => {
  const source = '{n, plural, one {# item} other {# items}}';
  const translation = '{n, plural, one {# عنصر} other {# عناصر}}';
  assert.deepEqual(compareContract(source, translation, { id: 'count' }), []);
  assert.deepEqual(codes(compareContract({ source, translation, id: 'count', locale: 'ar' })), ['MISSING_PLURAL_CATEGORY']);
});
