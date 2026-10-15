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
