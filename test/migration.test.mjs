import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { migrateCatalog } from '@nordbeam/locale-migrate/catalog';
import { temporary } from './helpers.mjs';
import gettext from 'gettext-parser';

test('migrate converts i18next interpolation and paired plurals without source rewrites', async t => {
  const root = await temporary(t), input = join(root, 'i18next.json'), output = join(root, 'messages/en.json');
  await writeFile(input, JSON.stringify({
    greeting: 'Hello {{name}}',
    item_one: '{{count}} item',
    item_other: '{{count}} items',
    untouched: 'Keep {{-html}}',
  }));
  const preview = await migrateCatalog({ from: input, format: 'i18next', out: output, dryRun: true });
  assert.equal(preview.ok, true);
  assert.equal(preview.changed.length, 0);
  assert.equal(preview.messageCount, 3);
  const converted = JSON.parse(preview.output);
  assert.equal(converted.greeting, 'Hello {name}');
  assert.match(converted.item, /count, plural/);
  assert.equal(converted.untouched, 'Keep {html}');
  assert.ok(preview.warnings.some(item => item.code === 'MIGRATION_UNESCAPED_INTERPOLATION'));
  await assert.rejects(access(output), { code: 'ENOENT' });
  const written = await migrateCatalog({ from: input, format: 'i18next', out: output });
  assert.deepEqual(written.changed, [output]);
  assert.equal(JSON.parse(await readFile(output, 'utf8')).greeting, 'Hello {name}');
});

test('migrate extracts FormatJS descriptors, copies next-intl ICU, and reports metadata', async t => {
  const root = await temporary(t), formatjs = join(root, 'formatjs.json'), nextIntl = join(root, 'next-intl.json');
  await writeFile(formatjs, JSON.stringify({
    'checkout.title': { defaultMessage: 'Checkout', description: 'Heading', file: 'page.tsx' },
    plain: { defaultMessage: 'Plain' },
  }));
  await writeFile(nextIntl, JSON.stringify({ checkout: { total: '{count, plural, one {# item} other {# items}}' } }));
  const extracted = await migrateCatalog({ from: formatjs, format: 'formatjs' });
  assert.equal(JSON.parse(extracted.output).checkout.title, 'Checkout');
  assert.equal(JSON.parse(extracted.output).plain, 'Plain');
  assert.ok(extracted.warnings.some(item => item.code === 'MIGRATION_METADATA_DROPPED'));
  const copied = await migrateCatalog({ from: nextIntl, format: 'next-intl' });
  assert.equal(JSON.parse(copied.output).checkout.total, '{count, plural, one {# item} other {# items}}');
});

test('migrate refuses nested/flat ID collisions and never overwrites a destination', async t => {
  const root = await temporary(t), collision = join(root, 'collision.json'), source = join(root, 'source.json'), destination = join(root, 'out.json');
  await writeFile(collision, JSON.stringify({ checkout: { title: 'Nested' }, 'checkout.title': 'Flat' }));
  const result = await migrateCatalog({ from: collision, format: 'next-intl', out: destination, dryRun: true });
  assert.equal(result.ok, false);
  assert.ok(result.collisions.some(item => item.code === 'MIGRATION_ID_COLLISION'));
  await writeFile(source, JSON.stringify({ title: 'Title' }));
  await writeFile(destination, '{}\n');
  const existing = await migrateCatalog({ from: source, format: 'next-intl', out: destination, dryRun: true });
  assert.equal(existing.ok, false);
  assert.ok(existing.collisions.some(item => item.code === 'MIGRATION_OUTPUT_EXISTS'));
  assert.equal(await readFile(destination, 'utf8'), '{}\n');
});

test('migrate is exposed through the CLI with machine-readable dry-run output', async t => {
  const root = await temporary(t), input = join(root, 'legacy.json');
  await writeFile(input, JSON.stringify({ title: { defaultMessage: 'Welcome', description: 'Page title' } }));
  const result = spawnSync(process.execPath, [resolve('dist/cli.js'), 'migrate', '--from', input, '--format', 'formatjs', '--dry-run', '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(JSON.parse(report.output).title, 'Welcome');
  assert.equal(report.dryRun, true);
  assert.equal(report.changed.length, 0);
});

test('migrate decodes Lingui, Tolgee, ARB, YAML, Android and Apple catalogs', async t => {
  const root = await temporary(t);
  const cases = [
    ['lingui.json', 'lingui', JSON.stringify({ save: { message: 'Save', comment: 'button' } }), 'save', 'Save'],
    ['tolgee.json', 'tolgee', JSON.stringify([{ keyName: 'save', translations: { en: 'Save' } }]), 'save', 'Save'],
    ['app.arb', 'arb', JSON.stringify({ '@@locale': 'en', save: 'Save', '@save': { description: 'button' } }), 'save', 'Save'],
    ['app.yaml', 'yaml', 'account:\n  save: Save\n', 'account.save', 'Save'],
    ['strings.xml', 'android-xml', '<resources><string name="save">Save %1$s</string><plurals name="items"><item quantity="one">%d item</item><item quantity="other">%d items</item></plurals></resources>', 'save', 'Save {arg1}'],
    ['Localizable.strings', 'apple-strings', '"save" = "Save %@";\n', 'save', 'Save {arg1}'],
    ['Localizable.xcstrings', 'apple-xcstrings', JSON.stringify({ sourceLanguage: 'en', strings: { save: { localizations: { en: { stringUnit: { state: 'translated', value: 'Save' } } } } } }), 'save', 'Save'],
    ['jed.json', 'json-gettext', JSON.stringify({ locale_data: { messages: { '': { domain: 'messages' }, save: ['Save'] } } }), 'save', 'Save'],
  ];
  for (const [name, format, source, id, expected] of cases) {
    const file = join(root, name); await writeFile(file, source);
    const result = await migrateCatalog({ from: file, format, locale: 'en' });
    assert.equal(result.ok, true, `${format}: ${JSON.stringify(result.collisions)}`);
    const value = id.split('.').reduce((node, key) => node[key], JSON.parse(result.output));
    assert.equal(value, expected, format);
  }
});

test('migrate decodes PO, POT, and binary MO gettext catalogs', async t => {
  const root = await temporary(t);
  const catalog = { charset: 'utf-8', headers: { language: 'en' }, translations: { '': { '': { msgid: '', msgstr: [''] }, save: { msgid: 'save', msgstr: ['Save'] } } } };
  for (const [name, format, buffer] of [
    ['messages.po', 'po', gettext.po.compile(catalog)],
    ['messages.pot', 'pot', gettext.po.compile(catalog)],
    ['messages.mo', 'mo', gettext.mo.compile(catalog)],
  ]) {
    const file = join(root, name); await writeFile(file, buffer);
    const result = await migrateCatalog({ from: file, format });
    assert.equal(JSON.parse(result.output).save, 'Save');
  }
});

test('migrate reports invalid converted ICU before writing', async t => {
  const root = await temporary(t), input = join(root, 'broken.json'), output = join(root, 'out.json');
  await writeFile(input, JSON.stringify({ greeting: 'Hello {{user.name}}' }));
  const result = await migrateCatalog({ from: input, format: 'i18next', out: output });
  assert.equal(result.ok, false);
  assert.ok(result.collisions.some(item => item.code === 'MIGRATION_INVALID_ICU' && item.path === 'greeting'));
  await assert.rejects(access(output), { code: 'ENOENT' });
});
