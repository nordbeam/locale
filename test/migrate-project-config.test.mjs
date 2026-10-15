import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';
import { migrateProject } from '@nordbeam/locale-migrate/project';
import { validateConfig } from '../dist/config.js';
import { temporary } from './helpers.mjs';

const cli = (root, ...args) => spawnSync(process.execPath, [resolve('dist/cli.js'), ...args], { cwd: root, encoding: 'utf8' });
const ok = result => assert.equal(result.status, 0, result.stdout + result.stderr);
const exists = file => access(file).then(() => true, () => false);
const mode = async file => (await stat(file)).mode & 0o777;

async function fixture(t, dependencies = {}) {
  const root = await temporary(t);
  await mkdir(join(root, 'legacy'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies }) + '\n');
  await writeFile(join(root, 'legacy/en.json'), JSON.stringify({ Checkout: { title: 'Checkout', items: '{count, plural, one {# item} other {# items}}' } }));
  await writeFile(join(root, 'legacy/fr.json'), JSON.stringify({ Checkout: { title: 'Paiement', items: '{count, plural, one {# article} other {# articles}}' } }));
  await writeFile(join(root, 'src/page.tsx'), `const t = useTranslations('Checkout');\nexport const Page = () => t('title');\n`);
  return root;
}

for (const framework of ['next', 'vite-react']) {
  test(`migrate-project --write persists only config keys, and the config passes check (${framework})`, async t => {
    const root = await fixture(t, framework === 'next' ? { next: '^16.0.0' } : { vite: '^6.0.0' });
    const result = await migrateProject({ root, from: 'legacy', format: 'i18next', sourceDir: 'src', framework, write: true });
    assert.equal(result.dryRun, false);
    const config = JSON.parse(await readFile(join(root, 'nordbeam-locale.config.json'), 'utf8'));
    assert.deepEqual(Object.keys(config).sort(), ['baseLocale', 'catalogs']);
    for (const value of Object.values(config)) assert.equal(typeof value === 'string' && isAbsolute(value), false);
    assert.doesNotThrow(() => validateConfig(config));
    ok(cli(root, 'check'));
  });
}

test('migration preview lists the generated, scaffold, config and package.json effects that --write applies', async t => {
  const root = await fixture(t);
  const options = { root, from: 'legacy', format: 'next-intl', sourceDir: 'src', outDir: 'generated', framework: 'next' };
  const preview = await migrateProject({ ...options, write: false });
  assert.equal(preview.dryRun, true);
  assert.equal(await exists(join(root, 'generated')), false);
  assert.equal(await exists(join(root, 'nordbeam-locale.config.json')), false);
  assert.ok(preview.generatedFiles.includes('generated/index.js'));
  assert.deepEqual(preview.scaffoldFiles, ['next.config.mjs', 'generated/next.ts', 'generated/client.ts', 'generated/provider.ts', 'generated/routing.ts', 'proxy.ts']);
  assert.deepEqual(preview.configFiles, ['nordbeam-locale.config.json']);
  assert.deepEqual(preview.packageEdits, ['package.json']);

  const written = await migrateProject({ ...options, write: true });
  assert.deepEqual(written.generatedFiles, preview.generatedFiles);
  assert.deepEqual(written.scaffoldFiles, preview.scaffoldFiles);
  assert.deepEqual(written.configFiles, preview.configFiles);
  assert.deepEqual(written.packageEdits, preview.packageEdits);
});

test('rollback restores the original file modes and leaves no staged temporary files', async t => {
  const root = await fixture(t);
  const page = join(root, 'src/page.tsx'), output = join(root, 'src/i18n');
  const original = await readFile(page, 'utf8');
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'index.js'), 'user-owned\n');
  await chmod(join(output, 'index.js'), 0o640);
  await chmod(page, 0o750);
  // An unowned generated destination makes initialize fail after the
  // transaction snapshot is taken, which exercises the rollback path.
  await assert.rejects(migrateProject({ root, from: 'legacy', format: 'next-intl', sourceDir: 'src', write: true }), /Refusing to overwrite unowned output/);
  assert.equal(await readFile(page, 'utf8'), original);
  assert.equal(await mode(page), 0o750);
  assert.equal(await mode(join(output, 'index.js')), 0o640);
  assert.deepEqual((await readdir(join(root, 'src'))).filter(name => name.endsWith('.tmp')), []);
  assert.deepEqual((await readdir(output)).filter(name => name.endsWith('.tmp')), []);
});
