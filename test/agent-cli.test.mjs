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
  await writeFile(join(root, 'nordbeam-i18n.config.json'), JSON.stringify({ baseLocale: 'en', catalogs: 'messages', outDir: 'generated' }));
  return root;
}

test('explicit machine commands return one versioned JSON document', async t => {
  const root = await project(t);
  let result = cli(root, 'generate', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(json(result).ok, true);

  result = cli(root, 'schema', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(json(result).messageCount, 1);

  await writeFile(join(root, 'messages/fr.json'), JSON.stringify({ greeting: 'Bonjour' }));
  result = cli(root, 'export', '--locale', 'fr', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.match(json(result).output, /msgctxt "greeting"/);

  const fresh = await temporary(t);
  result = cli(fresh, 'init', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(json(result).seeded, true);

  result = cli(root, '--config', 'nordbeam-i18n.config.json', 'generate', '--unknown-agent-option', '--json');
  assert.equal(result.status, 2);
  assert.equal(json(result).ok, false);
});

test('NDJSON starts with a version event and ends with a structured result', async t => {
  const root = await project(t);
  let result = cli(root, 'inspect', '--ndjson');
  assert.equal(result.status, 0, result.stderr);
  let events = lines(result);
  assert.equal(events[0].type, 'version');
  assert.deepEqual(events.filter(event => event.type === 'progress').map(event => event.completed), [0, 1]);
  assert.equal(events.at(-1).type, 'final');
  assert.equal(events.at(-1).result.catalogCount, 1);

  await writeFile(join(root, 'messages/en.json'), '{');
  result = cli(root, 'check', '--ndjson');
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  events = lines(result);
  assert.equal(events[0].type, 'version');
  assert.ok(events.some(event => event.type === 'diagnostic' && event.severity === 'error'));
  assert.equal(events.at(-1).status, 'failed');
});

test('codemod plans are reviewable, apply exactly once, and reject stale source', async t => {
  const root = await project(t);
  const source = join(root, 'src/app.ts');
  await writeFile(source, "const t = useTranslations();\nt('greeting');\n");
  let result = cli(root, 'codemod', '--format', 'next-intl', '--source-dir', 'src', '--plan', '.nordbeam/codemod.json', '--json');
  assert.equal(result.status, 0, result.stderr);
  const preview = json(result);
  assert.match(preview.plan.planHash, /^[a-f0-9]{64}$/);
  assert.equal(await readFile(source, 'utf8'), "const t = useTranslations();\nt('greeting');\n");

  result = cli(root, 'apply-plan', '--from', '.nordbeam/codemod.json', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(json(result).changed, ['src/app.ts']);
  assert.match(await readFile(source, 'utf8'), /m\.greeting\(\)/);

  await writeFile(source, "const t = useTranslations();\nt('greeting');\n");
  result = cli(root, 'codemod', '--format', 'next-intl', '--source-dir', 'src', '--plan', '.nordbeam/stale.json', '--json');
  assert.equal(result.status, 0, result.stderr);
  await writeFile(source, '// concurrent edit\n');
  result = cli(root, 'apply-plan', '--from', '.nordbeam/stale.json', '--json');
  assert.equal(result.status, 4);
  assert.equal(json(result).errors[0].code, 'STALE_PLAN');
  assert.equal(await readFile(source, 'utf8'), '// concurrent edit\n');
});
