import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { CliError, errorCodes, exitCodes } from '../dist/error-codes.js';

// Quoted uppercase words that are not package codes: Node error names and signals, and short literals.
const notCodes = new Set(['ERR_MODULE_NOT_FOUND', 'EEXIST', 'ENOENT', 'ENOTDIR', 'ESRCH', 'ICU', 'ID', 'JSX', 'LL', 'NEXT_LOCALE', 'NFD', 'SIGINT', 'SIGTERM', 'T', 'TS']);

async function sourceCodes() {
  const codes = new Set();
  // The migration package emits MIGRATION_* and codemod codes, so its sources count as well as the core sources.
  for (const directory of ['src', 'packages/locale-migrate/src']) {
    for (const file of await readdir(resolve(directory))) {
      if (!file.endsWith('.ts')) continue;
      for (const [, code] of (await readFile(resolve(directory, file), 'utf8')).matchAll(/'([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)'/g)) codes.add(code);
    }
  }
  return codes;
}

test('every code literal in src is in the registry, and every registry code is used', async () => {
  const emitted = [...await sourceCodes()].filter(code => !notCodes.has(code));
  const registered = Object.keys(errorCodes);
  assert.deepEqual(emitted.filter(code => !(code in errorCodes)), [], 'emitted codes missing from src/error-codes.ts');
  const used = new Set(emitted);
  assert.deepEqual(registered.filter(code => !used.has(code)), [], 'registry codes that no source file mentions');
});

test('every registry code has a heading, anchor and fix in docs/reference/errors.md', async () => {
  const docs = await readFile(resolve('docs/reference/errors.md'), 'utf8');
  const headings = new Set([...docs.matchAll(/^### ([A-Z][A-Z0-9_]*)$/gm)].map(match => match[1]));
  for (const entry of Object.values(errorCodes)) {
    assert.ok(headings.has(entry.code), `${entry.code} has no ### heading in docs/reference/errors.md`);
    assert.ok(docs.includes(`**Fix:** ${entry.fix}`), `${entry.code} fix text differs from the docs`);
    assert.equal(entry.docs, `docs/reference/errors.md#${entry.code.toLowerCase()}`);
  }
  assert.deepEqual([...headings].filter(code => !(code in errorCodes)), [], 'documented codes missing from the registry');
});

test('command errors map to their documented exit statuses', () => {
  assert.equal(new CliError('USAGE', 'x').exitCode, exitCodes.usage);
  assert.equal(new CliError('UNKNOWN_FORMAT', 'x').exitCode, exitCodes.usage);
  assert.equal(new CliError('FILE_NOT_FOUND', 'x').exitCode, exitCodes.inputNotFound);
  assert.equal(new CliError('FILE_EXISTS', 'x').exitCode, exitCodes.refused);
  assert.equal(new CliError('STALE_PLAN', 'x').exitCode, exitCodes.refused);
  assert.equal(new CliError('INTERNAL_ERROR', 'x').exitCode, exitCodes.internal);
  assert.equal(new CliError('INVALID_ICU', 'x').exitCode, exitCodes.validation);
  assert.equal(new CliError('NOT_A_CODE', 'x').exitCode, exitCodes.validation);
});

test('CliError keeps its code, message and structured details', () => {
  const error = new CliError('FILE_NOT_FOUND', 'Input not found: plan.json.', { path: 'plan.json' });
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'CliError');
  assert.equal(error.code, 'FILE_NOT_FOUND');
  assert.equal(error.message, 'Input not found: plan.json.');
  assert.deepEqual(error.details, { path: 'plan.json' });
});

test('registry severities and exit statuses are well formed', () => {
  for (const entry of Object.values(errorCodes)) {
    assert.ok(['error', 'warning'].includes(entry.severity), entry.code);
    assert.ok(entry.explanation.length > 20 && entry.fix.length > 10, `${entry.code} needs an explanation and a fix`);
    if (entry.exitCode !== undefined) assert.ok([1, 2, 3, 4, 70].includes(entry.exitCode), entry.code);
  }
  assert.equal(errorCodes.DUPLICATE_KEY.severity, 'error');
  assert.equal(errorCodes.UNUSED_MESSAGE.severity, 'warning');
});
