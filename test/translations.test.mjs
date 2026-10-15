import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, stat, chmod, symlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { exportPo, importPo } from '../dist/translations.js';
import { parsePo, quotePo } from '../dist/po.js';
import { compileProject, CompileError } from '../dist/compiler.js';
import { temporary } from './helpers.mjs';

async function fixture(t, catalogs, extra = {}) {
  const root = await temporary(t);
  await mkdir(join(root, 'messages'));
  for (const [locale, catalog] of Object.entries(catalogs)) await writeFile(join(root, 'messages', locale + '.json'), JSON.stringify(catalog, null, 2) + '\n');
  return { root, baseLocale: 'en', locale: 'fr', ...extra };
}
const file = options => join(options.root, 'messages', options.locale + '.json');
const header = (locale = 'fr') => `msgid ""\nmsgstr ""\n"Language: ${locale}\\n"\n"Content-Type: text/plain; charset=UTF-8\\n"\n\n`;
const item = (id, source, translation, comments = '') => `${comments ? comments + '\n' : ''}msgctxt ${quotePo(id)}\nmsgid ${quotePo(source)}\nmsgstr ${quotePo(translation)}\n\n`;
async function incoming(options, text) { const from = join(options.root, 'incoming.po'); await writeFile(from, text); return { ...options, from }; }
async function rejectUnchanged(options, text, code) {
  const before = await readFile(file(options));
  const imported = await incoming(options, text);
  await assert.rejects(importPo(imported), error => error instanceof CompileError && error.diagnostics.some(d => d.code === code));
  assert.deepEqual(await readFile(file(options)), before);
  assert.ok((await readdir(join(options.root, 'messages'))).every(name => name.endsWith('.json')));
}

test('PO round trips stable IDs, ICU, special keys, empty messages and duplicate source text without writes', async t => {
  const messages = Object.fromEntries([
    ['hello', 'Hello {name}'], ['nested', { items: '{n, plural, =0 {None} one {# item} other {# items}}' }],
    ['rich', '<b>{name}</b>'], ['choices', '{g, select, a {A} other {Other}}'], ['empty', ''],
    ['__proto__', 'constructor'], ['constructor', 'toString'], ['then', 'same'], ['default', 'same'],
    ['unicode.😀', '日本語 العربية é 😀\n\t\r\b\f\v\x07 " \\ \x1f'],
  ]);
  const options = await fixture(t, { en: messages, fr: messages });
  const before = await readFile(file(options)), stamp = await stat(file(options), { bigint: true });
  const exported = await exportPo(options);
  assert.equal(exported.messageCount, 10); assert.equal(exported.translatedCount, 10);
  assert.equal(exported.po, (await exportPo(options)).po);
  assert.match(exported.po, /#\. nordbeam-locale:empty\nmsgctxt "empty"/);
  assert.doesNotMatch(exported.po, /msgid_plural|msgstr\[/);
  const entries = parsePo(exported.po).entries;
  assert.deepEqual(entries.filter(entry => entry.source === 'same').map(entry => entry.id), ['default', 'then']);
  const result = await importPo(await incoming(options, exported.po));
  assert.equal(result.written, false); assert.equal(result.unchanged, 10);
  assert.deepEqual(await readFile(file(options)), before);
  assert.equal((await stat(file(options), { bigint: true })).mtimeNs, stamp.mtimeNs);
  const after = JSON.parse(await readFile(file(options), 'utf8'));
  assert.deepEqual(compileProject({ baseLocale: 'en', catalogs: { en: messages, fr: messages } }).files, compileProject({ baseLocale: 'en', catalogs: { en: messages, fr: after } }).files);
  assert.equal({}.polluted, undefined);
});

test('import previews, merges existing layout, preserves skipped values and supports intentional empty text', async t => {
  const en = { shop: { greet: 'Hello {name}', added: 'Added' }, keep: 'Keep', blank: 'Blank', fuzzy: 'New source', untranslated: 'Source' };
  const options = await fixture(t, { en, fr: { shop: { greet: 'Bonjour {name}' }, keep: 'Garder', fuzzy: 'Ancien', untranslated: 'Existant' } });
  const original = (await readFile(file(options), 'utf8')).replaceAll('  ', '\t').replaceAll('\n', '\r\n');
  await writeFile(file(options), original); await chmod(file(options), 0o640);
  const po = header() + item('shop.greet', en.shop.greet, 'Salut {name}') + item('shop.added', 'Added', 'Ajouté') + item('blank', 'Blank', '', '#. nordbeam-i18n:empty') + item('fuzzy', 'Old source', 'Flou', '#, fuzzy, no-wrap') + item('untranslated', 'Source', '') + '#~ msgctxt "old"\n#~ msgid "Old"\n#~ msgstr "Ancien"\n';
  const imported = await incoming(options, po + item('removed-and-untranslated', 'Old source', '')), preview = await importPo({ ...imported, dryRun: true });
  assert.deepEqual(preview.added, ['blank', 'shop.added']); assert.deepEqual(preview.updated, ['shop.greet']);
  assert.deepEqual(preview.skipped, { fuzzy: 1, untranslated: 2, obsolete: 1 });
  assert.equal(preview.written, false); assert.equal(await readFile(file(options), 'utf8'), original);
  const result = await importPo(imported); assert.equal(result.written, true);
  const actual = await readFile(file(options), 'utf8'); assert.match(actual, /\r\n\t"shop"/);
  assert.deepEqual(JSON.parse(actual), { shop: { greet: 'Salut {name}', added: 'Ajouté' }, keep: 'Garder', fuzzy: 'Ancien', untranslated: 'Existant', blank: '' });
  assert.equal((await stat(file(options))).mode & 0o777, 0o640);
  assert.equal((await importPo(imported)).written, false);
  assert.deepEqual((await readdir(options.root)).sort(), ['incoming.po', 'messages']);
});

test('new locales are created only after validation; strict import checks the complete project', async t => {
  const options = await fixture(t, { en: { a: 'A', b: '{n, number}' } }, { missing: 'error' });
  const exported = await exportPo(options); assert.equal(exported.translatedCount, 0);
  const partial = await incoming(options, header() + item('a', 'A', 'Un'));
  await assert.rejects(importPo(partial), error => error.diagnostics.some(d => d.code === 'MISSING_MESSAGE'));
  assert.deepEqual(await readdir(join(options.root, 'messages')), ['en.json']);
  const all = await incoming(options, header() + item('a', 'A', 'Un') + item('b', '{n, number}', '{n, number}'));
  const result = await importPo(all); assert.equal(result.written, true); assert.deepEqual(result.added, ['a', 'b']);
  const empty = await fixture(t, { en: { a: 'A' } });
  assert.equal((await importPo(await incoming(empty, header() + item('a', 'A', '')))).written, false);
  assert.deepEqual(await readdir(join(empty.root, 'messages')), ['en.json']);
});

test('import rejects damaged, stale, mismatched and ambiguous PO before replacing any catalog', async t => {
  const options = await fixture(t, { en: { a: 'A', x: '{name}' }, fr: { a: 'Un', x: '{name}' } });
  const cases = [
    [header() + item('a', 'Old', 'Un'), 'PO_STALE_SOURCE'],
    [header() + item('unknown', 'A', 'Un'), 'PO_UNKNOWN_ID'],
    [header() + item('a', 'A', 'Un') + item('a', 'A2', 'Deux'), 'PO_DUPLICATE_ID'],
    [header() + 'msgid "A"\nmsgstr "Un"', 'PO_MISSING_CONTEXT'],
    [header() + 'msgctxt "a"\nmsgid "A"\nmsgstr "broken', 'INVALID_PO'],
    [header() + item('a', 'A', 'Un') + 'invalid "text"', 'INVALID_PO'],
    [header() + 'msgctxt "a"\nmsgid "A"\nmsgid_plural "As"\nmsgstr[0] "Un"', 'PO_GETTEXT_PLURAL'],
    [header('de') + item('a', 'A', 'Un'), 'PO_LOCALE_MISMATCH'],
    [header().replace('UTF-8', 'ISO-8859-1') + item('a', 'A', 'Un'), 'PO_ENCODING'],
    [header().replace('\n\n', '\n"X-Nordbeam-Locale-Format: 9\\n"\n\n') + item('a', 'A', 'Un'), 'PO_VERSION'],
    [header().replace('\n\n', '\n"X-Source-Language: de\\n"\n\n') + item('a', 'A', 'Un'), 'PO_BASE_LOCALE'],
    ['#, fuzzy\n' + header() + item('a', 'A', 'Un'), 'PO_FUZZY_HEADER'],
    [item('a', 'A', 'Un'), 'PO_MISSING_HEADER'],
    [header() + item('x', '{name}', '{person}'), 'UNKNOWN_ARGUMENT'],
    [header() + item('x', '{name}', '{name'), 'INVALID_ICU'],
    [Buffer.concat([Buffer.from(header() + item('a', 'A', 'Un')), Buffer.from([255])]), 'PO_READ_ERROR'],
  ];
  for (const [text, code] of cases) await rejectUnchanged(options, text, code);
  const malformed = header() + 'msgctxt "a"\nmsgid "A"\nmsgstr "broken';
  try { await importPo(await incoming(options, malformed)); assert.fail('Expected error'); }
  catch (error) { const d = error.diagnostics[0]; assert.equal(malformed.slice(d.location.offset), 'msgstr "broken'); assert.equal(d.location.line, 8); }
  const bom = '\uFEFF' + header() + item('x', '{name}', '{person}');
  try { await importPo(await incoming(options, bom)); assert.fail('Expected error'); }
  catch (error) { const d = error.diagnostics[0]; assert.equal(d.code, 'UNKNOWN_ARGUMENT'); assert.ok(bom.slice(d.location.offset).startsWith('msgctxt "x"')); }
});

test('import validates merged cross-locale argument contracts and can repair invalid target ICU', async t => {
  const options = await fixture(t, { en: { value: '{x}' }, de: { value: '{x, date}' }, fr: { value: '{x}' } });
  await rejectUnchanged(options, header() + item('value', '{x}', '{x, number}'), 'ARGUMENT_TYPE_CONFLICT');
  await writeFile(file(options), '{"value":"{x"}');
  assert.equal((await importPo(await incoming(options, header() + item('value', '{x}', '{x, date}')))).written, true);
  const broken = await fixture(t, { en: { a: 'A' }, de: { a: '{broken' }, fr: { a: 'Un' } });
  await rejectUnchanged(broken, header() + item('a', 'A', 'Deux'), 'INVALID_ICU');
});

test('PO grammar accepts wrapped UTF-8, C escapes and obsolete blocks, rejecting silent data loss', () => {
  const source = '\uFEFF' + header() + '# translator comment\n#. note\n#: src/file.ts:1\n#, no-wrap\nmsgctxt "a"\nmsgid "A"\nmsgstr "é 😀 \\141 \\x62 \\037\\n"\n"second \\\" \\\\"\n\n#~ msgctxt "old"\n#~ msgid "Old"\n#~ msgstr "Ancien"\n';
  const parsed = parsePo(source.replaceAll('\n', '\r\n'));
  assert.equal(parsed.entries.length, 1); assert.equal(parsed.obsolete, 1);
  assert.equal(parsed.entries[0].translation, 'é 😀 a b \x1f\nsecond " \\');
  const invalid = [
    'msgctxt "a"\nmsgid "A"\nmsgstr "one"\nmsgstr "two"',
    'msgctxt "a"\nmsgid "A"\nmsgstr "a" trailing',
    'msgctxt "a"\nmsgid "A"\nmsgstr "\\u0041"',
    'msgctxt "a"\nmsgid "A"\nmsgstr "\\303\\251"',
    'msgctxt "a"\nmsgid "A"\nmsgstr "\\000"',
    'msgctxt "a"\nmsgid "A"\nmsgstr "\\004"',
    'msgctxt "a"\nmsgid "A"\nmsgstr "\ud800"',
    '"orphan"', 'msgctxt "a"\nmsgid "A"', 'msgstr "orphan"',
  ];
  for (const value of invalid) assert.throws(() => parsePo(header() + value), CompileError, value);
});

test('import preserves prototype keys and supports mixed flat/nested layouts without replacing subtrees', async t => {
  const en = JSON.parse('{"__proto__":{"polluted":"Safe"},"constructor":"Ctor","a":"A","a.b":"B"}');
  const options = await fixture(t, { en, fr: { a: 'Un' } });
  const po = header() + item('__proto__.polluted', 'Safe', 'Sûr') + item('constructor', 'Ctor', 'constructeur') + item('a.b', 'B', 'Bé');
  await importPo(await incoming(options, po));
  const fr = JSON.parse(await readFile(file(options), 'utf8'));
  assert.equal(fr.__proto__.polluted, 'Sûr'); assert.equal(fr.constructor, 'constructeur'); assert.equal(fr['a.b'], 'Bé'); assert.equal(fr.a, 'Un'); assert.equal({}.polluted, undefined);
  const conflicting = await fixture(t, { en: { a: 'A', 'a.b': 'B' }, fr: { a: { b: 'Bé' } } });
  await rejectUnchanged(conflicting, header() + item('a', 'A', 'Un'), 'CATALOG_LAYOUT_CONFLICT');
});

test('translation tools reject unsafe locale paths, unrepresentable text and symlink catalogs', async t => {
  const options = await fixture(t, { en: { x: 'X' }, fr: { x: 'Y' } });
  for (const locale of ['../outside', 'fr-fr', '', 'en']) await assert.rejects(exportPo({ ...options, locale }), CompileError);
  for (const text of ['\ud800', '\u0000', '\u0004']) {
    const invalid = await fixture(t, { en: { x: text } });
    await assert.rejects(exportPo(invalid), error => error.diagnostics[0].code === 'PO_UNREPRESENTABLE_TEXT');
  }
  await symlink(file(options), join(options.root, 'messages', 'de.json'));
  await assert.rejects(exportPo(options), error => error.diagnostics[0].code === 'CATALOG_READ_ERROR');
  const invalid = await fixture(t, { en: { x: 'X' }, fr: { x: 'Y' } });
  await writeFile(file(invalid), Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125]));
  await assert.rejects(exportPo(invalid), error => error.diagnostics[0].code === 'CATALOG_READ_ERROR');
});

test('import detects catalog changes before commit and never replaces an independently created locale', async t => {
  for (const exists of [true, false]) {
    const options = await fixture(t, { en: { x: 'X' }, ...(exists ? { fr: { x: 'Ancien' } } : {}) });
    const imported = await incoming(options, header() + item('x', 'X', 'Nouveau'));
    const originalWrite = fs.writeFile;
    let injected = false;
    fs.writeFile = async (...args) => {
      const result = await originalWrite(...args);
      if (String(args[0]).endsWith('.tmp')) {
        injected = true;
        await originalWrite(file(options), '{"x":"Concurrent edit"}\n');
      }
      return result;
    };
    syncBuiltinESMExports();
    try { await assert.rejects(importPo(imported), error => error.diagnostics[0].code === 'CATALOG_CHANGED'); }
    finally { fs.writeFile = originalWrite; syncBuiltinESMExports(); }
    assert.equal(injected, true);
    assert.equal(await readFile(file(options), 'utf8'), '{"x":"Concurrent edit"}\n');
    assert.deepEqual((await readdir(join(options.root, 'messages'))).sort(), ['en.json', 'fr.json']);
  }
});

test('CLI exports PO, refuses to overwrite files and imports with config-relative catalogs and versioned JSON', async t => {
  const root = await temporary(t), project = join(root, 'app'); await mkdir(project);
  const options = await fixture(t, { en: { x: 'Hello {name}' }, fr: { x: 'Bonjour {name}' } });
  await writeFile(join(project, 'nordbeam-i18n.config.json'), JSON.stringify({ baseLocale: 'en', catalogs: join(options.root, 'messages') }));
  const cli = (...args) => spawnSync(process.execPath, [resolve('dist/cli.js'), ...args], { cwd: root, encoding: 'utf8' });
  const config = ['--config', 'app/nordbeam-i18n.config.json'];
  let result = cli('export', '--locale', 'fr', ...config); assert.equal(result.status, 0, result.stderr); assert.equal(parsePo(result.stdout).entries.length, 1);
  result = cli('export', '--locale', 'fr', '--out', 'handoff/fr.po', ...config); assert.equal(result.status, 0, result.stderr);
  const exported = await readFile(join(root, 'handoff/fr.po'), 'utf8');
  result = cli('export', '--locale', 'fr', '--out', 'handoff/fr.po', ...config); assert.equal(result.status, 4); assert.equal(await readFile(join(root, 'handoff/fr.po'), 'utf8'), exported);
  await writeFile(join(root, 'handoff/fr.po'), exported.replace('Bonjour {name}', 'Salut {name}'));
  result = cli('import', '--locale', 'fr', '--from', 'handoff/fr.po', '--dry-run', '--json', ...config);
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, ''); const preview = JSON.parse(result.stdout);
  assert.equal(preview.version, 1); assert.equal(preview.ok, true); assert.equal(preview.dryRun, true); assert.equal(preview.written, false); assert.deepEqual(preview.updated, ['x']);
  assert.equal(JSON.parse(await readFile(file(options), 'utf8')).x, 'Bonjour {name}');
  result = cli('import', '--locale', 'fr', '--from', 'handoff/fr.po', ...config); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /1 updated/);
  assert.equal(JSON.parse(await readFile(file(options), 'utf8')).x, 'Salut {name}');
  result = cli('import', '--json', ...config); assert.equal(result.status, 2); assert.equal(JSON.parse(result.stdout).ok, false);
  for (const args of [['--dry-run'], ['export', '--locale', 'fr', '--watch'], ['check', '--locale', 'fr'], ['import', '--locale', 'fr', '--out', 'oops']]) assert.equal(cli(...args, ...config).status, 2);
  assert.deepEqual(await readdir(project), ['nordbeam-i18n.config.json']);
});
