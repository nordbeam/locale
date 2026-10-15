import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDuplicateKeys } from '../dist/catalog-text.js';
import { duplicateKeyDiagnostics, invalidJson } from '../dist/catalog-diagnostics.js';
import { parseCatalogJson, parseCatalogSnapshot } from '../dist/catalog-input.js';

const source = text => ({ file: '/project/messages/en.json', text });
const bom = '﻿';

test('duplicate keys are reported at every depth with their own position', () => {
  assert.deepEqual(findDuplicateKeys('{"a":"x","a":"y"}').map(d => [d.id, d.start]), [['a', 9]]);
  assert.deepEqual(findDuplicateKeys('{"nav":{"home":"1","home":"2"}}').map(d => d.id), ['nav.home']);
  assert.deepEqual(findDuplicateKeys('{"a":{"b":"1"},"a":{"c":"2"}}').map(d => d.id), ['a']);
  assert.deepEqual(findDuplicateKeys('{"a.b":"x","a":{"b":"y"}}').map(d => d.id), ['a.b']);
  assert.deepEqual(findDuplicateKeys('{"a":"1","a":"2","a":"3"}').map(d => d.start), [9, 17]);
});

test('catalogs without repeated keys produce no duplicate diagnostics', () => {
  const text = '{"a":"x","b":{"c":"y"},"d.e":"z"}';
  assert.deepEqual(findDuplicateKeys(text, JSON.parse(text)), []);
  assert.deepEqual(duplicateKeyDiagnostics(source(text), 'en', JSON.parse(text)), []);
  // A colon inside a string also mismatches the cheap count, so the full scan must still find nothing.
  const tricky = '{"a":"say \\"hi\\": now","b":"x"}';
  assert.deepEqual(findDuplicateKeys(tricky, JSON.parse(tricky)), []);
});

test('duplicate diagnostics use DUPLICATE_KEY with file, line and column', () => {
  const text = '{\n  "greeting": "Hi",\n  "nav": {"home": "Home"},\n  "greeting": "Hello"\n}';
  const [diagnostic] = duplicateKeyDiagnostics(source(text), 'en', JSON.parse(text));
  assert.equal(diagnostic.code, 'DUPLICATE_KEY');
  assert.equal(diagnostic.messageId, 'greeting');
  assert.equal(diagnostic.locale, 'en');
  assert.equal(diagnostic.file, '/project/messages/en.json');
  assert.deepEqual(diagnostic.location, { line: 4, column: 3, offset: text.lastIndexOf('"greeting"') });
  assert.match(diagnostic.frame, /4 \| {3}"greeting": "Hello"\n {6}\^/);
});

test('duplicate scanning works without a parsed catalog', () => {
  const [diagnostic] = duplicateKeyDiagnostics(source('{"a":{"b":"1"},"a":{"c":"2"}}'), 'en');
  assert.equal(diagnostic.messageId, 'a');
  assert.equal(diagnostic.location.column, 16);
});

test('a leading UTF-8 BOM is accepted and does not shift diagnostic positions', () => {
  assert.deepEqual(parseCatalogJson(`${bom}{"a":"b"}`), { a: 'b' });
  assert.deepEqual(parseCatalogSnapshot(`${bom}{"a":"b"}`), { a: 'b' });
  const text = `${bom}{\n  "k": "v",\n  "k": "w"\n}`;
  const [diagnostic] = duplicateKeyDiagnostics(source(text), 'en', parseCatalogJson(text));
  assert.deepEqual([diagnostic.location.line, diagnostic.location.column], [3, 3]);
  assert.equal(text[diagnostic.location.offset], '"');
  assert.match(diagnostic.frame, /3 \| {3}"k": "w"/);
});

test('invalid JSON after a BOM reports the position in the file text', () => {
  const text = `${bom}{"a":"b"}x`;
  let error;
  try { parseCatalogJson(text); } catch (caught) { error = caught; }
  const location = invalidJson(error, 'en', source(text)).diagnostics[0].location;
  assert.equal(location.line, 1);
  assert.equal(text[location.offset], 'x');
  assert.equal(location.column, location.offset);
});

test('invalid JSON without a BOM keeps its existing location', () => {
  const text = '{"a":"b"}x';
  let error;
  try { JSON.parse(text); } catch (caught) { error = caught; }
  const location = invalidJson(error, 'en', source(text)).diagnostics[0].location;
  assert.equal(text[location.offset], 'x');
  assert.equal(location.column, location.offset + 1);
});
