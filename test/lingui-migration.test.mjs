import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { migrateCatalog, migrationIdRenames } from '@nordbeam/locale-migrate/catalog';
import { migrateProject } from '@nordbeam/locale-migrate/project';
import { convertLinguiMessage, convertLinguiNodes } from '../packages/locale-migrate/dist/lingui-messages.js';
import { compiled, temporary } from './helpers.mjs';

// A catalog as Lingui 3's `lingui extract` writes it: the X-Generator header marks it.
const linguiPo = (entries, { header = true } = {}) => [
  'msgid ""', 'msgstr ""', '"MIME-Version: 1.0\\n"', '"Content-Type: text/plain; charset=utf-8\\n"', '"Content-Transfer-Encoding: 8bit\\n"',
  ...(header ? ['"X-Generator: @lingui/cli\\n"'] : []), '',
  ...entries.flatMap(([id, text, prefix = '']) => [`${prefix}msgid ${JSON.stringify(id)}`, `${prefix}msgstr ${text.startsWith('"') ? text : JSON.stringify(text)}`, '']),
].join('\n');

const source = [
  ['tags', 'Read <0>the guide</0> and <1/> now'],
  ['breaks', 'One<br/><br/>Two'],
  ['apostrophe', "Users'<0>name</0>"],
  ['padded', ' Hi {name} '],
  ['plain', ' Plain '],
  ['quoted', '"Say "hi" now"'],
  ['empty', ''],
  ['books', '{count, plural, one {# book} other {# books}}'],
  ['nested.first', 'First'],
  ['nested.second', 'Second'],
  ['old', 'Old', '#~ '],
];

test('a Lingui 3 PO catalog migrates as Lingui renders it', async t => {
  const root = await temporary(t), file = join(root, 'messages.po');
  await writeFile(file, `#: src/page.tsx:3\n${linguiPo(source)}`);
  const result = await migrateCatalog({ from: file, format: 'po', locale: 'en', sourceLocale: true, dryRun: true });
  assert.equal(result.ok, true, JSON.stringify(result.collisions));
  const output = JSON.parse(result.output);
  // Numbered tags become rich tags, and `<N/>` an empty one, which renders the component as written.
  assert.equal(output.tags, 'Read <tag0>the guide</tag0> and <tag1></tag1> now');
  // A run of adjacent literal tags is one quoted literal: '<br/>''<br/>' would hold an apostrophe.
  assert.equal(output.breaks, "One'<br/><br/>'Two");
  // Lingui reads an apostrophe before `<` as text; FormatJS would start a quote.
  assert.equal(output.apostrophe, "Users''<tag0>name</tag0>");
  // Lingui trims what a message with arguments renders, and only that.
  assert.equal(output.padded, 'Hi {name}');
  assert.equal(output.plain, ' Plain ');
  assert.equal(output.quoted, 'Say "hi" now');
  assert.equal(output.empty, 'empty');
  assert.equal(output.books, '{count, plural, one {# book} other {# books}}');
  assert.deepEqual(output.nested, { first: 'First', second: 'Second' });
  assert.equal(output.old, 'Old');
  const byCode = Object.fromEntries(result.warnings.map(warning => [warning.code, warning]));
  assert.deepEqual(Object.keys(byCode).sort(), ['DOTTED_SOURCE_ID', 'LINGUI_OBSOLETE_INCLUDED', 'LINGUI_PO_QUOTES', 'LINGUI_SOURCE_ID_TEXT', 'LINGUI_WHITESPACE_TRIMMED']);
  assert.equal(result.warnings.length, 5, 'one warning per code');
  assert.deepEqual(byCode.LINGUI_WHITESPACE_TRIMMED.messageIds, ['padded']);
  assert.deepEqual(byCode.LINGUI_OBSOLETE_INCLUDED.messageIds, ['old']);
  assert.deepEqual(byCode.LINGUI_SOURCE_ID_TEXT.messageIds, ['empty']);
  assert.equal(byCode.DOTTED_SOURCE_ID.count, 2);
  assert.match(byCode.LINGUI_PO_QUOTES.message, /1 PO line/);

  // Rendered, the converted messages read as Lingui rendered the originals.
  const { load } = await compiled(t, { baseLocale: 'en', catalogs: { en: { breaks: output.breaks, apostrophe: output.apostrophe, tags: output.tags, padded: output.padded } } });
  const messages = (await load('locales/en.js')).default;
  assert.equal(messages.breaks(), 'One<br/><br/>Two');
  assert.equal(messages.apostrophe({ tag0: children => `[${children.join('')}]` }).join(''), "Users'[name]");
  assert.equal(messages.tags({ tag0: children => `[${children.join('')}]`, tag1: children => `(${children.length})` }).join(''), 'Read [the guide] and (0) now');
  assert.equal(messages.padded({ name: 'Ada' }), 'Hi Ada');
});

test('the lingui-po format reads a Lingui catalog without the generator header, and a translation skips empty entries', async t => {
  const root = await temporary(t), file = join(root, 'fr.po');
  await writeFile(file, linguiPo([['breaks', 'Un<br/><br/>Deux'], ['empty', '']], { header: false }));
  const result = await migrateCatalog({ from: file, format: 'lingui-po', locale: 'fr', dryRun: true });
  assert.deepEqual(JSON.parse(result.output), { breaks: "Un'<br/><br/>'Deux" });
  assert.deepEqual(result.warnings.map(warning => [warning.code, warning.count]), [['PO_UNTRANSLATED_SKIPPED', 1]]);
});

test('the conversion check reports a message whose text the conversion changed', () => {
  assert.equal(convertLinguiMessage('Plain <b>text</b>').changed, undefined);
  // A NUL is the printer's own apostrophe marker, so it cannot survive; the check says so.
  const result = convertLinguiNodes([{ kind: 'text', value: 'a\u0000b' }]);
  assert.deepEqual(result.changed, { source: 'a\u0000b', converted: "a'b" });
});

test('a Lingui JSON catalog reports a changed message by ID', async t => {
  const root = await temporary(t), file = join(root, 'en.json');
  await writeFile(file, JSON.stringify({ fine: 'Fine', odd: 'a\u0000b' }));
  const result = await migrateCatalog({ from: file, format: 'lingui', locale: 'en', dryRun: true });
  const changed = result.warnings.filter(warning => warning.code === 'MIGRATION_TEXT_CHANGED');
  assert.deepEqual(changed.map(warning => warning.messageId), ['odd']);
});

test('dotted IDs and dropped metadata are one warning per code with a count and examples', async t => {
  const root = await temporary(t), file = join(root, 'en.json');
  await writeFile(file, JSON.stringify({
    'cart.title': { defaultMessage: 'Cart', file: 'a.ts' },
    'cart.total': { defaultMessage: 'Total', file: 'b.ts', start: 4 },
    'cart.empty': { defaultMessage: 'Empty', end: 9 },
    'cart.more': { defaultMessage: 'More', file: 'c.ts' },
  }));
  const result = await migrateCatalog({ from: file, format: 'formatjs', dryRun: true });
  const dropped = result.warnings.filter(warning => warning.code === 'MIGRATION_METADATA_DROPPED');
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].count, 4);
  assert.deepEqual(dropped[0].messageIds, ['cart.title', 'cart.total', 'cart.empty', 'cart.more']);
  assert.match(dropped[0].message, /from 4 messages: "cart\.title", "cart\.total", "cart\.empty", …\./);
});

test('IDs that cannot nest as written are renamed, in every catalog alike', async t => {
  assert.deepEqual(Object.fromEntries(migrationIdRenames(['toast', 'toast.action', 'Try again later.', 'a. b', 'kept'])),
    { 'Try again later.': 'Try again later', 'a. b': 'a.b', toast: 'toast.message' });
  // A target that is taken keeps the ID, and the collision is reported instead.
  assert.deepEqual(Object.fromEntries(migrationIdRenames(['x', 'x.y', 'x.message'])), {});
  const root = await temporary(t), file = join(root, 'en.po');
  await writeFile(file, linguiPo([['toast', 'Saved'], ['toast.action', 'Undo'], ['Try again later.', 'Try again later.']]));
  const result = await migrateCatalog({ from: file, format: 'po', locale: 'en', dryRun: true });
  assert.deepEqual(JSON.parse(result.output), { 'Try again later': 'Try again later.', toast: { action: 'Undo', message: 'Saved' } });
  assert.deepEqual(result.renamed, { toast: 'toast.message', 'Try again later.': 'Try again later' });
  const renamed = result.warnings.find(warning => warning.code === 'MIGRATION_ID_RENAMED');
  assert.deepEqual(renamed.renamed, result.renamed);
});

async function linguiProject(t) {
  const root = await temporary(t), source = join(root, 'src');
  await mkdir(join(root, 'locale/en'), { recursive: true });
  await mkdir(join(root, 'locale/fr'), { recursive: true });
  await mkdir(source);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'app', lingui: {
    catalogs: [{ path: '<rootDir>/locale/{locale}/messages', include: ['src'] }], locales: ['fr', 'en', 'pseudo'], pseudoLocale: 'pseudo', sourceLocale: 'en', format: 'po',
  } }));
  await writeFile(join(root, 'locale/en/messages.po'), linguiPo([['toast', 'Saved'], ['toast.action', 'Undo'], ['greeting', 'Hello {name}']]));
  await writeFile(join(root, 'locale/fr/messages.po'), linguiPo([['toast', 'Enregistré'], ['toast.action', 'Annuler'], ['greeting', 'Bonjour {name}'], ['fr.only', 'Seulement']]));
  await writeFile(join(source, 'page.tsx'), `import { Trans } from '@lingui/react';\nexport function Page() { return <p><Trans id="toast" /> <Trans id="greeting" values={{ name: 'Ada' }} /></p>; }\n`);
  return { root, source };
}

test('migrate-project finds a Lingui 3 layout from package.json#lingui and renames IDs in catalogs and calls alike', async t => {
  const { root } = await linguiProject(t);
  const result = await migrateProject({ root, from: '.', format: 'lingui', sourceDir: 'src' });
  assert.equal(result.catalogFormat, 'lingui-po');
  assert.deepEqual(result.catalogs.map(item => [item.locale, item.format, item.source.replace(root, '')]),
    [['en', 'lingui-po', '/locale/en/messages.po'], ['fr', 'lingui-po', '/locale/fr/messages.po']]);
  assert.deepEqual(result.renamedIds, { toast: 'toast.message' });
  // A message only a translation holds rendered its ID in the source locale under Lingui.
  const base = result.catalogs.find(item => item.locale === 'en');
  const sourceIds = base.warnings.filter(warning => warning.code === 'LINGUI_SOURCE_ID_TEXT');
  assert.equal(sourceIds.length, 1);
  assert.deepEqual(sourceIds[0].messageIds, ['fr.only']);
  assert.equal(result.codemod.replacements, 2);
  assert.equal(result.codemod.skipped.length, 0);
});

test('migrate-project reads Lingui <locale>/messages.po folders when given the catalog directory', async t => {
  const { root } = await linguiProject(t);
  const result = await migrateProject({ root, from: 'locale', format: 'lingui', sourceDir: 'src' });
  assert.deepEqual(result.catalogs.map(item => [item.locale, item.format]), [['en', 'lingui-po'], ['fr', 'lingui-po']]);
});

test('migrate-project fails with every message it cannot convert, by ID and locale', async t => {
  const { root } = await linguiProject(t);
  await writeFile(join(root, 'locale/fr/messages.po'), linguiPo([
    ['toast', 'Enregistré {who}'], ['greeting', 'Bonjour {nom}'], ['toast.action', 'Annuler {x}', '#~ '],
  ]));
  await assert.rejects(migrateProject({ root, from: '.', format: 'lingui', sourceDir: 'src' }), error => {
    const ids = error.diagnostics.map(item => `${item.code} ${item.locale}:${item.messageId}`).sort();
    assert.deepEqual(ids, ['UNKNOWN_ARGUMENT fr:greeting', 'UNKNOWN_ARGUMENT fr:toast.action', 'UNKNOWN_ARGUMENT fr:toast.message']);
    assert.match(error.diagnostics.find(item => item.messageId === 'toast.action').hint, /obsolete \(#~\)/);
    return true;
  });
});

test('a catalog that fails conversion lists its messages in the --json failure', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'legacy'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'legacy/en.json'), JSON.stringify({ Checkout: { title: 'Checkout', broken: '{oops' } }));
  await writeFile(join(root, 'src/page.tsx'), `const t = useTranslations('Checkout');\nexport const Page = () => t('title');\n`);
  const result = spawnSync(process.execPath, [resolve('dist/cli.js'), 'migrate-project', '--from', 'legacy', '--format', 'next-intl', '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.errors[0].code, 'COMMAND_FAILED');
  assert.deepEqual(report.errors.slice(1).map(item => [item.code, item.locale, item.messageId, item.file]), [['MIGRATION_INVALID_ICU', 'en', 'Checkout.broken', 'legacy/en.json']]);
});
