import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { nordbeamLocale } from '../dist/vite.js';
import { temporary, waitFor } from './helpers.mjs';

const cli = (root, ...args) => spawnSync(process.execPath, [resolve('dist/cli.js'), ...args], {cwd: root, encoding: 'utf8'});
const ok = result => assert.equal(result.status, 0, result.stdout + result.stderr);

test('CLI presents versioned and grouped help, targeted help, and actionable errors', async t => {
  const root = await temporary(t);
  const version = cli(root, '--version');
  ok(version); assert.match(version.stdout, /^nordbeam-locale \d+\.\d+\.\d+/);
  const help = cli(root, '--help');
  ok(help); assert.match(help.stdout, /Core:/); assert.match(help.stdout, /^  generate\s/m); assert.match(help.stdout, /^  init\s/m);
  const command = cli(root, 'help', 'init');
  ok(command); assert.match(command.stdout, /^nordbeam-locale init /);
  const unknown = cli(root, 'import', '--fromm');
  assert.equal(unknown.status, 2); assert.match(unknown.stderr, /Unknown option --fromm, did you mean --from\?/);
  const missing = cli(root);
  assert.equal(missing.status, 3); assert.match(missing.stderr, /No catalogs directory at messages\/\. Run nordbeam-locale init, or set "catalogs"/);
});

test('init creates working JS/types, discovers custom paths and preserves subsequent edits', async t => {
  const root = await temporary(t);
  const result = cli(root, 'init', '--catalogs', 'translations', '--out-dir', 'generated');
  ok(result);
  assert.match(result.stdout, /ready/);
  const configFile = join(root, 'nordbeam-locale.config.json');
  const configText = await readFile(configFile, 'utf8');
  assert.deepEqual(JSON.parse(configText), {baseLocale: 'en', catalogs: 'translations', outDir: 'generated'});
  const {selectMessages} = await import(pathToFileURL(join(root, 'generated/index.js')));
  const {messages} = await selectMessages('greeting', 'items')('en');
  assert.equal(messages.greeting({name: 'Ada'}), 'Hello Ada!');
  assert.equal(messages.items({count: 3}), '3 items');
  assert.equal(messages.items({count: 0}), 'Your basket is empty');
  await access(join(root, 'generated/messages.d.ts'));
  const generated = join(root, 'generated/locales/en.js');
  const before = (await stat(generated)).mtimeMs;
  ok(cli(root, 'init'));
  assert.equal((await stat(generated)).mtimeMs, before);
  const source = join(root, 'translations/en.json');
  const edited = '{"welcome":"Welcome back {name}"}\n';
  await writeFile(source, edited);
  ok(cli(root));
  assert.match(await readFile(generated, 'utf8'), /Welcome back/);
  assert.match(await readFile(generated, 'utf8'), /expected message arguments/);
  const productionConfig = JSON.parse(configText);
  productionConfig.development = true;
  await writeFile(configFile, JSON.stringify(productionConfig));
  const production = spawnSync(process.execPath, [resolve('dist/cli.js')], {
    cwd: root, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production' },
  });
  ok(production);
  assert.doesNotMatch(await readFile(generated, 'utf8'), /expected message arguments/);
  await writeFile(configFile, configText);
  ok(cli(root, 'init'));
  assert.equal(await readFile(source, 'utf8'), edited);
  assert.equal(await readFile(configFile, 'utf8'), configText);
  assert.equal(cli(root, 'init', '--out-dir', 'other').status, 4);
  assert.equal(cli(root, 'unknown-command').status, 2);
  assert.equal(cli(root, 'init', '--watch').status, 2);
});

test('init adopts existing catalogs and rejects invalid or conflicting destinations before creating sources', async t => {
  const root = await temporary(t);
  const dir = join(root, 'nested', 'translations');
  await mkdir(dir, {recursive: true});
  const source = '{"welcome":"Bonjour {name}"}\n';
  await writeFile(join(dir, 'fr.json'), source);
  ok(cli(root, 'init', '--config', 'nested/i18n.json', '--base-locale', 'fr', '--catalogs', 'translations', '--out-dir', 'generated'));
  assert.equal(await readFile(join(dir, 'fr.json'), 'utf8'), source);
  await assert.rejects(access(join(dir, 'en.json')), {code: 'ENOENT'});
  ok(cli(root, '--config', 'nested/i18n.json'));
  const failed = await temporary(t);
  await mkdir(join(failed, 'src/i18n'), {recursive: true});
  await writeFile(join(failed, 'src/i18n/index.js'), 'user code');
  const conflict = cli(failed, 'init');
  assert.equal(conflict.status, 4);
  assert.match(conflict.stderr, /Refusing to overwrite unowned/);
  assert.equal(await readFile(join(failed, 'src/i18n/index.js'), 'utf8'), 'user code');
  await assert.rejects(access(join(failed, 'messages')), {code: 'ENOENT'});
  await assert.rejects(access(join(failed, 'nordbeam-locale.config.json')), {code: 'ENOENT'});
  assert.equal(cli(failed, 'init', '--catalogs', 'src/i18n/..messages').status, 2);
  const invalid = await temporary(t);
  await mkdir(join(invalid, 'messages'));
  await writeFile(join(invalid, 'messages/en.json'), '{"bad":"{broken"}');
  assert.equal(cli(invalid, 'init').status, 1);
  await assert.rejects(access(join(invalid, 'src')), {code: 'ENOENT'});
  await assert.rejects(access(join(invalid, 'nordbeam-locale.config.json')), {code: 'ENOENT'});
});

test('init --framework next creates a safe config wrapper and typed App Router helper', async t => {
  const root = await temporary(t);
  const result = cli(root, 'init', '--framework', 'next');
  ok(result);
  assert.match(result.stdout, /Created next\.config\.mjs/);
  assert.match(result.stdout, /Next\.js scaffold/);
  assert.match(await readFile(join(root, 'next.config.mjs'), 'utf8'), /withNordbeamLocale/);
  const helper = await readFile(join(root, 'src/i18n/next.ts'), 'utf8');
  assert.match(helper, /createNextI18n/);
  assert.match(helper, /from '\.\/index\.js'/);
  const edited = '// keep this app-owned adapter\n' + helper;
  await writeFile(join(root, 'src/i18n/next.ts'), edited);
  ok(cli(root, 'init', '--framework', 'next'));
  assert.equal(await readFile(join(root, 'src/i18n/next.ts'), 'utf8'), edited);
  assert.equal(cli(root, 'init', '--framework', 'bogus').status, 2);
});

test('init --framework vite-react creates plugin config and client adapter without replacing existing config', async t => {
  const root = await temporary(t);
  await writeFile(join(root, 'vite.config.ts'), 'export default {}\n');
  const result = cli(root, 'init', '--framework', 'vite-react');
  ok(result);
  assert.match(result.stdout, /Preserved vite\.config\.ts/);
  assert.equal(await readFile(join(root, 'vite.config.ts'), 'utf8'), 'export default {}\n');
  assert.match(await readFile(join(root, 'src/i18n/client.ts'), 'utf8'), /createClientI18n/);
  assert.match(result.stdout, /Vite React scaffold/);
  assert.equal(cli(root, 'init', '--framework', 'next', '--base-locale', 'fr').status, 4);
});

test('init adopts conventional locale directory and framework dependencies, and adds package scripts', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'src/locales'), { recursive: true });
  await writeFile(join(root, 'src/locales/en.json'), '{"hello":"Hello"}\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { next: '^16.0.0' }, scripts: { build: 'next build' } }) + '\n');
  const result = cli(root, 'init');
  ok(result);
  const config = JSON.parse(await readFile(join(root, 'nordbeam-locale.config.json'), 'utf8'));
  assert.equal(config.catalogs, 'src/locales');
  assert.match(await readFile(join(root, 'next.config.mjs'), 'utf8'), /withNordbeamLocale/);
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts.i18n, 'nordbeam-locale');
  assert.equal(packageJson.scripts['i18n:watch'], 'nordbeam-locale --watch');
  // prepare runs on every install, so generation is a prebuild hook instead.
  assert.equal(packageJson.scripts.prepare, undefined);
  assert.equal(packageJson.scripts.prebuild, 'nordbeam-locale --production');
});

test('init adds the generated directory to lint and format ignore files, and names the configs it does not edit', async t => {
  const root = await temporary(t);
  await writeFile(join(root, '.eslintignore'), 'dist');
  await writeFile(join(root, '.prettierignore'), 'coverage/\nsrc/i18n/\n');
  await writeFile(join(root, '.oxfmtrc.json'), JSON.stringify({ printWidth: 100, ignorePatterns: ['dist/**'] }, null, 4) + '\n');
  await writeFile(join(root, 'eslint.config.js'), 'export default [];\n');
  const result = cli(root, 'init', '--json');
  ok(result);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.updated.sort(), ['.eslintignore', '.oxfmtrc.json']);
  assert.equal(await readFile(join(root, '.eslintignore'), 'utf8'), 'dist\n# Generated by nordbeam-locale\n/src/i18n/\n');
  // A line that already covers the directory is left alone.
  assert.equal(await readFile(join(root, '.prettierignore'), 'utf8'), 'coverage/\nsrc/i18n/\n');
  assert.equal(await readFile(join(root, '.oxfmtrc.json'), 'utf8'), JSON.stringify({ printWidth: 100, ignorePatterns: ['dist/**', 'src/i18n/**'] }, null, 4) + '\n');
  assert.deepEqual(report.notes, ['add { ignores: ["src/i18n/"] } to eslint.config.js; generated code is not written to your lint rules.']);
  // A second init has nothing to add.
  await rm(join(root, 'nordbeam-locale.config.json'));
  assert.equal(JSON.parse(cli(root, 'init', '--json').stdout).updated, undefined);
});

test('init recognizes the legacy nordbeam-i18n lifecycle alias without duplicating generation', async t => {
  const root = await temporary(t);
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { prepare: 'nordbeam-i18n' } }) + '\n');
  ok(cli(root, 'init'));
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts.prepare, 'nordbeam-i18n');
  assert.equal(packageJson.scripts.prebuild, undefined);
});

test('Vite reads the init config, enables development checks, and restarts on configuration edits', async t => {
  const root = await temporary(t);
  ok(cli(root, 'init', '--catalogs', 'translations', '--out-dir', 'generated'));
  await writeFile(join(root, 'index.html'), '<script type="module" src="/main.js"></script>');
  await writeFile(join(root, 'main.js'), `import {selectMessages} from './generated/index.js'; globalThis.loadMessages=selectMessages('greeting');`);
  const server = await createServer({root, configFile:false, logLevel:'silent', plugins:[nordbeamLocale()], server:{host:'127.0.0.1',port:0}});
  let restart;
  const originalRestart = server.restart;
  server.restart = function (...args) { return restart = originalRestart.apply(this, args); };
  try {
    await server.listen();
    const initial = await server.transformRequest('/main.js');
    assert.match(initial.code, /nordbeam-locale\/selection/);
    const generated = join(root, 'generated/locales/en.js');
    assert.match(await readFile(generated, 'utf8'), /expected message arguments/);
    const configFile = join(root, 'nordbeam-locale.config.json');
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    config.development = false;
    await writeFile(configFile, JSON.stringify(config));
    await waitFor(() => restart !== undefined, 'Vite did not restart for its discovered config');
    await restart;
    assert.match(await readFile(generated, 'utf8'), /expected message arguments/);
    const code = await server.transformRequest('/main.js');
    assert.match(code.code, /nordbeam-locale\/selection/);
  } finally {
    // Finish a pending restart and close its replacement server before the
    // temporary-directory cleanup can delete configuration or generated files.
    try { await restart?.catch(() => undefined); }
    finally { await server.close(); }
  }
});
