import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { auditProjectResidues, migrateProject } from '@nordbeam/locale-migrate/project';
import { temporary } from './helpers.mjs';

async function fixture(t) {
  const root = await temporary(t);
  const legacy = join(root, 'legacy');
  const source = join(root, 'src');
  await mkdir(legacy);
  await mkdir(source);
  await writeFile(join(legacy, 'en.json'), JSON.stringify({ Checkout: { title: 'Checkout', items: '{count, plural, one {# item} other {# items}}' } }));
  await writeFile(join(legacy, 'fr.json'), JSON.stringify({ Checkout: { title: 'Paiement', items: '{count, plural, one {# article} other {# articles}}' } }));
  await writeFile(join(source, 'page.tsx'), `const t = useTranslations('Checkout');\nexport const Page = () => t('title');\n`);
  await writeFile(join(source, 'entry.tsx'), `import { createRoot } from 'react-dom/client';\nconst locale = 'en';\ncreateRoot(document.getElementById('root')).render(<Page />);\n`);
  return { root, legacy, source };
}

test('project migration previews every locale and source rewrite without writes', async t => {
  const { root } = await fixture(t);
  const result = await migrateProject({ root, from: 'legacy', format: 'next-intl', sourceDir: 'src' });
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.catalogs.map(item => item.locale), ['en', 'fr']);
  assert.deepEqual(result.catalogs.map(item => item.messageCount), [2, 2]);
  assert.equal(result.codemod.replacements, 1);
  assert.match(await readFile(join(root, 'src/page.tsx'), 'utf8'), /t\('title'\)/);
  await assert.rejects(access(join(root, 'messages-nordbeam/en.json')), { code: 'ENOENT' });
  await assert.rejects(access(join(root, 'nordbeam-i18n.config.json')), { code: 'ENOENT' });
});

test('project migration reports a lazy compatibility boundary only for unresolved calls', async t => {
  const { root, source } = await fixture(t);
  await writeFile(join(source, 'dynamic.ts'), `const t = useTranslations('Checkout');\nexport const Page = (key: string) => t(key);\n`);
  const result = await migrateProject({ root, from: 'legacy', format: 'next-intl', sourceDir: 'src' });
  assert.equal(result.codemod.compatibility.fallbackRequired, true);
  assert.equal(result.codemod.compatibility.fallbackStrategy, 'lazy-legacy-boundary');
  assert.ok(result.codemod.compatibility.fallbackCalls.some(item => item.reason === 'message key is dynamic'));
  assert.deepEqual(result.codemod.compatibility.fallbackFiles, [join(root, 'src/dynamic.ts')]);
  assert.ok(result.manualActions.some(action => action.includes('lazy legacy compatibility boundary')));
});

test('project migration consumes an explicit Lingui source map for static compatibility reduction', async t => {
  const { root, source } = await fixture(t);
  await writeFile(join(source, 'page.tsx'), `import { t } from '@lingui/macro';\nexport const Page = () => t\`Checkout\`;\n`);
  await writeFile(join(root, 'lingui-source-map.json'), JSON.stringify({ Checkout: 'Checkout.title' }));
  const result = await migrateProject({ root, from: 'legacy', format: 'lingui', sourceDir: 'src', messageIdBySourceFile: 'lingui-source-map.json' });
  assert.equal(result.codemod.replacements, 1);
  assert.equal(result.codemod.compatibility.fallbackRequired, false);
  assert.match(await readFile(join(source, 'page.tsx'), 'utf8'), /t`Checkout`/);
});

test('project migration fails closed on ambiguous source-to-ID maps', async t => {
  const { root, source } = await fixture(t);
  await writeFile(join(source, 'page.tsx'), `import { t } from '@lingui/macro';\nexport const Page = () => t\`Checkout\`;\n`);
  await writeFile(join(root, 'lingui-source-map.json'), JSON.stringify({ Checkout: ['Checkout.title', 'Checkout.other'] }));
  await assert.rejects(
    migrateProject({ root, from: 'legacy', format: 'lingui', sourceDir: 'src', messageIdBySourceFile: 'lingui-source-map.json' }),
    /ambiguous.*Checkout.*Checkout\.title.*Checkout\.other/i,
  );
});

test('project migration writes catalogs, generated output, framework scaffold, bindings, provider, config, and source together', async t => {
  const { root } = await fixture(t);
  await writeFile(join(root, 'src/page.tsx'), `import { useTranslation } from 'react-i18next';\nexport function Page() { const { t } = useTranslation('Checkout'); return t('title'); }\n`);
  const result = await migrateProject({ root, from: 'legacy', format: 'react-i18next', catalogFormat: 'next-intl', sourceDir: 'src', outDir: 'generated', framework: 'vite-react', initialLocaleExpression: 'locale', write: true });
  assert.equal(result.dryRun, false);
  assert.equal(JSON.parse(await readFile(join(root, 'messages-nordbeam/fr.json'), 'utf8')).Checkout.title, 'Paiement');
  assert.match(await readFile(join(root, 'src/page.tsx'), 'utf8'), /const m = i18n\.useMessages\(\)/);
  assert.match(await readFile(join(root, 'src/page.tsx'), 'utf8'), /m\.Checkout\.title\(\)/);
  assert.match(await readFile(join(root, 'src/entry.tsx'), 'utf8'), /<i18n\.Provider initialLocale=\{locale\}>/);
  assert.equal(JSON.parse(await readFile(join(root, 'nordbeam-locale.config.json'), 'utf8')).catalogs, 'messages-nordbeam');
  assert.match(await readFile(join(root, 'generated/index.js'), 'utf8'), /loadLocale/);
  assert.match(await readFile(join(root, 'generated/client.ts'), 'utf8'), /createClientI18n/);
  assert.match(await readFile(join(root, 'vite.config.ts'), 'utf8'), /nordbeamLocale/);
  assert.ok(result.generatedFiles.length > 0);
  assert.ok(result.scaffoldFiles.some(file => file.endsWith('client.ts')));
  assert.equal(result.integration.kind, 'react');
  assert.equal(result.integration.skipped.length, 0);
});

test('project migration can scaffold the Next App Router adapter', async t => {
  const { root } = await fixture(t);
  const result = await migrateProject({ root, from: 'legacy', format: 'next-intl', sourceDir: 'src', outDir: 'generated', framework: 'next', write: true });
  assert.equal(result.framework, 'next');
  assert.match(await readFile(join(root, 'next.config.mjs'), 'utf8'), /withNordbeamLocale/);
  assert.match(await readFile(join(root, 'generated/next.ts'), 'utf8'), /createNextI18n/);
  assert.match(await readFile(join(root, 'generated/client.ts'), 'utf8'), /createClientI18n/);
  assert.match(await readFile(join(root, 'generated/provider.ts'), 'utf8'), /NordbeamLocaleProvider/);
});

test('project migration rewrites a conventional Next server route end to end', async t => {
  const { root } = await fixture(t), route = join(root, 'app/[locale]');
  await mkdir(route, { recursive: true });
  await writeFile(join(route, 'page.tsx'), `import { getTranslations } from 'next-intl/server';\nexport default async function Page({ params }) { const t = await getTranslations('Checkout'); return <h1>{t('title')}</h1>; }\n`);
  const result = await migrateProject({ root, from: 'legacy', format: 'next-intl', sourceDir: 'app', outDir: 'generated', framework: 'next', write: true });
  const source = await readFile(join(route, 'page.tsx'), 'utf8');
  assert.match(source, /const \{ locale \} = await params/);
  assert.match(source, /const \{ messages: m \} = await i18n\.loadLocale\(locale\)/);
  assert.match(source, /m\.Checkout\.title\(\)/);
  assert.doesNotMatch(source, /getTranslations/);
  assert.equal(result.integration.kind, 'next');
  assert.equal(result.integration.skipped.length, 0);
});

test('project migration binds Next Client Components through the generated locale provider', async t => {
  const { root } = await fixture(t), route = join(root, 'app/[locale]');
  await mkdir(route, { recursive: true });
  await writeFile(join(route, 'layout.tsx'), `export default async function Layout({ children, params }) { return <html><body>{children}</body></html>; }\n`);
  await writeFile(join(route, 'widget.tsx'), `'use client';\nimport { useTranslations } from 'next-intl';\nexport function Widget() { const t = useTranslations('Checkout'); return <p>{t('title')}</p>; }\n`);
  const result = await migrateProject({ root, from: 'legacy', format: 'next-intl', sourceDir: 'app', outDir: 'generated', framework: 'next', write: true });
  assert.match(await readFile(join(route, 'widget.tsx'), 'utf8'), /i18n\.useI18n\(\)/);
  assert.match(await readFile(join(route, 'layout.tsx'), 'utf8'), /<NordbeamLocaleProvider locale=\{locale\}>/);
  assert.equal(result.integration.kind, 'next');
  assert.equal(result.integration.skipped.length, 0);
});

test('project migration validates locale contracts and target ownership before writes', async t => {
  const { root } = await fixture(t);
  await writeFile(join(root, 'legacy/fr.json'), JSON.stringify({ Checkout: { title: 'Paiement {name}', items: '{count, plural, one {# article} other {# articles}}' } }));
  await assert.rejects(migrateProject({ root, from: 'legacy', format: 'next-intl', write: true }), /argument|contract|name/i);
  await assert.rejects(access(join(root, 'messages-nordbeam/en.json')), { code: 'ENOENT' });
  await mkdir(join(root, 'messages-nordbeam'));
  await writeFile(join(root, 'messages-nordbeam/en.json'), '{}\n');
  await assert.rejects(migrateProject({ root, from: 'legacy', format: 'next-intl' }), /overwrite|Cannot migrate/);
});

test('project migration refuses options that would leave an existing config stale', async t => {
  const { root } = await fixture(t);
  await writeFile(join(root, 'nordbeam-i18n.config.json'), JSON.stringify({ catalogs: 'messages', outDir: 'generated', baseLocale: 'en' }));
  await assert.rejects(migrateProject({ root, from: 'legacy', format: 'next-intl', catalogs: 'messages-nordbeam', outDir: 'generated' }), /does not match/);
  await assert.rejects(access(join(root, 'messages-nordbeam/en.json')), { code: 'ENOENT' });
});

test('CLI exposes a versioned, preview-first complete migration report', async t => {
  const { root } = await fixture(t);
  const result = spawnSync(process.execPath, [resolve('dist/cli.js'), 'migrate-project', '--from', 'legacy', '--format', 'next-intl', '--source-dir', 'src', '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.version, 1);
  assert.equal(report.ok, true);
  assert.equal(report.dryRun, true);
  assert.equal(report.catalogs.length, 2);
  assert.equal(report.codemod.replacements, 1);
  await assert.rejects(access(join(root, 'messages-nordbeam/en.json')), { code: 'ENOENT' });
});

test('post-migration residue audit scans source and explicitly supplied monorepo siblings without editing', async t => {
  const { root, source } = await fixture(t);
  const sibling = join(root, 'packages', 'shared');
  await mkdir(sibling, { recursive: true });
  await writeFile(join(source, 'legacy.ts'), `// import { t } from 'react-i18next';
import type { TFunction } from 'react-i18next';
import { useTranslation } from 'react-i18next';
const locale = 'fr';
const messages = import(\`../locales/\${locale}.json\`);
export { useTranslation, messages, locale };
`);
  await writeFile(join(sibling, 'constants.ts'), `import('@tolgee/react');\n`);
  const result = await auditProjectResidues({ root, format: 'react-i18next', paths: ['src', 'packages/shared'] });
  assert.equal(result.status, 'manual-review');
  assert.equal(result.filesScanned, 4);
  assert.equal(result.findings.length, 2);
  assert.deepEqual(result.findings.map(item => item.kind), ['incumbent-runtime-import', 'raw-catalog-dynamic-import']);
  assert.equal(result.findings[0].line, 3);
  assert.match(result.findings[0].reason, /remove|replace|provider/i);
  assert.match(result.findings[1].reason, /duplicate.*chunk|loadLocale/i);
  assert.equal(await readFile(join(source, 'legacy.ts'), 'utf8').then(text => text.includes('react-i18next')), true);
  const again = await auditProjectResidues({ root, format: 'react-i18next', paths: ['src', 'packages/shared'] });
  assert.deepEqual(again, result);
});

test('residue audit recognizes public format aliases and runtime require imports', async t => {
  const { root, source } = await fixture(t);
  await writeFile(join(source, 'tolgee.ts'), `const tolgee = require('@tolgee/react');\n`);
  const result = await auditProjectResidues({ root, format: 'tolgee-react', paths: ['src'] });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].specifier, '@tolgee/react');
  assert.equal(result.findings[0].kind, 'incumbent-runtime-import');
});

test('default residue audit covers root Next boundaries and package dependencies', async t => {
  const { root } = await fixture(t);
  await mkdir(join(root, 'app'), { recursive: true });
  await writeFile(join(root, 'app', 'page.tsx'), `import { useTranslations } from 'next-intl'; export default function Page(){ const t=useTranslations(); return t('title'); }\n`);
  await writeFile(join(root, 'proxy.ts'), `import createMiddleware from 'next-intl/middleware'; export default createMiddleware(routing);\n`);
  await writeFile(join(root, 'next.config.mjs'), `import createNextIntlPlugin from 'next-intl/plugin'; export default createNextIntlPlugin()({});\n`);
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { 'next-intl': '^4.0.0' } }));
  const result = await auditProjectResidues({ root, format: 'next-intl', paths: ['src'] });
  assert.ok(result.files.some(file => file.endsWith('/app/page.tsx')));
  assert.ok(result.files.some(file => file.endsWith('/proxy.ts')));
  assert.ok(result.files.some(file => file.endsWith('/package.json')));
  assert.ok(result.files.some(file => file.endsWith('/next.config.mjs')));
  assert.ok(result.findings.filter(item => item.specifier === 'next-intl' || item.specifier.startsWith('next-intl/')).length >= 3);
});

test('migration validates sibling audit paths before writing outputs', async t => {
  const { root } = await fixture(t);
  await assert.rejects(
    migrateProject({ root, from: 'legacy', format: 'next-intl', sourceDir: 'src', auditPaths: ['packages/missing'], write: true }),
    { code: 'ENOENT' },
  );
  await assert.rejects(access(join(root, 'messages-nordbeam/en.json')), { code: 'ENOENT' });
});

test('project migration rolls back catalog writes when initialization fails', async t => {
  const root = await temporary(t), legacy = join(root, 'legacy'), source = join(root, 'src'), output = join(root, 'src', 'i18n');
  await mkdir(legacy); await mkdir(source); await mkdir(output);
  await writeFile(join(legacy, 'en.json'), JSON.stringify({ title: 'Title' }));
  const original = `const t = useTranslations();
export const Page = () => t('title');
`;
  await writeFile(join(source, 'page.tsx'), original);
  // An unowned generated destination makes initialize fail after the
  // catalog phase has already staged its output.
  await writeFile(join(output, 'index.js'), 'user-owned\n');
  await assert.rejects(migrateProject({ root, from: 'legacy', format: 'next-intl', sourceDir: 'src', write: true }), /Refusing to overwrite unowned output/);
  assert.equal(await readFile(join(source, 'page.tsx'), 'utf8'), original);
  assert.equal(await readFile(join(output, 'index.js'), 'utf8'), 'user-owned\n');
  await assert.rejects(access(join(root, 'messages-nordbeam', 'en.json')), { code: 'ENOENT' });
});

test('CLI migration strictness does not change the catalog fallback policy', async t => {
  const root = await temporary(t), legacy = join(root, 'legacy'), source = join(root, 'src');
  await mkdir(legacy); await mkdir(source);
  await writeFile(join(legacy, 'en.json'), JSON.stringify({ title: 'Title', optional: 'Fallback' }));
  await writeFile(join(legacy, 'fr.json'), JSON.stringify({ title: 'Titre' }));
  await writeFile(join(source, 'page.ts'), `const t=useTranslations(); export const title=t('title');\n`);
  const result = spawnSync(process.execPath, [resolve('dist/cli.js'), 'migrate-project', '--from', 'legacy', '--format', 'next-intl', '--strict', '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.dryRun, true);
  assert.equal(report.codemod.skipped.length, 0);
});

test('next-intl project migration rewrites the existing request, routing and config files instead of adding a second proxy', async t => {
  const root = await temporary(t), at = path => join(root, path);
  await mkdir(at('messages'), { recursive: true });
  await mkdir(at('src/app/[locale]'), { recursive: true });
  await mkdir(at('src/i18n'), { recursive: true });
  await writeFile(at('package.json'), JSON.stringify({ name: 'app', dependencies: { next: '^16.0.0', 'next-intl': '^4.0.0' } }));
  await writeFile(at('messages/en.json'), JSON.stringify({ Home: { title: 'Hi' } }));
  await writeFile(at('src/middleware.ts'), `import createMiddleware from 'next-intl/middleware';\nimport { routing } from './i18n/routing';\nexport default createMiddleware(routing);\n`);
  await writeFile(at('src/i18n/routing.ts'), `import { defineRouting } from 'next-intl/routing';\nexport const routing = defineRouting({ locales: ['en'], defaultLocale: 'en' });\n`);
  await writeFile(at('next.config.ts'), `import createNextIntlPlugin from 'next-intl/plugin';\nexport default createNextIntlPlugin('./src/i18n/request.ts')({});\n`);
  await writeFile(at('src/app/[locale]/page.tsx'), `export default function Page() { return null; }\n`);
  const result = await migrateProject({ root, from: 'messages', format: 'next-intl', framework: 'next', write: true });
  assert.ok(result.manualActions.some(action => /^Rename src\/middleware\.ts to proxy\.ts/.test(action)));
  assert.match(await readFile(at('src/middleware.ts'), 'utf8'), /createNextMiddleware\(routing\)/);
  assert.match(await readFile(at('src/i18n/routing.ts'), 'utf8'), /@nordbeam\/locale\/next\/routing/);
  assert.match(await readFile(at('next.config.ts'), 'utf8'), /withNordbeamLocale\(\{\}\)/);
  assert.equal(result.scaffoldFiles.some(file => /proxy|middleware/.test(file)), false);
  await assert.rejects(access(at('proxy.ts')), { code: 'ENOENT' });
  await assert.rejects(access(at('src/proxy.ts')), { code: 'ENOENT' });
});
