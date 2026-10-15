import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { temporary } from './helpers.mjs';

const executable = resolve('dist/cli.js');
const cli = (root, ...args) => spawnSync(process.execPath, [executable, ...args], { cwd: root, encoding: 'utf8' });
const json = result => {
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
};
const lines = result => result.stdout.trim().split('\n').map(line => JSON.parse(line));

async function project(t) {
  const root = await temporary(t);
  await mkdir(join(root, 'messages'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'messages/en.json'), JSON.stringify({ greeting: 'Hello' }));
  await writeFile(join(root, 'nordbeam-locale.config.json'), JSON.stringify({ baseLocale: 'en', catalogs: 'messages', outDir: 'generated' }));
  return root;
}

test('success exits 0 with one JSON document', async t => {
  const root = await project(t);
  const result = cli(root, 'check', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(json(result).ok, true);
});

test('validation failures exit 1 and carry the registry fix and docs link', async t => {
  const root = await project(t);
  await writeFile(join(root, 'messages/en.json'), '{"greeting":"{"}');
  const result = cli(root, 'check', '--json');
  assert.equal(result.status, 1);
  const error = json(result).errors[0];
  assert.equal(error.code, 'INVALID_ICU');
  assert.equal(error.docs, 'docs/reference/errors.md#invalid_icu');
  assert.equal(error.fix, error.hint, 'a diagnostic hint stays the fix');
});

test('an unknown option exits 2 and suggests the closest option', async t => {
  const root = await project(t);
  const result = cli(root, 'check', '--fromm', 'x', '--json');
  assert.equal(result.status, 2);
  const payload = json(result);
  assert.equal(payload.ok, false);
  assert.equal(payload.errors[0].code, 'USAGE');
  assert.equal(payload.errors[0].option, '--fromm');
  assert.equal(payload.errors[0].suggestion, '--from');
  assert.match(payload.errors[0].docs, /^docs\/reference\/errors\.md#usage$/);
});

test('a bad --format value exits 2 and lists the accepted values', async t => {
  const root = await project(t);
  const result = cli(root, 'migrate', '--from', 'legacy.json', '--format', 'bogus', '--json');
  assert.equal(result.status, 2);
  const [error] = json(result).errors;
  assert.equal(error.code, 'UNKNOWN_FORMAT');
  assert.equal(error.option, '--format');
  assert.equal(error.value, 'bogus');
  assert.ok(error.validValues.includes('i18next'));
  assert.ok(error.validValues.includes('apple-xcstrings'));
});

test('a bad codemod --format lists the source codemod formats', async t => {
  const root = await project(t);
  const result = cli(root, 'codemod', '--format', 'bogus', '--json');
  assert.equal(result.status, 2);
  const [error] = json(result).errors;
  assert.equal(error.code, 'UNKNOWN_FORMAT');
  assert.ok(error.validValues.includes('next-intl'));
});

test('a bad --framework value exits 2 and lists the frameworks', async t => {
  const root = await temporary(t);
  const result = cli(root, 'init', '--framework', 'bogus', '--json');
  assert.equal(result.status, 2);
  assert.deepEqual(json(result).errors[0].validValues, ['next', 'vite-react', 'vue', 'svelte', 'solid', 'tanstack-start']);
});

test('a missing catalogs directory exits 3 with the project-relative path', async t => {
  const root = await temporary(t);
  const result = cli(root, 'check', '--json');
  assert.equal(result.status, 3);
  const [error] = json(result).errors;
  assert.equal(error.code, 'FILE_NOT_FOUND');
  assert.equal(error.path, 'messages');
});

test('a missing --config file exits 3 instead of an invalid configuration', async t => {
  const root = await project(t);
  const result = cli(root, '--config', 'missing.json', 'check', '--json');
  assert.equal(result.status, 3);
  assert.equal(json(result).errors[0].code, 'FILE_NOT_FOUND');
  assert.equal(json(result).errors[0].path, 'missing.json');
});

test('a missing migration input exits 3', async t => {
  const root = await project(t);
  const result = cli(root, 'migrate', '--from', 'missing.json', '--format', 'i18next', '--json');
  assert.equal(result.status, 3);
  assert.equal(json(result).errors[0].code, 'FILE_NOT_FOUND');
  assert.equal(json(result).errors[0].path, 'missing.json');
});

test('an existing export target is refused with exit 4 and nothing is overwritten', async t => {
  const root = await project(t);
  await writeFile(join(root, 'out.po'), 'kept');
  const result = cli(root, 'export', '--locale', 'fr', '--out', 'out.po', '--json');
  assert.equal(result.status, 4);
  assert.equal(json(result).errors[0].code, 'FILE_EXISTS');
  assert.equal(json(result).errors[0].path, 'out.po');
  assert.equal(await readFile(join(root, 'out.po'), 'utf8'), 'kept');
});

test('init refuses to replace an existing configuration with exit 4', async t => {
  const root = await project(t);
  const result = cli(root, 'init', '--out-dir', 'other', '--json');
  assert.equal(result.status, 4);
  assert.equal(json(result).errors[0].code, 'CONFIG_EXISTS');
});

test('NDJSON final events carry the code and its details', async t => {
  const root = await project(t);
  const result = cli(root, 'apply-plan', '--from', 'missing-plan.json', '--ndjson');
  assert.equal(result.status, 3);
  const final = lines(result).at(-1);
  assert.equal(final.type, 'final');
  assert.equal(final.status, 'failed');
  assert.equal(final.error.code, 'FILE_NOT_FOUND');
  assert.equal(final.error.path, 'missing-plan.json');
});

test('capabilities publish the exit status categories and the explain command', async t => {
  const root = await temporary(t);
  const capabilities = JSON.parse(cli(root, 'capabilities', '--json').stdout);
  assert.deepEqual(capabilities.exitCodes, { success: 0, failure: 1, validation: 1, usage: 2, inputNotFound: 3, refused: 4, internal: 70 });
  assert.deepEqual(capabilities.commands.find(command => command.name === 'explain'), {
    name: 'explain', invocation: 'explain <CODE> --json', summary: 'Return the severity, explanation, fix and docs anchor for an error or diagnostic code.', access: 'read', json: true, preview: false, idempotent: true,
  });
});

test('a reported condition exits 1 with COMMAND_FAILED, and an unowned output file exits 4 with a relative path', async t => {
  const root = await project(t);
  await writeFile(join(root, 'nordbeam-locale.config.json'), JSON.stringify({ baseLocale: 'en', catalogs: 'messages', outDir: '.', persistentCache: 'messages' }));
  const overlap = cli(root, 'generate', '--json');
  const failure = json(overlap);
  assert.equal(overlap.status, 1, overlap.stdout);
  assert.equal(failure.errors[0].code, 'COMMAND_FAILED');
  await writeFile(join(root, 'nordbeam-locale.config.json'), JSON.stringify({ baseLocale: 'en', catalogs: 'messages', outDir: 'generated' }));
  await mkdir(join(root, 'generated'));
  await writeFile(join(root, 'generated/index.js'), 'user code');
  const unowned = cli(root, 'generate', '--json');
  assert.equal(unowned.status, 4, unowned.stdout);
  const refused = json(unowned).errors[0];
  assert.equal(refused.code, 'FILE_EXISTS');
  assert.equal(refused.path, 'generated/index.js');
  assert.equal(await readFile(join(root, 'generated/index.js'), 'utf8'), 'user code');
});
