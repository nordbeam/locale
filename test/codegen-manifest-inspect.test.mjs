import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { generate } from '../dist/project.js';
import { inspectProject, inspectMessage } from '../dist/inspect.js';
import { temporary } from './helpers.mjs';

const configFile = 'nordbeam.config.json';

async function fixture(t, { en = { greeting: 'Hello {name}', nested: { title: 'Title {count, number}' } }, de = { greeting: 'Hallo {name}', nested: { title: 'Titel {count, number}' } } } = {}) {
  const root = await temporary(t);
  await mkdir(join(root, 'messages'));
  await writeFile(join(root, 'messages/en.json'), JSON.stringify(en, null, 2));
  await writeFile(join(root, 'messages/de.json'), JSON.stringify(de, null, 2));
  return { root, baseLocale: 'en', outDir: 'generated' };
}

const manifestPath = options => join(options.root, 'generated/.nordbeam-locale-manifest.json');

test('freshness reports fresh, modified (hand edit) and stale (catalog edit) and clears on regenerate', async t => {
  const options = await fixture(t);
  await generate(options);
  let inspected = await inspectProject(options, configFile);
  assert.equal(inspected.freshness.status, 'fresh');
  assert.equal(inspected.freshness.next, undefined);

  const edited = join(options.root, 'generated/locales/de.js');
  await writeFile(edited, (await readFile(edited, 'utf8')).replace('Hallo', 'Hi'));
  inspected = await inspectProject(options, configFile);
  assert.equal(inspected.freshness.status, 'modified');
  assert.deepEqual(inspected.freshness.modifiedFiles.map(item => item.input), ['locales/de.js']);
  assert.equal(inspected.freshness.modifiedFiles[0].next, 'nordbeam-locale');
  assert.equal(inspected.freshness.next, 'nordbeam-locale');
  assert.equal((await generate(options)).changed.length, 1, 'regenerating restores the edited file');
  assert.equal((await inspectProject(options, configFile)).freshness.status, 'fresh');

  await writeFile(join(options.root, 'messages/en.json'), JSON.stringify({ greeting: 'Hi {name}', nested: { title: 'Title {count, number}' } }));
  inspected = await inspectProject(options, configFile);
  assert.equal(inspected.freshness.status, 'stale');
  assert.deepEqual(inspected.freshness.staleReason.map(item => [item.input, item.message]), [['en.json', 'catalog en.json changed']]);
  assert.equal(inspected.freshness.staleReason[0].next, 'nordbeam-locale');
  await generate(options);
  assert.equal((await inspectProject(options, configFile)).freshness.status, 'fresh');
});

test('freshness reports missing outputs and names added or removed catalogs as stale', async t => {
  const options = await fixture(t);
  await generate(options);
  await unlink(join(options.root, 'generated/locales/de.js'));
  assert.equal((await inspectProject(options, configFile)).freshness.status, 'missing');
  await generate(options);
  await writeFile(join(options.root, 'messages/fr.json'), '{"greeting":"Bonjour {name}"}');
  const inspected = await inspectProject(options, configFile);
  assert.equal(inspected.freshness.status, 'stale');
  assert.ok(inspected.freshness.staleReason.some(item => item.input === 'fr.json' && item.message === 'catalog fr.json was added'));
});

test('old manifests without recorded hashes are read as unknown and fixed by one generate', async t => {
  const options = await fixture(t);
  await generate(options);
  const manifest = JSON.parse(await readFile(manifestPath(options), 'utf8'));
  await writeFile(manifestPath(options), JSON.stringify({ version: 1, files: manifest.files }));
  const inspected = await inspectProject(options, configFile);
  assert.equal(inspected.generated.manifestValid, true);
  assert.equal(inspected.freshness.status, 'unknown');
  assert.equal(inspected.freshness.next, 'nordbeam-locale');
  await generate(options);
  assert.equal((await inspectProject(options, configFile)).freshness.status, 'fresh');
});

test('untranslatedCount includes base-locale keys that a catalog lacks, and blank entries', async t => {
  const options = await fixture(t, {
    de: { greeting: '  ', nested: { title: 'Titel {count, number}' }, extra: 'Nur deutsch' },
  });
  const inspected = await inspectProject(options, configFile);
  const de = inspected.catalogs.find(item => item.locale === 'de');
  const en = inspected.catalogs.find(item => item.locale === 'en');
  assert.equal(de.missingCount, 0);
  assert.equal(de.untranslatedCount, 1, 'the blank greeting is untranslated');
  await writeFile(join(options.root, 'messages/de.json'), JSON.stringify({ greeting: 'Hallo {name}' }));
  const withoutNested = (await inspectProject(options, configFile)).catalogs.find(item => item.locale === 'de');
  assert.equal(withoutNested.missingCount, 1, 'the nested title is missing from de');
  assert.equal(withoutNested.untranslatedCount, 1);
  assert.equal(en.untranslatedCount, 0);
});

test('inspectMessage describes presence, arguments, source and catalog position per locale', async t => {
  const options = await fixture(t, { de: { greeting: '' } });
  const one = await inspectMessage(options, 'nested.title');
  assert.equal(one.found, true);
  assert.deepEqual(one.present, ['en']);
  assert.deepEqual(one.missing, ['de']);
  assert.deepEqual(one.untranslated, ['de']);
  assert.deepEqual(one.arguments, [{ name: 'count', type: 'number', choices: [] }]);
  assert.equal(one.export, 'messages["nested.title"]');
  const en = one.locales.find(item => item.locale === 'en');
  const text = await readFile(join(options.root, 'messages/en.json'), 'utf8');
  const offset = text.indexOf('"Title {count, number}"');
  const before = text.slice(0, offset).split('\n');
  assert.equal(en.source, 'Title {count, number}');
  assert.equal(en.line, before.length);
  assert.equal(en.column, before.at(-1).length + 1);

  const greeting = await inspectMessage(options, 'greeting');
  assert.deepEqual(greeting.present, ['de', 'en']);
  assert.deepEqual(greeting.untranslated, ['de']);
  assert.deepEqual(greeting.arguments, [{ name: 'name', type: 'value', choices: [] }]);
  assert.equal(greeting.locales.find(item => item.locale === 'de').source, '');
  assert.equal(greeting.locales.find(item => item.locale === 'de').blank, true);

  const absent = await inspectMessage(options, 'nope');
  assert.equal(absent.found, false);
  assert.deepEqual(absent.arguments, []);
});
