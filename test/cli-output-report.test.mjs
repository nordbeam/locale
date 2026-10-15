import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { temporary } from './helpers.mjs';

const cli = (root, args = []) => {
  const env = { ...process.env };
  for (const key of ['NODE_ENV', 'FORCE_COLOR', 'NO_COLOR']) delete env[key];
  return spawnSync(process.execPath, [resolve('dist/cli.js'), ...args], { cwd: root, encoding: 'utf8', env });
};

// 1000 messages in three locales; about 30% are missing in fr and de, so each of those locales falls back 300 times.
async function largeProject(t) {
  const root = await temporary(t);
  await mkdir(join(root, 'messages'));
  const en = {}, fr = {}, de = {};
  for (let i = 0; i < 1000; i++) {
    const id = `section${Math.floor(i / 50)}.item${i}`;
    en[id] = `Hello {name}, item ${i}`;
    if (i % 10 >= 3) { fr[id] = `Bonjour {name}, élément ${i}`; de[id] = `Hallo {name}, Element ${i}`; }
  }
  await writeFile(join(root, 'messages/en.json'), JSON.stringify(en, null, 2));
  await writeFile(join(root, 'messages/fr.json'), JSON.stringify(fr, null, 2));
  await writeFile(join(root, 'messages/de.json'), JSON.stringify(de, null, 2));
  await writeFile(join(root, 'nordbeam-locale.config.json'), JSON.stringify({ baseLocale: 'en', catalogs: 'messages', outDir: 'src/i18n' }));
  return root;
}

async function smallProject(t, messages = { greeting: 'Hello {name}' }) {
  const root = await temporary(t);
  await mkdir(join(root, 'messages'));
  await writeFile(join(root, 'messages/en.json'), JSON.stringify(messages));
  await writeFile(join(root, 'nordbeam-locale.config.json'), JSON.stringify({ baseLocale: 'en', catalogs: 'messages', outDir: 'src/i18n' }));
  return root;
}

test('check --json groups repeated fallbacks, caps the output and keeps paths project-relative', async t => {
  const root = await largeProject(t);
  const result = cli(root, ['check', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.ok(result.stdout.length < 2000, `check --json is ${result.stdout.length} bytes`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.root, await realpath(root));
  assert.deepEqual(report.summary, { errors: 0, warnings: 600, byCode: { FALLBACK_MESSAGE: 600 } });
  assert.equal(report.warnings.length, 2);
  const [de, fr] = report.warnings;
  assert.deepEqual([de.code, de.locale, de.file, de.count], ['FALLBACK_MESSAGE', 'de', 'messages/de.json', 300]);
  assert.equal(de.messageIds.length, 10, 'grouped rows list a sample of their IDs by default');
  assert.equal(de.message, '300 messages fall back to en');
  assert.match(de.fix, /Translate the message/);
  assert.equal(fr.locale, 'fr');
  assert.equal(report.truncated, undefined);
  assert.equal(result.stdout.includes(await realpath(root)), true, 'the root is reported once');
  assert.equal(result.stdout.split(await realpath(root)).length, 2, 'no other absolute path below the root');
});

test('--limit caps every list, reports what was left out, and --limit all lifts the cap', async t => {
  const root = await largeProject(t);
  const capped = JSON.parse(cli(root, ['check', '--json', '--only', 'MISSING_MESSAGE']).stdout);
  assert.equal(capped.summary.warnings, 0);
  const fallbacks = cli(root, ['check', '--json', '--only', 'FALLBACK_MESSAGE', '--limit', '1']);
  const limited = JSON.parse(fallbacks.stdout);
  assert.equal(limited.warnings.length, 1);
  assert.deepEqual(limited.truncated, { warnings: 1 });
  assert.match(cli(root, ['check', '--only', 'FALLBACK_MESSAGE', '--limit', '1']).stdout, /Use --limit all, or --only CODE/);

  const everything = JSON.parse(cli(root, ['check', '--json', '--only', 'FALLBACK_MESSAGE', '--limit', 'all']).stdout);
  assert.equal(everything.truncated, undefined);
  assert.equal(everything.warnings[0].messageIds.length, 300);
});

test('--only filters by registry code and rejects an unknown code with a suggestion', async t => {
  const root = await largeProject(t);
  const filtered = JSON.parse(cli(root, ['check', '--json', '--only', 'fallback_message']).stdout);
  assert.deepEqual(Object.keys(filtered.summary.byCode), ['FALLBACK_MESSAGE']);

  const typo = cli(root, ['check', '--json', '--only', 'FALBACK_MESSAGE']);
  assert.equal(typo.status, 2);
  const error = JSON.parse(typo.stdout).errors[0];
  assert.equal(error.code, 'USAGE');
  assert.match(error.message, /Unknown code "FALBACK_MESSAGE", did you mean FALLBACK_MESSAGE\?/);
  assert.equal(error.suggestion, 'FALLBACK_MESSAGE');
});

test('--summary prints the summary, ok, the root and the first five errors only', async t => {
  const root = await smallProject(t, { greeting: 'Hello {name', a: 'x {', b: 'y {', c: 'z {', d: 'w {', e: 'v {' });
  const result = cli(root, ['check', '--json', '--summary']);
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(report).sort(), ['errors', 'ok', 'root', 'summary', 'truncated', 'version']);
  assert.equal(report.errors.length, 5);
  assert.equal(report.summary.errors, 6);
  assert.deepEqual(report.truncated, { errors: 1 });
});

test('the NDJSON final event carries the same summarized result without absolute paths', async t => {
  const root = await largeProject(t);
  const result = cli(root, ['check', '--ndjson']);
  assert.equal(result.status, 0, result.stderr);
  const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  const final = events.at(-1);
  assert.equal(final.type, 'final');
  assert.equal(final.result.summary.warnings, 600);
  assert.equal(final.result.warnings.length, 2);
  assert.equal(final.result.root, await realpath(root));
  const diagnostics = events.filter(event => event.type === 'diagnostic');
  assert.deepEqual(diagnostics.map(event => event.file), ['messages/de.json', 'messages/fr.json']);
  assert.ok(diagnostics.every(event => event.path === undefined));
});

test('verify exits 0 only when check passes and the generated output is fresh', async t => {
  const root = await smallProject(t);
  let result = cli(root, ['verify', '--json']);
  assert.equal(result.status, 1, 'no generated output yet');
  let report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.freshness.status, 'missing');
  assert.equal(report.errors[0].code, 'GENERATED_STALE');
  assert.equal(report.errors[0].docs, 'docs/reference/errors.md#generated_stale');

  assert.equal(cli(root, ['generate']).status, 0);
  result = cli(root, ['verify', '--json']);
  assert.equal(result.status, 0, result.stdout);
  report = JSON.parse(result.stdout);
  assert.deepEqual([report.ok, report.freshness.status, report.errors], [true, 'fresh', []]);

  await writeFile(join(root, 'messages/en.json'), JSON.stringify({ greeting: 'Hello {name}!' }));
  result = cli(root, ['verify']);
  assert.equal(result.status, 1);
  assert.match(result.stderr + result.stdout, /GENERATED_STALE: generated output is stale: catalog en\.json changed/);
  assert.match(result.stdout, /Next: nordbeam-locale/);
});

test('verify reports hand-edited generated files as GENERATED_MODIFIED', async t => {
  const root = await smallProject(t);
  assert.equal(cli(root, ['generate']).status, 0);
  await writeFile(join(root, 'src/i18n/locales/en.js'), (await readFile(join(root, 'src/i18n/locales/en.js'), 'utf8')) + '// edited\n');
  const result = cli(root, ['verify', '--json']);
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.freshness.status, 'modified');
  assert.deepEqual(report.freshness.modifiedFiles.map(item => item.input), ['locales/en.js']);
  assert.equal(report.errors[0].code, 'GENERATED_MODIFIED');
});

test('verify keeps the check error codes and exits 1', async t => {
  const root = await smallProject(t, { greeting: 'Hello {name' });
  const result = cli(root, ['verify', '--json']);
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.errors[0].code, 'INVALID_ICU');
  assert.equal(report.errors[0].file, 'messages/en.json');
});

test('inspect --id describes one message with project-relative locations', async t => {
  const root = await smallProject(t);
  await writeFile(join(root, 'messages/fr.json'), JSON.stringify({ greeting: 'Bonjour {name}' }));
  const json = cli(root, ['inspect', '--id', 'greeting', '--json']);
  assert.equal(json.status, 0, json.stderr);
  const message = JSON.parse(json.stdout);
  assert.equal(message.root, await realpath(root));
  assert.deepEqual(message.present, ['en', 'fr']);
  assert.deepEqual(message.arguments, [{ name: 'name', type: 'value', choices: [] }]);
  assert.equal(message.locales.find(item => item.locale === 'fr').file, 'messages/fr.json');

  const human = cli(root, ['inspect', '--id', 'greeting']);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /present:\s+en, fr/);
  assert.match(human.stdout, /missing:\s+none/);
  assert.match(human.stdout, /arguments:\s+name \(value\)/);
  assert.match(human.stdout, /en: messages\/en\.json:1:\d+ {2}Hello \{name\}/);
});

test('inspect --id on an unknown ID exits 1 with UNKNOWN_MESSAGE_ID and a suggestion', async t => {
  const root = await smallProject(t);
  const result = cli(root, ['inspect', '--id', 'greetng', '--json']);
  assert.equal(result.status, 1);
  const error = JSON.parse(result.stdout).errors[0];
  assert.equal(error.code, 'UNKNOWN_MESSAGE_ID');
  assert.equal(error.suggestion, 'greeting');
  assert.match(cli(root, ['inspect', '--id', 'greetng']).stderr, /did you mean greeting\?/);
});

test('inspect without --id shows freshness in human output', async t => {
  const root = await smallProject(t);
  const result = cli(root, ['inspect']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /generated output src\/i18n: missing\. Next: nordbeam-locale/);
});

test('init --agent writes the agent block, replaces it in place and keeps the user text', async t => {
  const root = await smallProject(t);
  await writeFile(join(root, 'AGENTS.md'), '# Team rules\n\nUse pnpm.\n');
  const first = cli(root, ['init', '--agent', '--json']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stderr, '');
  assert.deepEqual(JSON.parse(first.stdout).agentFiles, [{ file: 'AGENTS.md', action: 'updated' }]);
  const text = await readFile(join(root, 'AGENTS.md'), 'utf8');
  assert.match(text, /^# Team rules\n\nUse pnpm\.\n\n<!-- nordbeam-locale:start -->\n## Nordbeam Locale/);
  assert.match(text, /nordbeam-locale verify --json/);
  assert.match(text, /<!-- nordbeam-locale:end -->\n$/);

  await writeFile(join(root, 'AGENTS.md'), text.replace('Use pnpm.', 'Use pnpm everywhere.'));
  const second = cli(root, ['init', '--agent']);
  assert.equal(second.status, 0, second.stderr);
  const replaced = await readFile(join(root, 'AGENTS.md'), 'utf8');
  assert.match(replaced, /Use pnpm everywhere\./);
  assert.equal(replaced.split('<!-- nordbeam-locale:start -->').length, 2);
  assert.equal(await readFile(join(root, 'messages/en.json'), 'utf8'), '{"greeting":"Hello {name}"}');
  await assert.rejects(readFile(join(root, 'CLAUDE.md')), { code: 'ENOENT' });
});

test('init --agent updates an existing CLAUDE.md and never creates one', async t => {
  const root = await smallProject(t);
  await writeFile(join(root, 'CLAUDE.md'), '# Notes\n');
  const result = cli(root, ['init', '--agent']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(await readFile(join(root, 'CLAUDE.md'), 'utf8'), /nordbeam-locale:start/);
  assert.match(result.stdout, /Created AGENTS\.md/);
});

test('plain init hints at init --agent, and --agent does not refuse an existing config', async t => {
  const root = await smallProject(t);
  const plain = cli(root, ['init']);
  assert.match(plain.stdout, /Add agent instructions and skills with nordbeam-locale init --agent/);
  const existing = cli(root, ['init', '--agent', '--catalogs', 'other']);
  assert.equal(existing.status, 0, existing.stderr);
  assert.doesNotMatch(existing.stderr + existing.stdout, /CONFIG_EXISTS/);
});

test('init adds prebuild, never prepare, and keeps a prepare that already runs the CLI', async t => {
  const root = await temporary(t);
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { build: 'vite build' } }) + '\n');
  assert.equal(cli(root, ['init']).status, 0);
  let scripts = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).scripts;
  assert.equal(scripts.prebuild, 'nordbeam-locale');
  assert.equal(scripts.prepare, undefined);

  const chained = await temporary(t);
  await writeFile(join(chained, 'package.json'), JSON.stringify({ scripts: { prebuild: 'tsc' } }) + '\n');
  assert.equal(cli(chained, ['init']).status, 0);
  scripts = JSON.parse(await readFile(join(chained, 'package.json'), 'utf8')).scripts;
  assert.equal(scripts.prebuild, 'tsc && nordbeam-locale');
});

test('capabilities lists verify, the report options and the new reports convention', async t => {
  const root = await smallProject(t);
  const result = cli(root, ['capabilities', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const capabilities = JSON.parse(result.stdout);
  assert.equal(capabilities.protocolVersion, 1);
  const verify = capabilities.commands.find(command => command.name === 'verify');
  assert.deepEqual([verify.access, verify.idempotent, verify.json], ['read', true, true]);
  assert.deepEqual(capabilities.commands.find(command => command.name === 'check').options, ['limit', 'only', 'summary']);
  assert.deepEqual(capabilities.commands.find(command => command.name === 'init').options, ['agent']);
  assert.match(capabilities.conventions.reports, /truncated/);
});

test('verify passes right after init, with or without a framework scaffold', async t => {
  for (const framework of [undefined, 'vite-react', 'next']) {
    const root = await temporary(t);
    await mkdir(join(root, 'messages'));
    await writeFile(join(root, 'package.json'), '{"name":"app","private":true,"type":"module"}');
    await writeFile(join(root, 'messages/en.json'), '{"greeting":"Hello {name}"}');
    const init = cli(root, ['init', ...(framework ? ['--framework', framework] : [])]);
    assert.equal(init.status, 0, init.stderr);
    const verify = cli(root, ['verify', '--json']);
    assert.equal(verify.status, 0, `${framework ?? 'plain'}: ${verify.stdout}`);
    assert.equal(JSON.parse(verify.stdout).freshness.status, 'fresh');
  }
});

test('the generation input digest does not depend on option key order', async () => {
  const { inputDigest } = await import('../dist/persistent-cache.js');
  const sources = [{ name: 'en.json', text: '{"a":"A"}' }];
  const first = await inputDigest({ root: '/p', baseLocale: 'en', catalogs: 'messages', development: true }, sources, 'src/i18n');
  const second = await inputDigest({ development: true, catalogs: 'messages', baseLocale: 'en', root: '/p' }, sources, 'src/i18n');
  assert.equal(first.digest, second.digest);
});
