import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { editDistance, suggest } from '../dist/cli-help.js';
import { temporary } from './helpers.mjs';

// Child environments start from a clean slate for the variables under test.
const cli = (root, args = [], env = {}) => {
  const base = { ...process.env };
  for (const key of ['NODE_ENV', 'FORCE_COLOR', 'NO_COLOR']) delete base[key];
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete base[key]; else base[key] = value;
  return spawnSync(process.execPath, [resolve('dist/cli.js'), ...args], { cwd: root, encoding: 'utf8', env: base });
};
const lastLine = text => text.trimEnd().split('\n').at(-1);

async function project(t, { messages = { greeting: 'Hello {name}' }, config = {} } = {}) {
  const root = await temporary(t);
  await mkdir(join(root, 'messages'));
  await writeFile(join(root, 'messages/en.json'), JSON.stringify(messages));
  await writeFile(join(root, 'nordbeam-locale.config.json'), JSON.stringify({ baseLocale: 'en', catalogs: 'messages', outDir: 'generated', ...config }));
  return root;
}

test('did-you-mean uses real option and command names and stays silent when nothing is close', async t => {
  const root = await project(t);
  let result = cli(root, ['generate', '--strcit']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown option --strcit, did you mean --strict\?/);

  result = cli(root, ['genrate']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown command "genrate", did you mean generate\?/);

  result = cli(root, ['generate', '--zzzzzzzz']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown option --zzzzzzzz\. Run nordbeam-locale --help/);
  assert.doesNotMatch(result.stderr, /did you mean/);

  result = cli(root, ['xqzvwk']);
  assert.match(result.stderr, /Unknown command "xqzvwk"\. Run nordbeam-locale --help/);
});

test('edit distance counts adjacent transpositions once and suggestions respect the length limit', () => {
  assert.equal(editDistance('strcit', 'strict'), 1);
  assert.equal(editDistance('ab', 'ba'), 1);
  assert.equal(editDistance('kitten', 'sitting'), 3);
  assert.equal(suggest('--strcit', ['from', 'strict']), 'strict');
  assert.equal(suggest('--ab', ['cd']), undefined);
  assert.equal(suggest('--frm', ['from', 'format']), 'from');
});

test('a missing catalogs directory names the resolved path and the fix for check and generate', async t => {
  const root = await temporary(t);
  for (const args of [['check'], ['generate']]) {
    const result = cli(root, args);
    assert.equal(result.status, 3);
    assert.match(result.stderr, /No catalogs directory at messages\/\. Run nordbeam-locale init, or set "catalogs" in nordbeam-locale\.config\.json/);
    assert.doesNotMatch(result.stderr + result.stdout, /ENOENT/);
    assert.equal(result.stderr.includes(root), false);
  }
});

test('summary lines pluralize counts and use project-relative paths', async t => {
  const root = await project(t, { messages: { greeting: 'Hello' } });
  let result = cli(root, ['check']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /checked 1 message in 1 locale — 0 errors, 0 warnings\./);

  result = cli(root, ['generate']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 locale, \d+ files? updated in \d+ms → generated \(/);
  assert.equal(result.stdout.includes(root), false);

  result = cli(root, ['schema']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /wrote editor schemas for 1 message → \.nordbeam$/m);
  assert.equal(result.stdout.includes(root), false);
});

test('help prints per-command options, examples and an agent pointer', async t => {
  const root = await project(t);
  const detail = cli(root, ['generate', '--help']);
  assert.equal(detail.status, 0, detail.stderr);
  assert.match(detail.stdout, /^nordbeam-locale generate — /m);
  assert.match(detail.stdout, /Usage: nordbeam-locale \[generate\] \[options\]/);
  assert.match(detail.stdout, /^\s+--production\s+generate production output/m);
  assert.match(detail.stdout, /Examples:\n {2}nordbeam-locale generate --production/);
  assert.match(lastLine(detail.stdout), /nordbeam-locale agent-guide/);

  const viaHelp = cli(root, ['help', 'check']);
  assert.equal(viaHelp.status, 0, viaHelp.stderr);
  assert.match(viaHelp.stdout, /Options:/);
  assert.match(lastLine(viaHelp.stdout), /nordbeam-locale agent-guide/);

  const top = cli(root, ['--help']);
  assert.equal(top.status, 0, top.stderr);
  assert.match(lastLine(top.stdout), /nordbeam-locale agent-guide/);

  const unknown = cli(root, ['help', 'nosuch']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Unknown command/);
});

test('ANSI color appears only when forced, and never in machine output', async t => {
  const root = await project(t, { messages: { greeting: 'Hello' } });
  const plain = cli(root, ['check']);
  assert.equal(plain.status, 0, plain.stderr);
  assert.doesNotMatch(plain.stdout + plain.stderr, /\x1b\[/);

  const forced = cli(root, ['check'], { FORCE_COLOR: '1' });
  assert.match(forced.stdout, /\x1b\[32m/);

  await writeFile(join(root, 'messages/fr.json'), JSON.stringify({ greeting: 'Bonjour', extra: 'Hi' }));
  const failing = cli(root, ['check'], { FORCE_COLOR: '1' });
  assert.equal(failing.status, 1);
  assert.match(failing.stderr, /\x1b\[31m/);

  const json = cli(root, ['check', '--json'], { FORCE_COLOR: '1' });
  assert.doesNotMatch(json.stdout, /\x1b\[/);
  const ndjson = cli(root, ['check', '--ndjson'], { FORCE_COLOR: '1' });
  assert.doesNotMatch(ndjson.stdout, /\x1b\[/);
});

test('NO_COLOR disables color on a terminal-free run unless FORCE_COLOR is set', async t => {
  const root = await project(t, { messages: { greeting: 'Hello' } });
  const result = cli(root, ['check'], { NO_COLOR: '1' });
  assert.doesNotMatch(result.stdout, /\x1b\[/);
});

test('generate names its output mode and explains the unset NODE_ENV default', async t => {
  const root = await project(t);
  let result = cli(root, ['generate'], { NODE_ENV: 'production' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\(production output\)/);
  assert.equal(result.stderr, '');

  result = cli(root, ['generate'], { NODE_ENV: 'development' });
  assert.match(result.stdout, /\(development output\)/);

  result = cli(root, ['generate']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\(development output\)/);
  assert.match(result.stderr, /NODE_ENV is unset.*NODE_ENV=production or pass --production/);

  result = cli(root, ['generate', '--production']);
  assert.match(result.stdout, /\(production output\)/);
  assert.equal(result.stderr, '');
  result = cli(root, ['generate', '--production'], { NODE_ENV: 'development' });
  assert.match(result.stdout, /\(production output\)/);
});

test('production output is a different, smaller artifact than development output', async t => {
  const root = await project(t);
  assert.equal(cli(root, ['generate', '--development', '--out-dir', 'dev']).status, 0);
  assert.equal(cli(root, ['generate', '--production', '--out-dir', 'prod']).status, 0);
  const dev = await readFile(join(root, 'dev/internal/locales/en.js'), 'utf8');
  const prod = await readFile(join(root, 'prod/internal/locales/en.js'), 'utf8');
  assert.notEqual(dev, prod);
  assert.ok(prod.length < dev.length, `${prod.length} >= ${dev.length}`);
});

test('--production conflicts with --development and --json keeps stderr empty', async t => {
  const root = await project(t);
  const conflict = cli(root, ['generate', '--production', '--development']);
  assert.equal(conflict.status, 2);
  assert.match(conflict.stderr, /Choose either --development or --production, not both\./);

  const json = cli(root, ['generate', '--json']);
  assert.equal(json.status, 0, json.stderr);
  assert.equal(json.stderr, '');
});

test('a development flag in the config file is reported as ignored', async t => {
  const root = await project(t, { config: { development: false } });
  const result = cli(root, ['generate', '--production']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /CONFIG_DEVELOPMENT_IGNORED: .*development is ignored/);
  assert.match(result.stdout, /\(production output\)/);

  const machine = cli(root, ['check', '--json']);
  assert.equal(machine.stderr, '');
});
