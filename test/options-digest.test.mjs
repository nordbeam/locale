import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generate } from '../dist/project.js';
import { temporary } from './helpers.mjs';

const cli = new URL('../dist/cli.js', import.meta.url).pathname;

test('output written by a bundler plugin verifies as fresh against the CLI', async t => {
  const root = await realpath(await temporary(t));
  await mkdir(join(root, 'messages'));
  await writeFile(join(root, 'messages/en.json'), JSON.stringify({ hello: 'Hello {name}' }));
  await writeFile(join(root, 'nordbeam-locale.config.json'), JSON.stringify({ baseLocale: 'en', catalogs: 'messages', outDir: 'generated' }));
  // Bundler plugins pass only the options from the config file; the CLI also carries explicit undefined fields such as `missing`.
  await generate({ root, baseLocale: 'en', catalogs: 'messages', outDir: 'generated', development: false });
  const verify = spawnSync(process.execPath, [cli, 'verify', '--json'], { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production' } });
  assert.equal(verify.status, 0, verify.stdout + verify.stderr);
  assert.equal(JSON.parse(verify.stdout).freshness.status, 'fresh');
});

test('without NODE_ENV or a mode flag, verify and inspect accept output from either build mode', async t => {
  const root = await realpath(await temporary(t));
  await mkdir(join(root, 'messages'));
  await writeFile(join(root, 'messages/en.json'), JSON.stringify({ hello: 'Hello {name}' }));
  await writeFile(join(root, 'nordbeam-locale.config.json'), JSON.stringify({ baseLocale: 'en', catalogs: 'messages', outDir: 'generated' }));
  const env = { ...process.env };
  delete env.NODE_ENV;
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', env });
  // What `vite build` leaves behind: production output, written by the plugin.
  await generate({ root, baseLocale: 'en', catalogs: 'messages', outDir: 'generated', development: false });
  let verify = run('verify', '--json');
  assert.equal(verify.status, 0, verify.stdout + verify.stderr);
  assert.deepEqual(JSON.parse(verify.stdout).freshness, { status: 'fresh', mode: 'production', staleReason: [], modifiedFiles: [] });
  assert.equal(JSON.parse(run('inspect', '--json').stdout).freshness.mode, 'production');
  assert.equal(run('verify', '--production').status, 0);
  // Asking for a mode makes it a requirement, and the stale reason names the mismatch.
  verify = run('verify', '--development', '--json');
  assert.equal(verify.status, 1);
  const report = JSON.parse(verify.stdout);
  assert.equal(report.freshness.staleReason[0].message, 'the output is a production build, and a development build was asked for');
  assert.equal(report.freshness.next, 'nordbeam-locale');
  // Development output verifies by default, and a production check says how to regenerate.
  assert.equal(run('generate').status, 0);
  assert.equal(JSON.parse(run('verify', '--json').stdout).freshness.mode, 'development');
  const production = JSON.parse(run('verify', '--production', '--json').stdout);
  assert.equal(production.freshness.next, 'nordbeam-locale --production');
  // A changed catalog is stale in either mode.
  await writeFile(join(root, 'messages/en.json'), JSON.stringify({ hello: 'Hi {name}' }));
  assert.equal(run('verify').status, 1);
});
