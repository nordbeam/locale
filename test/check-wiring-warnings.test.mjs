import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkProject } from '../dist/compiler.js';
import { compareContract, describeMessageContract } from '../dist/contracts.js';
import { temporary } from './helpers.mjs';

const cli = join(process.cwd(), 'dist/cli.js');
const config = JSON.stringify({ baseLocale: 'en', catalogs: 'messages', outDir: 'src/i18n' });

// en is the base. ar is incomplete for plurals and drops a tag; fr is complete but drops tags; ja is other-only.
const catalogs = {
  en: {
    items: '{count, plural, one {# item} other {# items}}',
    ordinal: '{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}',
    rich: 'Read <b>the docs</b> now',
    two: '<a>x</a> <b>y</b>',
    nested: '{g, select, a {{n, plural, one {x} other {y}}} other {z}}',
  },
  fr: {
    items: '{count, plural, one {# élément} other {# éléments}}',
    ordinal: '{n, selectordinal, one {#er} other {#e}}',
    rich: 'Lisez la documentation maintenant',
    two: 'x y',
    nested: '{g, select, a {{n, plural, one {x} other {y}}} other {z}}',
  },
  ar: {
    items: '{count, plural, one {# عنصر} other {# عنصر}}',
    ordinal: '{n, selectordinal, one {#} other {#}}',
    rich: 'اقرأ <b>الوثائق</b> الآن',
    two: '<a>x</a> y',
    nested: '{g, select, a {{n, plural, =0 {none} one {x} other {y}}} other {z}}',
  },
  ja: {
    items: '{count, plural, other {# 個}}',
    ordinal: '{n, selectordinal, other {#番目}}',
    rich: 'ドキュメントを読む',
    two: 'x y',
    nested: '{g, select, a {{n, plural, other {y}}} other {z}}',
  },
};

async function project(t) {
  const root = await realpath(await temporary(t));
  await mkdir(join(root, 'messages'), { recursive: true });
  await writeFile(join(root, 'nordbeam-locale.config.json'), config);
  for (const [locale, catalog] of Object.entries(catalogs)) await writeFile(join(root, 'messages', `${locale}.json`), JSON.stringify(catalog, null, 2));
  return root;
}

function checkJson(root, args = []) {
  const run = spawnSync(process.execPath, [cli, 'check', '--json', ...args], { cwd: root, encoding: 'utf8' });
  return { status: run.status, report: JSON.parse(run.stdout) };
}

test('check --json reports incomplete plural categories with locale, message, hint and location', async t => {
  const root = await project(t);
  const { status, report } = checkJson(root);
  assert.equal(status, 0, report);
  assert.equal(report.ok, true);
  const plurals = report.warnings.filter(warning => warning.code === 'MISSING_PLURAL_CATEGORY');
  assert.deepEqual(plurals.map(warning => [warning.locale, warning.messageId]), [['ar', 'items'], ['ar', 'nested']]);
  const [items, nested] = plurals;
  assert.equal(items.message, 'ar plural "count" has no zero, two, few, many branch.');
  assert.equal(items.hint, 'Add zero {…}, two {…}, few {…}, many {…}. Counts without a matching branch use other.');
  assert.equal(items.source, catalogs.ar.items);
  assert.equal(items.file, 'messages/ar.json');
  assert.equal(items.location.line, 2);
  // `=0` does not satisfy `zero`, and the label names the enclosing select branch.
  assert.equal(nested.message, 'ar plural "n" under select:g=a has no zero, two, few, many branch.');
  assert.equal(nested.location.line, 6);
});

test('check --json reports dropped rich-text tags once per translation', async t => {
  const root = await project(t);
  const { report } = checkJson(root);
  const dropped = report.warnings.filter(warning => warning.code === 'DROPPED_RICH_TAG');
  assert.deepEqual(dropped.map(warning => [warning.locale, warning.messageId]), [['ar', 'two'], ['fr', 'rich'], ['fr', 'two'], ['ja', 'rich'], ['ja', 'two']]);
  const frTwo = dropped.find(warning => warning.locale === 'fr' && warning.messageId === 'two');
  assert.equal(frTwo.message, 'Translation drops rich-text tags <a>, <b>; the text renders without them.');
  assert.equal(frTwo.hint, 'Keep <a>…</a> and <b>…</b> around the translated text, or remove the tag from the base message.');
  assert.equal(frTwo.file, 'messages/fr.json');
  assert.equal(frTwo.location.line, 5);
});

test('complete plurals and other-only locales produce no plural warnings', async t => {
  const root = await project(t);
  const { report } = checkJson(root);
  const flagged = new Set(report.warnings.filter(warning => warning.code === 'MISSING_PLURAL_CATEGORY').map(warning => `${warning.locale}:${warning.messageId}`));
  for (const key of ['fr:items', 'fr:ordinal', 'fr:nested', 'ja:items', 'ja:ordinal', 'ja:nested', 'ar:ordinal', 'en:items', 'en:ordinal']) assert.equal(flagged.has(key), false, key);
});

test('each warning is reported exactly once and --strict leaves warning semantics unchanged', async t => {
  const root = await project(t);
  const plain = checkJson(root).report;
  const keys = plain.warnings.map(warning => JSON.stringify([warning.code, warning.locale, warning.messageId, warning.message]));
  assert.equal(new Set(keys).size, keys.length);
  const strict = checkJson(root, ['--strict']);
  assert.equal(strict.status, 0);
  assert.equal(strict.report.ok, true);
  assert.deepEqual(strict.report.warnings.map(warning => warning.code), plain.warnings.map(warning => warning.code));
  assert.deepEqual(strict.report.errors, []);
});

test('the in-process check reports the same plural and tag warnings as compareContract', () => {
  const warnings = checkProject({ baseLocale: 'en', catalogs }).warnings;
  const arItems = warnings.find(warning => warning.code === 'MISSING_PLURAL_CATEGORY' && warning.messageId === 'items');
  const fromContract = compareContract(describeMessageContract(catalogs.en.items, 'items'), describeMessageContract(catalogs.ar.items, 'items'), { locale: 'ar' });
  assert.deepEqual(fromContract.map(diagnostic => diagnostic.code), ['MISSING_PLURAL_CATEGORY']);
  assert.equal(arItems.message, fromContract[0].message);
  assert.equal(arItems.hint, fromContract[0].hint);
  const frRich = warnings.find(warning => warning.code === 'DROPPED_RICH_TAG' && warning.locale === 'fr' && warning.messageId === 'rich');
  const richContract = compareContract(catalogs.en.rich, catalogs.fr.rich, { id: 'rich', locale: 'fr' });
  assert.equal(frRich.message, richContract[0].message);
  assert.equal(frRich.hint, richContract[0].hint);
});
