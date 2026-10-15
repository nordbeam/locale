import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { check, generate } from '../dist/project.js';
import { CompileError } from '../dist/compiler.js';
import { temporary } from './helpers.mjs';

async function catalogProject(t, files) {
  const root = await temporary(t);
  await mkdir(join(root, 'messages'));
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, 'messages', name), text);
  return root;
}

const options = root => ({ root, baseLocale: 'en' });

test('generate fails with DUPLICATE_KEY at the repeated key in en.json', async t => {
  const root = await catalogProject(t, { 'en.json': '{\n  "greeting": "Hi",\n  "nav": {"home": "Home"},\n  "greeting": "Hello"\n}' });
  await assert.rejects(generate(options(root)), error => {
    assert.ok(error instanceof CompileError);
    const [diagnostic] = error.diagnostics;
    assert.equal(diagnostic.code, 'DUPLICATE_KEY');
    assert.equal(diagnostic.messageId, 'greeting');
    assert.equal(diagnostic.file, join(root, 'messages', 'en.json'));
    assert.deepEqual([diagnostic.location.line, diagnostic.location.column], [4, 3]);
    return true;
  });
});

test('check reports DUPLICATE_KEY errors with file and location', async t => {
  const root = await catalogProject(t, { 'en.json': '{"a":"x","a":"y"}' });
  const result = await check(options(root));
  assert.equal(result.ok, false);
  const [error] = result.errors;
  assert.equal(error.code, 'DUPLICATE_KEY');
  assert.equal(error.file, join(root, 'messages', 'en.json'));
  assert.deepEqual([error.location.line, error.location.column], [1, 10]);
});

test('clean catalogs pass check and generate without duplicate work', async t => {
  const keys = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`key${i}`, `Message ${i}`]));
  const root = await catalogProject(t, { 'en.json': JSON.stringify(keys) });
  const result = await check(options(root));
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.messageCount, 5000);
  await generate(options(root));
});

test('a UTF-8 BOM in en.json is accepted by check and generate', async t => {
  const root = await catalogProject(t, { 'en.json': '﻿{"greeting":"Hi"}' });
  assert.equal((await check(options(root))).ok, true);
  await generate(options(root));
});

test('a top-level then key is a THENABLE_KEY warning from check and generate', async t => {
  const root = await catalogProject(t, { 'en.json': '{"then":"Then","hello":"Hi"}' });
  const result = await check(options(root));
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings.map(w => w.code), ['THENABLE_KEY']);
  assert.match(result.warnings[0].hint, /never await the messages object directly/);
  const project = await generate(options(root));
  assert.ok(project.warnings.some(w => w.code === 'THENABLE_KEY' && w.messageId === 'then'));
});

test('non-canonical catalog names are reported as IGNORED_CATALOG_FILE with the expected name', async t => {
  // fr.JSON rather than EN.json: case-insensitive filesystems would make EN.json replace en.json.
  const root = await catalogProject(t, { 'en.json': '{"a":"x"}', 'fr.JSON': '{"a":"x"}', 'en.yaml': 'a: x', 'fr.json5': '{a:"x"}' });
  const result = await check(options(root));
  assert.deepEqual(result.locales, ['en']);
  const ignored = result.warnings.filter(w => w.code === 'IGNORED_CATALOG_FILE');
  assert.deepEqual(ignored.map(w => w.file).sort(), ['fr.JSON', 'en.yaml', 'fr.json5'].map(name => join(root, 'messages', name)).sort());
  for (const warning of ignored) {
    assert.match(warning.message, /canonical BCP 47 tag/);
    assert.match(warning.hint, /en\.json or pt-BR\.json/);
  }
  const project = await generate(options(root));
  assert.equal(project.warnings.filter(w => w.code === 'IGNORED_CATALOG_FILE').length, 3);
});

test('ignored-file warnings are not written into a cached project', async t => {
  const root = await catalogProject(t, { 'en.json': '{"a":"x"}', 'en.yaml': 'a: x' });
  const cached = { ...options(root), persistentCache: true };
  const first = await generate(cached);
  const second = await generate(cached);
  assert.equal(first.warnings.length, 1);
  assert.equal(second.warnings.length, 1);
  assert.deepEqual(second.changed, []);
});
