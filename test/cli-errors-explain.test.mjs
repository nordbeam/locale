import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';
import { errorCodes } from '../dist/error-codes.js';
import { temporary } from './helpers.mjs';

const executable = resolve('dist/cli.js');
const cli = (root, ...args) => spawnSync(process.execPath, [executable, ...args], { cwd: root, encoding: 'utf8' });

test('explain prints the registry entry for a known code', async t => {
  const root = await temporary(t);
  const result = cli(root, 'explain', 'INVALID_ICU');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /^INVALID_ICU — error\n/);
  assert.ok(result.stdout.includes(errorCodes.INVALID_ICU.explanation));
  assert.ok(result.stdout.includes(`Fix: ${errorCodes.INVALID_ICU.fix}`));
  assert.ok(result.stdout.includes('Docs: docs/reference/errors.md#invalid_icu'));
});

test('explain --json returns the entry as a versioned document', async t => {
  const root = await temporary(t);
  const result = cli(root, 'explain', 'INVALID_ICU', '--json');
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.version, 1);
  assert.equal(output.ok, true);
  assert.equal(output.code, 'INVALID_ICU');
  assert.equal(output.severity, 'error');
  assert.equal(output.docs, 'docs/reference/errors.md#invalid_icu');
  assert.equal(output.fix, errorCodes.INVALID_ICU.fix);
});

test('explain accepts a lowercase code and reports the exit status of a refusal', async t => {
  const root = await temporary(t);
  const result = cli(root, 'explain', 'stale_plan', '--json');
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.code, 'STALE_PLAN');
  assert.equal(output.exitCode, 4);
});

test('an unknown code exits 2 with a did-you-mean suggestion', async t => {
  const root = await temporary(t);
  const result = cli(root, 'explain', 'invalid_icuu', '--json');
  assert.equal(result.status, 2);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.errors[0].code, 'USAGE');
  assert.equal(payload.errors[0].suggestion, 'INVALID_ICU');
  assert.match(payload.errors[0].message, /did you mean INVALID_ICU\?/);
});

test('an unknown code without a close match gives no suggestion', async t => {
  const root = await temporary(t);
  const result = cli(root, 'explain', 'ZZZZ_QQQQ_NOPE');
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Unknown code "ZZZZ_QQQQ_NOPE"\./);
});

test('explain without a code exits 2', async t => {
  const root = await temporary(t);
  const result = cli(root, 'explain');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /explain requires a code/);
});

test('help documents explain and the exit statuses', async t => {
  const root = await temporary(t);
  const specific = cli(root, 'help', 'explain');
  assert.equal(specific.status, 0, specific.stderr);
  assert.match(specific.stdout, /Usage: nordbeam-locale explain <CODE> \[--json\]/);
  assert.match(specific.stdout, /explain INVALID_ICU/);

  const general = cli(root, 'help');
  assert.match(general.stdout, /Exit status: 0 success, 1 validation failure, 2 usage error, 3 input not found, 4 refused unsafe operation, 70 internal error/);
});
