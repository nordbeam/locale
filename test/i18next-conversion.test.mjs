import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { migrateCatalog } from '@nordbeam/locale-migrate/catalog';
import { mkdir } from 'node:fs/promises';
import { migrateProject } from '@nordbeam/locale-migrate/project';
import { compiled, temporary } from './helpers.mjs';

async function migrate(t, source, options = {}) {
  const root = await temporary(t), input = join(root, 'i18next.json');
  await writeFile(input, JSON.stringify(source));
  return migrateCatalog({ from: input, format: 'i18next', dryRun: true, ...options });
}

async function render(t, catalog) {
  const project = await compiled(t, { baseLocale: 'en', catalogs: { en: catalog }, timeZone: 'UTC' });
  const { messages } = await (await project.load('index.js')).loadLocale('en');
  return messages;
}

test('i18next literal apostrophes, braces and tag-like text survive ICU compilation', async t => {
  const result = await migrate(t, {
    arrive: "L'{{name}} arrive",
    it: "It's {{n}}",
    curly: 'Use {curly}',
    tag: 'a < b {{x}}',
  });
  assert.equal(result.ok, true, JSON.stringify(result.collisions));
  const messages = await render(t, JSON.parse(result.output));
  assert.equal(messages.arrive({ name: 'Ada' }), "L'Ada arrive");
  assert.equal(messages.it({ n: 3 }), "It's 3");
  assert.equal(messages.curly(), 'Use {curly}');
  assert.equal(messages.tag({ x: 'y' }), 'a < b y');
  assert.ok(result.warnings.some(item => item.code === 'MIGRATION_LITERAL_BRACE'));
  assert.ok(!result.warnings.some(item => item.code === 'MIGRATION_LITERAL_BRACE' && /arrive|It's/.test(item.message)));
});

test('i18next ordinal plurals use selectordinal and _zero matches only count 0', async t => {
  const result = await migrate(t, {
    place_ordinal_one: '{{count}}st',
    place_ordinal_two: '{{count}}nd',
    place_ordinal_few: '{{count}}rd',
    place_ordinal_other: '{{count}}th',
    item_zero: 'No items',
    item_one: '{{count}} item',
    item_other: '{{count}} items',
  });
  assert.equal(result.ok, true, JSON.stringify(result.collisions));
  const converted = JSON.parse(result.output);
  assert.match(converted.place_ordinal, /selectordinal/);
  assert.match(converted.item, /=0 \{No items\}/);
  assert.ok(result.warnings.some(item => item.code === 'MIGRATION_ORDINAL_ID'));
  const messages = await render(t, converted);
  const ordinals = [1, 2, 3, 4, 11, 12, 13, 21, 22, 23].map(count => messages.place_ordinal({ count }));
  assert.deepEqual(ordinals, ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd']);
  const counts = [0, 1, 2, 3, 4, 11].map(count => messages.item({ count }));
  assert.deepEqual(counts, ['No items', '1 item', '2 items', '3 items', '4 items', '11 items']);
});

test('i18next unsupported features produce stable warnings with remedies', async t => {
  const result = await migrate(t, {
    nested: 'See $t(other.key)',
    friend_male: 'He is a friend',
    friend_female: 'She is a friend',
    friend: 'Friend',
    trans: 'Read <0>the docs</0> now',
  });
  const codes = result.warnings.map(item => item.code);
  assert.ok(codes.includes('I18NEXT_NESTING'));
  assert.ok(codes.includes('I18NEXT_CONTEXT'));
  assert.ok(codes.includes('I18NEXT_TRANS_INDEX'));
  for (const item of result.warnings.filter(entry => entry.code.startsWith('I18NEXT_'))) assert.ok(item.hint, item.code);
});

test('i18next number, currency and datetime formatters convert to ICU', async t => {
  const result = await migrate(t, {
    count: 'Total {{n, number}}',
    price: 'Price {{x, currency(usd)}}',
    when: 'On {{d, datetime}}',
    rel: 'Ago {{t, relativetime}}',
  });
  assert.equal(result.ok, true, JSON.stringify(result.collisions));
  const converted = JSON.parse(result.output);
  assert.equal(converted.count, 'Total {n, number}');
  assert.equal(converted.price, 'Price {x, number, ::currency/USD}');
  assert.equal(converted.when, 'On {d, date}');
  assert.equal(converted.rel, 'Ago {t}');
  const formatters = result.warnings.filter(item => item.code === 'I18NEXT_FORMATTER');
  assert.equal(formatters.length, 1);
  assert.match(formatters[0].message, /relativetime/);
  const messages = await render(t, converted);
  assert.equal(messages.count({ n: 1234.5 }), 'Total 1,234.5');
  assert.equal(messages.price({ x: 12 }), 'Price $12.00');
});

test('i18next <0> index tags become valid named rich-text tags and report the mapping', async t => {
  const result = await migrate(t, {
    terms: 'Read the <0>terms</0> and <1>privacy</1>',
    single: 'Click <0>here</0>',
    bold: 'Keep <bold>{{name}}</bold>',
    nested: '<0>Open <1>{{name}}</1></0>',
    count_one: '<0>{{count}}</0> item',
    count_other: '<0>{{count}}</0> items',
  });
  assert.equal(result.ok, true, JSON.stringify(result.collisions));
  const catalog = JSON.parse(result.output);
  assert.equal(catalog.terms, 'Read the <tag0>terms</tag0> and <tag1>privacy</tag1>');
  assert.equal(catalog.bold, 'Keep <bold>{name}</bold>');
  const trans = result.warnings.filter(item => item.code === 'I18NEXT_TRANS_INDEX');
  assert.ok(trans.some(item => /<0>, <1>.*<tag0>, <tag1>/.test(item.message)));
  assert.ok(result.warnings.some(item => item.code === 'I18NEXT_RICH_TEXT' && /<bold>/.test(item.message)));
  const project = await compiled(t, { baseLocale: 'en', catalogs: { en: catalog }, timeZone: 'UTC' });
  const { messages } = await (await project.load('index.js')).loadLocale('en');
  const wrap = name => children => ['[' + name + ':', ...children, ']'];
  assert.deepEqual(messages.single({ tag0: wrap('a') }).flat(), ['Click ', '[a:', 'here', ']']);
  assert.deepEqual(messages.bold({ name: 'Ada', bold: wrap('b') }).flat(), ['Keep ', '[b:', 'Ada', ']']);
});

test('i18next markup that cannot be a rich-text tag skips that message only', async t => {
  const result = await migrate(t, {
    fine: 'Plain {{name}}',
    link: 'See <a href="/x">this</a>',
    br: 'Line<br/>break',
    unclosed: 'Hello <0>there',
    crossed: '<0>a<1>b</0></1>',
    stray: 'a < b and 3 > 2',
  });
  assert.equal(result.ok, true, JSON.stringify(result.collisions));
  const catalog = JSON.parse(result.output);
  assert.deepEqual(Object.keys(catalog).sort(), ['fine', 'stray']);
  assert.equal(result.warnings.filter(item => item.code === 'I18NEXT_UNSUPPORTED_MARKUP').length, 4);
});

test('migrate-project reads locales/<locale>/<namespace>.json folders into namespaced IDs', async t => {
  const root = await temporary(t);
  for (const [locale, hi] of [['en', 'Hello'], ['fr', 'Bonjour']]) {
    await mkdir(join(root, 'locales', locale), { recursive: true });
    await writeFile(join(root, 'locales', locale, 'common.json'), JSON.stringify({ hi }));
    await writeFile(join(root, 'locales', locale, 'cart.json'), JSON.stringify({ items_one: '{{count}} item', items_other: '{{count}} items' }));
  }
  await mkdir(join(root, 'src'), { recursive: true });
  const result = await migrateProject({ root, from: 'locales', format: 'i18next', sourceDir: 'src' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.catalogs.map(item => item.locale), ['en', 'fr']);
  assert.equal(result.catalogs[0].messageCount, 2);
});
