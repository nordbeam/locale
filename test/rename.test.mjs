import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, access, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { discoverConfig, configName, legacyConfigName, historicalConfigName } from '../dist/config.js';
import { generate } from '../dist/project.js';
import { exportPo, importPo } from '../dist/translations.js';
import { doctor, extractMessage, pruneMessages, renameMessage } from '../dist/cli-tools.js';
import { temporary } from './helpers.mjs';

async function fixture(t) {
  const root = await temporary(t);
  await mkdir(join(root, 'messages'));
  await writeFile(join(root, 'messages/en.json'), JSON.stringify({ greeting: 'Hello {name}' }));
  await writeFile(join(root, 'messages/fr.json'), JSON.stringify({ greeting: '' }));
  return root;
}

test('package identity and public APIs use Nordbeam Locale names', async () => {
  const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(resolve('package-lock.json'), 'utf8'));
  assert.equal(packageJson.name, '@nordbeam/locale');
  assert.equal(lock.name, packageJson.name);
  assert.equal(lock.packages[''].name, packageJson.name);
  assert.deepEqual(packageJson.bin, { 'nordbeam-locale': './dist/cli.js', 'nordbeam-locale-mcp': './dist/mcp-bin.js', 'nordbeam-i18n': './dist/cli.js' });
  assert.deepEqual(lock.packages[''].bin, { 'nordbeam-locale': 'dist/cli.js', 'nordbeam-locale-mcp': 'dist/mcp-bin.js', 'nordbeam-i18n': 'dist/cli.js' });

  const root = await import('@nordbeam/locale');
  const vite = await import('@nordbeam/locale/vite');
  const next = await import('@nordbeam/locale/next');
  assert.equal(typeof root.createLocaleStore, 'function');
  assert.equal(typeof vite.nordbeamLocale, 'function');
  assert.equal(vite.default, vite.nordbeamLocale);
  assert.equal(vite.nordbeamI18n, vite.nordbeamLocale);
  assert.equal(vite.fasti18n, undefined);
  assert.equal(typeof next.withNordbeamLocale, 'function');
  assert.equal(next.withNordbeamI18n, next.withNordbeamLocale);
  assert.equal(next.withFasti18n, undefined);

  const viteTypes = await readFile(resolve('dist/vite.d.ts'), 'utf8');
  const nextTypes = await readFile(resolve('dist/next.d.ts'), 'utf8');
  assert.match(viteTypes, /NordbeamLocalePreloadManifest/);
  assert.match(viteTypes, /NordbeamI18nPreloadManifest/);
  assert.doesNotMatch(viteTypes, /Fasti18nPreloadManifest/);
  assert.match(nextTypes, /withNordbeamLocale/);
  assert.match(nextTypes, /withNordbeamI18n/);
  assert.doesNotMatch(nextTypes, /withFasti18n/);
});

test('config discovery uses the new filename, bounded legacy fallback and conflict guard', async t => {
  const root = await temporary(t);
  const current = join(root, configName), legacy = join(root, legacyConfigName);
  assert.equal(await discoverConfig(root), current);
  await writeFile(legacy, '{}');
  assert.equal(await discoverConfig(root), legacy);
  await writeFile(current, '{}');
  await assert.rejects(discoverConfig(root), /Multiple Nordbeam Locale config files exist/);
  const historicalOnly = await temporary(t);
  const historical = join(historicalOnly, historicalConfigName);
  await writeFile(historical, '{}');
  assert.equal(await discoverConfig(historicalOnly), historical);
});

test('manifest migration moves a legacy marker to the current name and stays safe when both exist', async t => {
  const root = await fixture(t);
  const options = { root, baseLocale: 'en', outDir: 'generated' };
  await generate(options);
  const current = join(root, 'generated/.nordbeam-locale-manifest.json');
  const legacy = join(root, 'generated/.nordbeam-i18n-manifest.json');
  const fasti = join(root, 'generated/.fasti18n-manifest.json');
  await rename(current, legacy);
  await generate(options);
  await access(current);
  await assert.rejects(access(legacy), { code: 'ENOENT' });

  await rename(current, fasti);
  await generate(options);
  await access(current);
  await assert.rejects(access(fasti), { code: 'ENOENT' });

  // Once the new marker exists, it is authoritative. A stale/corrupt legacy
  // marker must not be parsed or allowed to change ownership decisions.
  await writeFile(legacy, '{not-json');
  await generate(options);
  await access(current);

  // A corrupt new marker is never silently replaced by the legacy fallback.
  await writeFile(current, '{not-json');
  await assert.rejects(generate(options), error => error instanceof SyntaxError);
});

test('PO export writes new metadata and import accepts legacy metadata', async t => {
  const root = await fixture(t);
  const options = { root, baseLocale: 'en', locale: 'fr' };
  const current = await exportPo(options);
  assert.match(current.po, /X-Nordbeam-Locale-Format: 1/);
  assert.match(current.po, /#\. nordbeam-locale:empty/);
  assert.doesNotMatch(current.po, /nordbeam-i18n/i);
  const legacy = [
    current.po.replaceAll('X-Nordbeam-Locale-Format', 'X-Nordbeam-I18n-Format').replaceAll('nordbeam-locale:empty', 'nordbeam-i18n:empty'),
    current.po.replaceAll('X-Nordbeam-Locale-Format', 'X-Fasti18n-Format').replaceAll('nordbeam-locale:empty', 'fasti18n:empty'),
  ];
  for (const [index, po] of legacy.entries()) {
    await writeFile(join(root, 'fr.po'), po);
    const imported = await importPo({ ...options, from: 'fr.po', dryRun: true });
    assert.equal(imported.dryRun, true, `legacy variant ${index}`);
    assert.equal(imported.locale, 'fr');
  }
});

test('refactor tools rename nested IDs in catalogs and statically recognizable calls', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'messages')); await mkdir(join(root, 'src'));
  await writeFile(join(root, 'messages/en.json'), JSON.stringify({ checkout: { pay: 'Pay now', unused: 'Unused' } }, null, 2) + '\n');
  await writeFile(join(root, 'messages/fr.json'), JSON.stringify({ checkout: { pay: 'Payer', unused: 'Inutilisé' } }, null, 2) + '\n');
  const source = join(root, 'src/checkout.ts');
  await writeFile(source, 'm.checkout.pay(); m["checkout.pay"](); selectMessages("checkout.pay");\n');
  await mkdir(join(root, 'src/i18n'), { recursive: true });
  const generated = join(root, 'src/i18n/index.js');
  await writeFile(generated, 'm.checkout.pay();\n');
  const result = await renameMessage({ root, baseLocale: 'en', catalogs: 'messages', from: 'checkout.pay', to: 'checkout.submit', sourceDir: 'src' });
  assert.equal(result.changed.length, 3); assert.deepEqual(result.references, [source]);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'messages/en.json'))), { checkout: { unused: 'Unused', submit: 'Pay now' } });
  assert.equal(await readFile(source, 'utf8'), 'm.checkout.submit(); m["checkout.submit"](); selectMessages("checkout.submit");\n');
  assert.equal(await readFile(generated, 'utf8'), 'm.checkout.pay();\n');
});

test('extract validates and adds a source message, while prune is report-only', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'messages')); await mkdir(join(root, 'src'));
  await writeFile(join(root, 'messages/en.json'), JSON.stringify({ used: 'Used' }, null, 2) + '\n');
  await writeFile(join(root, 'messages/fr.json'), JSON.stringify({ used: 'Utilisé' }, null, 2) + '\n');
  await writeFile(join(root, 'src/app.ts'), 'm.used();\n');
  await extractMessage({ root, baseLocale: 'en', catalogs: 'messages', id: 'checkout.pay', message: 'Pay now' });
  assert.deepEqual(JSON.parse(await readFile(join(root, 'messages/en.json'))), { used: 'Used', checkout: { pay: 'Pay now' } });
  const result = await pruneMessages({ root, baseLocale: 'en', catalogs: 'messages', sourceDir: 'src', dryRun: true });
  assert.deepEqual(result.unused, ['checkout.pay']);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'messages/en.json'))), { used: 'Used', checkout: { pay: 'Pay now' } });
  const defaultReport = await pruneMessages({ root, baseLocale: 'en', catalogs: 'messages' });
  assert.deepEqual(defaultReport.unused, ['checkout.pay']);
});

test('doctor returns machine-readable catalog and unused-message diagnostics', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'messages')); await mkdir(join(root, 'src'));
  await writeFile(join(root, 'messages/en.json'), JSON.stringify({ used: 'Used', unused: 'Unused' }, null, 2) + '\n');
  await writeFile(join(root, 'src/app.ts'), 'm.used();\n');
  const result = await doctor({ root, baseLocale: 'en', catalogs: 'messages', sourceDir: 'src' });
  assert.equal(result.ok, true); assert.deepEqual(result.locales, ['en']); assert.deepEqual(result.unused, ['unused']);
  assert.equal(result.warnings[0]?.code, 'UNUSED_MESSAGE');
});

test('doctor discovers common source roots when --source-dir is omitted', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'messages')); await mkdir(join(root, 'src'));
  await writeFile(join(root, 'messages/en.json'), JSON.stringify({ used: 'Used', other: 'Other' }) + '\n');
  await writeFile(join(root, 'src/app.ts'), 'm.used();\n');
  const result = await doctor({ root, baseLocale: 'en', catalogs: 'messages' });
  assert.equal(result.unused.includes('used'), false);
  assert.equal(result.warnings.some(warning => warning.code === 'UNUSED_MESSAGE'), true);
});

test('rename ignores comments and string prose while finding nested property calls', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'messages')); await mkdir(join(root, 'src'));
  await writeFile(join(root, 'messages/en.json'), JSON.stringify({ product: { price: 'Price' } }) + '\n');
  const source = join(root, 'src/app.ts');
  await writeFile(source, '// m.product.price()\nconst label = "m.product.price()"; m.product.price();\n');
  await renameMessage({ root, baseLocale: 'en', catalogs: 'messages', from: 'product.price', to: 'product.cost', sourceDir: 'src' });
  assert.equal(await readFile(source, 'utf8'), '// m.product.price()\nconst label = "m.product.price()"; m.product.cost();\n');
});

test('prune and doctor recognize nested property calls but ignore commented calls', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'messages')); await mkdir(join(root, 'src'));
  await writeFile(join(root, 'messages/en.json'), JSON.stringify({ product: { price: 'Price', hidden: 'Hidden' } }) + '\n');
  await writeFile(join(root, 'src/app.ts'), '// m.product.hidden()\nconst prose = "m.product.hidden()"; m.product.price();\n');
  const pruned = await pruneMessages({ root, baseLocale: 'en', catalogs: 'messages', sourceDir: 'src', dryRun: true });
  assert.deepEqual(pruned.unused, ['product.hidden']);
  const diagnosis = await doctor({ root, baseLocale: 'en', catalogs: 'messages', sourceDir: 'src' });
  assert.deepEqual(diagnosis.unused, ['product.hidden']);
});
