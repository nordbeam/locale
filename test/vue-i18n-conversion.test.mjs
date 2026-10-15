import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { migrateCatalog } from '@nordbeam/locale-migrate/catalog';
import { compiled, temporary } from './helpers.mjs';

async function migrate(t, source, options = {}) {
  const root = await temporary(t), input = join(root, 'en.json');
  await writeFile(input, JSON.stringify(source));
  return migrateCatalog({ from: input, format: 'vue-i18n', dryRun: true, locale: 'en', ...options });
}

async function render(t, catalog) {
  const project = await compiled(t, { baseLocale: 'en', catalogs: { en: catalog }, timeZone: 'UTC' });
  const { messages } = await (await project.load('index.js')).loadLocale('en');
  return messages;
}

const codes = result => result.warnings.map(item => item.code);

test('vue-i18n two-form pipe plurals follow the default rule: 1 is singular, 0 and the rest plural', async t => {
  const result = await migrate(t, { car: 'car | cars' });
  assert.equal(result.ok, true, JSON.stringify(result.collisions));
  const catalog = JSON.parse(result.output);
  assert.equal(catalog.car, '{count, plural, =1 {car} other {cars}}');
  const messages = await render(t, catalog);
  assert.deepEqual([0, 1, 2, 5].map(count => messages.car({ count })), ['cars', 'car', 'cars', 'cars']);
  assert.ok(codes(result).includes('VUE_I18N_PIPE_PLURAL'));
});

test('vue-i18n three-form pipe plurals select by 0, 1 and everything else, and honour the {n} implicit argument', async t => {
  const result = await migrate(t, {
    apples: 'no apples | one apple | {count} apples',
    bananas: 'no bananas | one banana | {n} bananas',
    note: "it's | {'|'} pipes | #{count}",
  });
  assert.equal(result.ok, true, JSON.stringify(result.collisions));
  const catalog = JSON.parse(result.output);
  assert.match(catalog.apples, /^\{count, plural, =0 \{no apples\} =1 \{one apple\} other \{\{count\} apples\}\}$/);
  assert.match(catalog.bananas, /^\{n, plural,/);
  const messages = await render(t, catalog);
  assert.deepEqual([0, 1, 10].map(count => messages.apples({ count })), ['no apples', 'one apple', '10 apples']);
  assert.equal(messages.bananas({ n: 4 }), '4 bananas');
  assert.equal(messages.note({ count: 1 }), '| pipes');
  assert.equal(messages.note({ count: 7 }), '#7');
});

test('vue-i18n plain links are inlined, and modifiers apply only to fixed text', async t => {
  const result = await migrate(t, {
    app: { name: 'Nordbeam' },
    welcome: 'Welcome to @:app.name!',
    shout: 'Hi @.upper:app.name',
    quoted: "Bye @:{'app.name'} and @.capitalize:(app.name)",
    greeting: { name: '{name}' },
    hello: 'Hello, @:greeting.name',
  });
  assert.equal(result.ok, true, JSON.stringify(result.collisions));
  const messages = await render(t, JSON.parse(result.output));
  assert.equal(messages.welcome(), 'Welcome to Nordbeam!');
  assert.equal(messages.shout(), 'Hi NORDBEAM');
  assert.equal(messages.quoted(), 'Bye Nordbeam and Nordbeam');
  assert.equal(messages.hello({ name: 'Ada' }), 'Hello, Ada');
  assert.ok(codes(result).includes('VUE_I18N_LINK_INLINED'));
});

test('vue-i18n list placeholders become arg<N> arguments', async t => {
  const result = await migrate(t, { hi: 'Hello {0}, today is {1}' });
  const catalog = JSON.parse(result.output);
  assert.equal(catalog.hi, 'Hello {arg0}, today is {arg1}');
  const messages = await render(t, catalog);
  assert.equal(messages.hi({ arg0: 'Ada', arg1: 'Monday' }), 'Hello Ada, today is Monday');
  assert.ok(codes(result).includes('VUE_I18N_LIST_INTERPOLATION'));
});

test('vue-i18n constructs without a faithful ICU form are skipped, never copied', async t => {
  const result = await migrate(t, {
    ok: 'Fine',
    custom: 'Hi @.reverse:ok',
    withArgs: '@.upper:who',
    who: '{name}',
    cycleA: 'A @:cycleB',
    cycleB: 'B @:cycleA',
    nested: 'N @:cycleA',
    plural: 'a | b',
    toPlural: 'See @:plural',
    four: 'a | b | c | d',
    missing: 'See @:nowhere',
    dynamic: 'See @:{key}',
    legacy: 'Hi %{name}',
  });
  assert.equal(result.ok, true, JSON.stringify(result.collisions));
  const catalog = JSON.parse(result.output);
  assert.deepEqual(Object.keys(catalog).sort(), ['ok', 'plural', 'who']);
  const skipped = result.warnings.filter(item => item.code === 'VUE_I18N_UNSUPPORTED_SYNTAX').map(item => JSON.parse(/^Skipped ("[^"]+")/.exec(item.message)[1]));
  assert.deepEqual(skipped.sort(), ['custom', 'cycleA', 'cycleB', 'dynamic', 'four', 'legacy', 'missing', 'nested', 'toPlural', 'withArgs']);
});

test('vue-i18n escapes keep special characters literal', async t => {
  const result = await migrate(t, { esc: String.raw`Mail \@ me \| {'{'}x{'}'} 50%`, apostrophe: "It's {name}'s" });
  const messages = await render(t, JSON.parse(result.output));
  assert.equal(messages.esc(), 'Mail @ me | {x} 50%');
  assert.equal(messages.apostrophe({ name: 'Ada' }), "It's Ada's");
});
