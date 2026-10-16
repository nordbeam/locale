import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CliError, errorCodes, exitCodes } from '../dist/error-codes.js';
import { loadMigrate } from '../dist/migrate-loader.js';
import { temporary } from './helpers.mjs';

const root = new URL('../', import.meta.url);
const rootPackage = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const migratePackage = JSON.parse(await readFile(new URL('packages/locale-migrate/package.json', root), 'utf8'));
const cli = new URL('dist/cli.js', root).pathname;
const parsers = ['@babel/parser', 'fast-xml-parser', 'gettext-parser', 'yaml'];

test('the core dist does not load the migration parsers or the moved modules', async () => {
  const files = (await readdir(new URL('dist/', root), { recursive: true })).filter(file => /\.(?:d\.ts|js)$/.test(file));
  const specifier = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
  for (const file of files) {
    const text = await readFile(new URL(`dist/${file}`, root), 'utf8');
    for (const [, name] of text.matchAll(specifier)) assert.ok(!parsers.includes(name), `dist/${file} imports ${name}`);
  }
  for (const moved of ['codemods.js', 'migrate-project.js', 'migrate-next.js', 'migrate-react.js', 'migrate-frameworks.js', 'catalog-formats.js']) {
    assert.equal(existsSync(new URL(`dist/${moved}`, root)), false, `dist/${moved} should live in the migration package`);
  }
});

test('the core CLI no longer imports the moved modules statically or dynamically', async () => {
  const moved = 'codemods|catalog-formats|migrate-project|migrate-next|migrate-react|migrate-frameworks';
  const source = await readFile(new URL('src/cli-main.ts', root), 'utf8');
  assert.doesNotMatch(source, new RegExp(`(?:from|import\\()\\s*'\\./(?:${moved})\\.js'`));
  assert.doesNotMatch(await readFile(new URL('src/cli-tools.ts', root), 'utf8'), /catalog-formats|migrateCatalog/);
});

test('a missing migration package fails with an install hint and exit status 3', async () => {
  const error = await loadMigrate('codemod', '@nordbeam/does-not-exist').then(() => assert.fail('expected a rejection'), error => error);
  assert.ok(error instanceof CliError);
  assert.equal(error.code, 'MIGRATE_PACKAGE_MISSING');
  assert.equal(error.exitCode, exitCodes.inputNotFound);
  assert.equal(error.details.package, '@nordbeam/locale-migrate');
  assert.equal(error.details.version, rootPackage.version);
  assert.equal(error.details.install, `npm install --save-dev @nordbeam/locale-migrate@${rootPackage.version}`);
  assert.match(error.message, /^codemod needs @nordbeam\/locale-migrate\. Install it: npm install --save-dev @nordbeam\/locale-migrate@/);
});

test('a version mismatch fails with both versions and exit status 1', async t => {
  const dir = await temporary(t);
  const file = join(dir, 'migrate.mjs');
  await writeFile(file, 'export const version = "0.0.1";\n');
  const error = await loadMigrate('migrate', pathToFileURL(file).href).then(() => assert.fail('expected a rejection'), error => error);
  assert.ok(error instanceof CliError);
  assert.equal(error.code, 'MIGRATE_PACKAGE_VERSION');
  assert.equal(error.exitCode, exitCodes.validation);
  assert.equal(error.details.installedVersion, '0.0.1');
  assert.equal(error.details.version, rootPackage.version);
  assert.match(error.message, new RegExp(`@nordbeam/locale-migrate@${rootPackage.version}, but .* is 0\\.0\\.1`));
  assert.match(error.details.install, /npm install --save-dev @nordbeam\/locale-migrate@/);
});

test('the installed migration package loads at the core version', async () => {
  const module = await loadMigrate('codemod');
  assert.equal(module.version, rootPackage.version);
  for (const name of ['codemodProject', 'migrateProject', 'migrateCatalog']) assert.equal(typeof module[name], 'function', name);
});

test('the migration package version and peer dependency match the core package exactly', async () => {
  assert.equal(migratePackage.name, '@nordbeam/locale-migrate');
  assert.equal(migratePackage.version, rootPackage.version);
  assert.equal(migratePackage.peerDependencies['@nordbeam/locale'], rootPackage.version);
  const index = await import(new URL('packages/locale-migrate/dist/index.js', root));
  assert.equal(index.version, rootPackage.version);
});

test('the npx package runs the core CLI at the core version', async () => {
  const npxPackage = JSON.parse(await readFile(new URL('packages/nordbeam-locale/package.json', root), 'utf8'));
  assert.equal(npxPackage.name, 'nordbeam-locale');
  assert.equal(npxPackage.version, rootPackage.version);
  assert.deepEqual(npxPackage.dependencies, { '@nordbeam/locale': rootPackage.version });
  assert.deepEqual(npxPackage.bin, { 'nordbeam-locale': 'cli.js' });
  const run = spawnSync(process.execPath, [new URL('packages/nordbeam-locale/cli.js', root).pathname, '--version'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), `nordbeam-locale ${rootPackage.version}`);
});

test('core no longer depends on the four migration parsers', () => {
  for (const name of parsers) assert.equal(name in rootPackage.dependencies, false, name);
  for (const name of parsers) assert.equal(name in migratePackage.dependencies, true, name);
});

test('the migration error codes are registered with their exit statuses', () => {
  assert.equal(errorCodes.MIGRATE_PACKAGE_MISSING.exitCode, exitCodes.inputNotFound);
  assert.equal(errorCodes.MIGRATE_PACKAGE_VERSION.exitCode, exitCodes.validation);
});

test('agent capabilities name the package that the migration commands need', async () => {
  const { getAgentCapabilities } = await import('../dist/agent.js');
  const required = getAgentCapabilities().commands.filter(command => command.requires).map(command => command.name).sort();
  assert.deepEqual(required, ['codemod', 'migrate', 'migrate-project']);
  assert.ok(getAgentCapabilities().commands.filter(command => command.requires).every(command => command.requires === '@nordbeam/locale-migrate'));
});

test('codemod help names the package, and a real codemod run works end to end', async t => {
  const help = spawnSync(process.execPath, [cli, 'codemod', '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /needs @nordbeam\/locale-migrate/);

  const project = await temporary(t);
  await mkdir(join(project, 'src'));
  await writeFile(join(project, 'src/page.tsx'), "import { useTranslations } from 'next-intl';\nexport default function Page() { const t = useTranslations('nav'); return <a>{t('home')}</a>; }\n");
  const run = spawnSync(process.execPath, [cli, 'codemod', '--format', 'next-intl', '--source-dir', 'src', '--json'], { cwd: project, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.dryRun, true);
  assert.equal(report.replacements, 1);
});

test('every entry point resolves for require(), so a config bundled as CommonJS can load the Vite plugin', async () => {
  for (const pkg of [rootPackage, migratePackage]) {
    for (const [key, conditions] of Object.entries(pkg.exports)) assert.equal(conditions.default, conditions.import, `${pkg.name} ${key} needs a default condition`);
  }
  // Vite bundles vite.config.ts as CommonJS in a package without "type": "module"; Node 22.12+ requires ES modules.
  const require = createRequire(new URL('package.json', root));
  assert.equal(typeof require('@nordbeam/locale/vite').default, 'function');
  assert.equal(typeof require('@nordbeam/locale/vite').nordbeamLocale, 'function');
});
