import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergePo, parsePo, serializePo } from '../dist/po.js';

test('PO round-trips U+2028 and U+2029 in message IDs and values', () => {
  const en = { greeting: 'Hello world', 'section key': 'Para break', plain: 'x' };
  const exported = serializePo({ baseLocale: 'en', locale: 'fr', catalogs: { en, fr: { plain: 'y' } } });
  const merged = mergePo({ baseLocale: 'en', locale: 'fr', catalogs: { en, fr: { plain: 'y' } }, po: exported.po });
  assert.equal(merged.catalogs.en.greeting, 'Hello world');
  assert.equal(merged.catalogs.en['section key'], 'Para break');
  assert.equal(merged.catalog.plain, 'y');
});

test('PO translations containing U+2028 and U+2029 import into the target catalog', () => {
  const en = { greeting: 'Hello', farewell: 'Bye' };
  const po = [
    'msgid ""', 'msgstr ""', '"Language: fr\\n"', '"Content-Type: text/plain; charset=UTF-8\\n"', '',
    'msgctxt "greeting"', 'msgid "Hello"', 'msgstr "Bonjour "', '',
    'msgctxt "farewell"', 'msgid "Bye"', 'msgstr "Au revoir"', '',
  ].join('\n');
  const result = mergePo({ baseLocale: 'en', locale: 'fr', catalogs: { en, fr: {} }, po });
  assert.equal(result.catalog.greeting, 'Bonjour ');
  assert.equal(result.catalog.farewell, 'Au revoir');
});

test('PO parsing still splits lines only on LF and CRLF', () => {
  const po = [
    'msgid ""', 'msgstr ""', '"Language: fr\\n"', '"Content-Type: text/plain; charset=UTF-8\\n"', '',
    'msgctxt "sep key"', 'msgid "a b"', 'msgstr "c d"', '',
  ].join('\r\n');
  const parsed = parsePo(po);
  assert.deepEqual(parsed.entries.map(entry => [entry.id, entry.source, entry.translation]), [['sep key', 'a b', 'c d']]);
});
