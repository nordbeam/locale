import test from 'node:test';
import assert from 'node:assert/strict';
import { compileProject } from '../dist/compiler.js';
import { pseudoLocalizeCatalog, pseudoLocalizeMessage } from '../dist/pseudo.js';
import { pseudoCatalog } from '../dist/cli-tools.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporary } from './helpers.mjs';

test('pseudolocalizes visible ICU text without changing its contract', () => {
  const source = "Hello '{friend}' {name}, {count, plural, =0 {no items} one {# item} other {# items}} <strong>now</strong>";
  const pseudo = pseudoLocalizeMessage(source);
  assert.match(pseudo, /［Ħëļļö/);
  assert.match(pseudo, /\{name\}/);
  assert.ok(compileProject({ baseLocale: 'en', catalogs: { en: { value: source }, 'en-XA': { value: pseudo } } }).files['locales/en-XA.js']);
});

test('pseudolocalizes nested catalogs without mutating source', () => {
  const source = { product: { price: 'Price: {amount, number}' }, plain: 'Save' };
  const result = pseudoLocalizeCatalog(source, { expansion: 0 });
  assert.equal(source.product.price, 'Price: {amount, number}');
  assert.match(result.product.price, /［Þřïçë:/);
  assert.match(result.product.price, /\{amount, number\}/);
  assert.equal(pseudoLocalizeMessage('---'), '---');
  assert.throws(() => pseudoLocalizeMessage('Hi', { expansion: -1 }), /between 0 and 5/);
});

test('pseudo CLI tool creates an explicit target and refuses implicit overwrite', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'messages'));
  await writeFile(join(root, 'messages/en.json'), JSON.stringify({ greeting: 'Hello {name}' }, null, 2) + '\n');
  const preview = await pseudoCatalog({ root, baseLocale: 'en', catalogs: 'messages', locale: 'en-XA', dryRun: true });
  assert.equal(preview.written, false); assert.match(preview.output, /［Ħëļļö/);
  await pseudoCatalog({ root, baseLocale: 'en', catalogs: 'messages', locale: 'en-XA' });
  assert.match(await readFile(join(root, 'messages/en-XA.json'), 'utf8'), /［Ħëļļö/);
  await assert.rejects(pseudoCatalog({ root, baseLocale: 'en', catalogs: 'messages', locale: 'en-XA' }), /PSEUDO_TARGET_EXISTS|--update/);
  await pseudoCatalog({ root, baseLocale: 'en', catalogs: 'messages', locale: 'en-XA', update: true });
});
