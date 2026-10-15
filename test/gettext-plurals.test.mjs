import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { migrateCatalog } from '@nordbeam/locale-migrate/catalog';
import { temporary } from './helpers.mjs';

const polish = 'nplurals=3; plural=(n==1 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);';
const arabic = 'nplurals=6; plural=(n==0 ? 0 : n==1 ? 1 : n==2 ? 2 : n%100>=3 && n%100<=10 ? 3 : n%100>=11 && n%100<=99 ? 4 : 5);';

const po = (language, plural, entries) => [
  'msgid ""', 'msgstr ""',
  `"Language: ${language}\\n"`,
  '"Content-Type: text/plain; charset=UTF-8\\n"',
  ...(plural ? [`"Plural-Forms: ${plural}\\n"`] : []),
  '', entries,
].join('\n');

const codes = result => result.warnings.map(warning => warning.code);

test('PO plural forms keep every Plural-Forms index, not only the first and last', async t => {
  const root = await temporary(t), file = join(root, 'pl.po');
  await writeFile(file, po('pl', polish, [
    'msgctxt "files"', 'msgid "%d file"', 'msgid_plural "%d files"',
    'msgstr[0] "%d plik"', 'msgstr[1] "%d pliki"', 'msgstr[2] "%d plików"', '',
  ].join('\n')));
  const result = await migrateCatalog({ from: file, format: 'po' });
  assert.equal(result.ok, true, JSON.stringify(result.collisions));
  const message = JSON.parse(result.output).files['%d file'];
  assert.equal(message, '{count, plural, one {{count} plik} few {{count} pliki} many {{count} plików} other {{count} plików}}');
  assert.ok(!codes(result).includes('PO_PLURAL_MAPPING'));
});

test('PO plural mapping covers six Arabic forms with CLDR categories', async t => {
  const root = await temporary(t), file = join(root, 'ar.po');
  const forms = ['0', '1', '2', '3-10', '11-99', '100+'].map((text, index) => `msgstr[${index}] "${text}"`);
  await writeFile(file, po('ar', arabic, ['msgctxt "f"', 'msgid "f"', 'msgid_plural "fs"', ...forms, ''].join('\n')));
  const result = await migrateCatalog({ from: file, format: 'po' });
  assert.equal(result.ok, true, JSON.stringify(result.collisions));
  assert.equal(JSON.parse(result.output).f.f, '{count, plural, zero {0} one {1} two {2} few {3-10} many {11-99} other {100+}}');
});

test('PO plurals without a Plural-Forms header fall back to one and other with a warning', async t => {
  const root = await temporary(t), file = join(root, 'nohdr.po');
  await writeFile(file, po('en', null, ['msgctxt "f"', 'msgid "f"', 'msgid_plural "fs"', 'msgstr[0] "one"', 'msgstr[1] "other"', '']. join('\n')));
  const result = await migrateCatalog({ from: file, format: 'po' });
  assert.equal(JSON.parse(result.output).f.f, '{count, plural, one {one} other {other}}');
  assert.ok(codes(result).includes('PO_PLURAL_FORMS_MISSING'));
});

test('PO files without a declared charset are read as UTF-8, and a declared charset still applies', async t => {
  const root = await temporary(t), bare = join(root, 'bare.po'), latin2 = join(root, 'latin2.po');
  await writeFile(bare, ['msgid ""', 'msgstr ""', '"Language: pl\\n"', '', 'msgid "files"', 'msgstr "plików"', ''].join('\n'));
  assert.equal(JSON.parse((await migrateCatalog({ from: bare, format: 'po' })).output).files, 'plików');
  const header = ['msgid ""', 'msgstr ""', '"Language: pl\\n"', '"Content-Type: text/plain; charset=ISO-8859-2\\n"', '', 'msgid "files"', 'msgstr "plik'].join('\n');
  await writeFile(latin2, Buffer.concat([Buffer.from(header), Buffer.from([0xf3]), Buffer.from('w"\n')]));
  assert.equal(JSON.parse((await migrateCatalog({ from: latin2, format: 'po' })).output).files, 'plików');
});

test('Plural-Forms expressions are evaluated safely and rejected when unsupported', async t => {
  const root = await temporary(t), file = join(root, 'unsafe.po');
  await writeFile(file, po('en', 'nplurals=2; plural=process.exit(1);', ['msgctxt "f"', 'msgid "f"', 'msgid_plural "fs"', 'msgstr[0] "a"', 'msgstr[1] "b"', ''].join('\n')));
  const result = await migrateCatalog({ from: file, format: 'po' });
  assert.equal(JSON.parse(result.output).f.f, '{count, plural, one {a} other {b}}');
  assert.ok(codes(result).includes('PO_PLURAL_FORMS_INVALID'));
});

test('PO fuzzy and untranslated entries are skipped with warnings instead of importing English', async t => {
  const root = await temporary(t), file = join(root, 'skip.po');
  await writeFile(file, po('pl', 'nplurals=2; plural=(n != 1);', [
    'msgctxt "save"', 'msgid "Save"', 'msgstr "Zapisz"', '',
    '#, fuzzy', 'msgctxt "draft"', 'msgid "Draft"', 'msgstr "Szkic"', '',
    'msgctxt "empty"', 'msgid "Empty"', 'msgstr ""', '',
  ].join('\n')));
  const result = await migrateCatalog({ from: file, format: 'po' });
  const output = JSON.parse(result.output);
  assert.deepEqual(Object.keys(output).sort(), ['save']);
  assert.ok(codes(result).includes('PO_FUZZY_SKIPPED'));
  assert.ok(codes(result).includes('PO_UNTRANSLATED_SKIPPED'));
  assert.ok(!codes(result).includes('MIGRATION_METADATA_DROPPED'));
});

test('PO printf placeholders are normalized, with the plural count as {count}', async t => {
  const root = await temporary(t), file = join(root, 'printf.po');
  await writeFile(file, po('en', 'nplurals=2; plural=(n != 1);', [
    'msgctxt "greet"', 'msgid "Hi %s"', 'msgstr "Hi %1$s, %2$d left"', '',
    'msgctxt "sale"', 'msgid "50% off"', 'msgstr "50% off"', '',
    'msgctxt "items"', 'msgid "%d item"', 'msgid_plural "%d items"', 'msgstr[0] "%d item"', 'msgstr[1] "%d items"', '',
  ].join('\n')));
  const result = await migrateCatalog({ from: file, format: 'po' });
  const output = JSON.parse(result.output);
  assert.equal(output.greet['Hi %s'], 'Hi {arg1}, {arg2} left');
  assert.equal(output.sale['50% off'], '50% off');
  assert.equal(output.items['%d item'], '{count, plural, one {{count} item} other {{count} items}}');
});

test('dotted source IDs produce DOTTED_SOURCE_ID warnings', async t => {
  const root = await temporary(t), file = join(root, 'dotted.po');
  await writeFile(file, po('en', null, ['msgctxt "Sentence. With dot"', 'msgid "Sentence. With dot"', 'msgstr "Sentence. With dot"', ''].join('\n')));
  const result = await migrateCatalog({ from: file, format: 'po' });
  const dotted = result.warnings.filter(warning => warning.code === 'DOTTED_SOURCE_ID');
  assert.equal(dotted.length, 1);
  assert.match(dotted[0].message, / > " With dot"/);
  assert.match(dotted[0].hint, /--message-id-map/);
});

test('Jed plural forms use the locale_data Plural-Forms and keep null-placeholder singular entries', async t => {
  const root = await temporary(t), file = join(root, 'jed.json');
  await writeFile(file, JSON.stringify({ locale_data: { messages: {
    '': { domain: 'messages', lang: 'pl', plural_forms: polish },
    '%d file': [null, '%d plik', '%d pliki', '%d plików'],
    save: [null, 'Zapisz'],
  } } }));
  const result = await migrateCatalog({ from: file, format: 'json-gettext' });
  assert.equal(result.ok, true, JSON.stringify(result.collisions));
  const output = JSON.parse(result.output);
  assert.equal(output['%d file'], '{count, plural, one {{count} plik} few {{count} pliki} many {{count} plików} other {{count} plików}}');
  assert.equal(output.save, 'Zapisz');
});

test('Lingui compiled arrays convert to ICU and unsupported shapes are reported', async t => {
  const root = await temporary(t), file = join(root, 'lingui.json');
  await writeFile(file, JSON.stringify({
    a: 'Hello {0} {1}',
    b: ['Hello ', ['0'], ' and ', ['name']],
    c: ['You have ', ['count', 'plural', { one: [['#'], ' book'], other: [['#'], ' books'] }]],
    d: ['Due ', ['when', 'date', 'short'], ', ', ['price', 'number']],
    e: [['gender', 'select', { male: ['he'], other: ['they'] }]],
    f: ['odd ', ['x', 'mystery', {}]],
    g: 42,
  }));
  const result = await migrateCatalog({ from: file, format: 'lingui' });
  const output = JSON.parse(result.output);
  assert.equal(output.a, 'Hello {0} {1}');
  assert.equal(output.b, 'Hello {0} and {name}');
  assert.equal(output.c, 'You have {count, plural, one {# book} other {# books}}');
  assert.equal(output.d, 'Due {when, date, short}, {price, number}');
  assert.equal(output.e, '{gender, select, male {he} other {they}}');
  assert.equal(output.f, undefined);
  assert.equal(output.g, undefined);
  const unsupported = result.warnings.filter(warning => warning.code === 'LINGUI_COMPILED_ENTRY').map(warning => warning.message);
  assert.equal(unsupported.length, 2);
  assert.ok(unsupported.some(message => message.includes('"f"')));
  assert.ok(unsupported.some(message => message.includes('"g"')));
});
