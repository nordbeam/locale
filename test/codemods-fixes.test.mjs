import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { codemodProject, codemodSource } from '@nordbeam/locale-migrate/codemods';
import { temporary } from './helpers.mjs';

const cli = join(process.cwd(), 'dist/cli.js');
const config = JSON.stringify({ baseLocale: 'en', catalogs: 'messages', outDir: 'src/i18n' });

test('unbound messages object is refused per file, with the same decision in preview and write', async t => {
  const root = await temporary(t), directory = join(root, 'src'), file = join(directory, 'Page.tsx');
  await mkdir(directory);
  const source = `import { useTranslations } from 'next-intl';\nexport default function Page() { const t = useTranslations('nav'); return <a>{t('home')}</a>; }\n`;
  await writeFile(file, source);
  const preview = await codemodProject({ root, format: 'next-intl', requireMessagesBinding: true });
  assert.equal(preview.replacements, 0);
  assert.deepEqual(preview.changed, []);
  const skip = preview.skipped.find(item => item.code === 'MISSING_MESSAGES_BINDING');
  assert.ok(skip, JSON.stringify(preview.skipped));
  assert.equal(skip.file, file);
  assert.match(skip.action, /--messages-import <specifier>/);
  assert.match(skip.action, /loadLocale\(locale\)/);
  assert.match(skip.action, /i18n\.useMessages\(\)/);
  assert.equal(preview.compatibility.fallbackRequired, true);
  const applied = await codemodProject({ root, format: 'next-intl', requireMessagesBinding: true, write: true });
  assert.equal(applied.replacements, 0);
  assert.equal(await readFile(file, 'utf8'), source);
  assert.ok(applied.skipped.some(item => item.code === 'MISSING_MESSAGES_BINDING'));
});

test('messages import keeps the rewrite and the binding requirement is opt-in', async t => {
  const root = await temporary(t), directory = join(root, 'src'), file = join(directory, 'page.ts');
  await mkdir(directory);
  await writeFile(file, `const t = useTranslations();\nt('hello');\n`);
  const bound = await codemodProject({ root, format: 'next-intl', requireMessagesBinding: true, messagesImport: './i18n.js', write: true });
  assert.equal(bound.replacements, 1);
  assert.match(await readFile(file, 'utf8'), /import \{ m \} from '\.\/i18n\.js';\n.*m\.hello\(\)/s);
  const legacy = join(directory, 'legacy.ts');
  await writeFile(legacy, `const t = useTranslations();\nt('hello');\n`);
  const unopted = await codemodProject({ root, format: 'next-intl', write: true });
  assert.equal(unopted.replacements, 1);
  assert.equal(unopted.skipped.some(item => item.code === 'MISSING_MESSAGES_BINDING'), false);
  assert.match(await readFile(legacy, 'utf8'), /m\.hello\(\)/);
});

test('CLI codemod --write --json warns about unbound m rewrites, and --strict refuses them', async t => {
  const root = await temporary(t), directory = join(root, 'src');
  await mkdir(join(root, 'messages'), { recursive: true });
  await writeFile(join(root, 'nordbeam-locale.config.json'), config);
  await writeFile(join(root, 'messages/en.json'), JSON.stringify({ nav: { home: 'Home' } }));
  await mkdir(directory);
  const file = join(directory, 'Page.tsx');
  const source = `import { useTranslations } from 'next-intl';\nexport default function Page() { const t = useTranslations('nav'); return <a>{t('home')}</a>; }\n`;
  await writeFile(file, source);
  const strict = spawnSync(process.execPath, [cli, 'codemod', '--format', 'next-intl', '--source-dir', 'src', '--write', '--strict', '--json'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(strict.status, 0, strict.stdout);
  assert.equal(await readFile(file, 'utf8'), source);
  assert.match(strict.stdout + strict.stderr, /MISSING_MESSAGES_BINDING/);
  const run = spawnSync(process.execPath, [cli, 'codemod', '--format', 'next-intl', '--source-dir', 'src', '--write', '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.replacements, 1);
  assert.match(await readFile(file, 'utf8'), /m\.nav\.home\(\)|m\["nav\.home"\]\(\)/);
  const warning = report.warnings.find(item => item.code === 'MISSING_MESSAGES_BINDING');
  assert.ok(warning, run.stdout);
  assert.ok(warning.file.endsWith('/src/Page.tsx'), warning.file);
  assert.ok(warning.line >= 1 && warning.column >= 1);
  assert.match(warning.action, /--messages-import/);
});

test('JSX component references keep their imports alive after the call is rewritten', () => {
  const i18next = codemodSource(`import { Trans, useTranslation } from 'react-i18next';\nexport const A = () => { const { t } = useTranslation(); return <h1>{t('title')}<Trans i18nKey="greeting">Hi <b>x</b></Trans></h1>; };`, 'i18next', { filename: 'A.tsx' });
  assert.match(i18next.code, /import \{ Trans \} from 'react-i18next';/);
  assert.doesNotMatch(i18next.code, /useTranslation/);
  assert.ok(i18next.skipped.some(item => item.code === 'RICH_MESSAGE'));
  const formatjs = codemodSource(`import { FormattedMessage, useIntl } from 'react-intl';\nexport const B = () => { const intl = useIntl(); return <p><FormattedMessage id="a.b" /><FormattedMessage id="rich">{text => <b>{text}</b>}</FormattedMessage></p>; };`, 'formatjs', { filename: 'B.tsx' });
  assert.match(formatjs.code, /\{m\.a\.b\(\)\}|m\.a\.b\(\)/);
  assert.match(formatjs.code, /import \{ FormattedMessage \} from 'react-intl';/);
  const member = codemodSource(`import { Ui, useTranslation } from 'react-i18next';\nconst { t } = useTranslation(); const v = t('a'); const el = <Ui.Panel>{v}</Ui.Panel>;`, 'i18next', { filename: 'C.tsx' });
  assert.match(member.code, /import \{ Ui \} from 'react-i18next';/);
});

test('Vue global $t and attribute translations are never rewritten into invalid bindings', () => {
  const template = `<template><p>{{ $t('greeting', {name:'x'}) }}</p><i :title="t('title')"></i><i18n-t keypath="x"></i18n-t></template>\n<script setup>\nimport { useI18n } from 'vue-i18n';\nconst { t } = useI18n();\n</script>`;
  const withoutBinding = codemodSource(template, 'vue-i18n', { filename: 'Page.vue' });
  assert.equal(withoutBinding.code.split('\n')[0], template.split('\n')[0]);
  assert.doesNotMatch(withoutBinding.code, /\$m\./);
  const codes = withoutBinding.skipped.map(item => item.code).sort();
  assert.deepEqual(codes, ['VUE_ATTRIBUTE_TRANSLATION', 'VUE_GLOBAL_TRANSLATOR', 'VUE_I18N_COMPONENT']);
  assert.ok(withoutBinding.skipped.every(item => item.action && item.line >= 1 && item.column > 0));
  const customT = codemodSource(template, 'vue-i18n', { filename: 'Page.vue', customCalls: [{ callee: 't' }] });
  assert.doesNotMatch(customT.code, /\$m\./);
  assert.match(customT.code, /\$t\('greeting'/);
  const custom$t = codemodSource(template, 'vue-i18n', { filename: 'Page.vue', customCalls: [{ callee: '$t' }] });
  assert.match(custom$t.code, /\{\{ m\.greeting\(\{name:'x'\}\) \}\}/);
  assert.ok(!custom$t.skipped.some(item => item.code === 'VUE_GLOBAL_TRANSLATOR'));
});

test('TypeScript explicit type arguments on translation calls are rewritten without changing the key', () => {
  const result = codemodSource(`const t = useTranslations('nav');\nt<string>('title');\nconst ok = a < b > (c);`, 'next-intl');
  assert.match(result.code, /m\.nav\.title\(\);/);
  assert.match(result.code, /const ok = a < b > \(c\);/);
});

test('i18next namespace separators select the namespace instead of emitting a colon ID', () => {
  const hook = codemodSource(`const {t} = useTranslation('shop');\nt('common:title');\nt('plain');`, 'i18next');
  assert.match(hook.code, /m\.common\.title\(\);/);
  assert.match(hook.code, /m\.shop\.plain\(\);/);
  assert.doesNotMatch(hook.code, /m\["[^"]*:/);
  const component = codemodSource(`import { Trans } from 'react-i18next';\nimport { useTranslation } from 'react-i18next';\nconst {t} = useTranslation('shop');\n<Trans i18nKey="common:title" />;`, 'i18next');
  assert.match(component.code, /\{m\.common\.title\(\)\}/);
  const unsupported = codemodSource(`const {t} = useTranslation('shop');\nt('a:b:c');`, 'i18next');
  assert.equal(unsupported.replacements, 0);
  assert.equal(unsupported.skipped[0].code, 'UNSUPPORTED_NAMESPACE_SYNTAX');
  assert.doesNotMatch(unsupported.code.replace(/t\('a:b:c'\)/, ''), /m\[/);
});

test('rewrites to message IDs absent from the known set are skipped with UNKNOWN_MESSAGE_ID', () => {
  const result = codemodSource(`const t = useTranslations('nav');\nt('home');\nt('missing');`, 'next-intl', { messageIds: ['nav.home'] });
  assert.match(result.code, /m\.nav\.home\(\);/);
  assert.match(result.code, /t\('missing'\);/);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].code, 'UNKNOWN_MESSAGE_ID');
  assert.match(result.skipped[0].action, /base catalog/);
});

test('skip diagnostics carry 1-based line and column alongside the offset', () => {
  const result = codemodSource(`const t = useTranslations();\nt('ok');\n  t(key);\n`, 'next-intl');
  const skip = result.skipped.find(item => item.code === 'DYNAMIC_MESSAGE_KEY');
  assert.ok(skip, JSON.stringify(result.skipped));
  assert.equal(skip.line, 3);
  assert.equal(skip.column, 3);
  assert.equal(`const t = useTranslations();\nt('ok');\n  t(key);\n`.slice(skip.offset, skip.offset + 1), 't');
});

// Root bypasses file permissions, so the read-only file stays writable when tests run as root (for example in a container).
test('codemod --write preserves executable mode and skips read-only files with a stable code', { skip: process.getuid?.() === 0 && 'running as root' }, async t => {
  const root = await temporary(t), directory = join(root, 'src');
  await mkdir(directory);
  const executable = join(directory, 'run.ts'), readonly = join(directory, 'locked.ts');
  await writeFile(executable, `const t = useTranslations();\nt('hello');\n`);
  await chmod(executable, 0o755);
  await writeFile(readonly, `const t = useTranslations();\nt('locked');\n`);
  await chmod(readonly, 0o444);
  const result = await codemodProject({ root, format: 'next-intl', requireMessagesBinding: true, messagesImport: './i18n.js', write: true });
  assert.equal((await stat(executable)).mode & 0o777, 0o755);
  assert.match(await readFile(executable, 'utf8'), /m\.hello\(\)/);
  assert.equal(await readFile(readonly, 'utf8'), `const t = useTranslations();\nt('locked');\n`);
  assert.equal((await stat(readonly)).mode & 0o777, 0o444);
  assert.ok(result.skipped.some(item => item.code === 'READ_ONLY_FILE' && item.file === readonly));
  await chmod(readonly, 0o644);
});

test('generated output and the configured outDir are not scanned as application source', async t => {
  const root = await temporary(t), directory = join(root, 'src'), generated = join(directory, 'i18n');
  await mkdir(generated, { recursive: true });
  await writeFile(join(root, 'nordbeam-locale.config.json'), config);
  await writeFile(join(directory, 'page.ts'), `const t = useTranslations();\nt('hello');\n`);
  await writeFile(join(generated, 'index.d.ts'), `export declare const m: { hello(): string };\nconst t = useTranslations(); t('hello');\n`);
  await writeFile(join(directory, 'emitted.ts'), `// Generated by Nordbeam Locale. Do not edit.\nconst t = useTranslations(); t('hello');\n`);
  const preview = await codemodProject({ root, format: 'next-intl', messagesImport: './i18n.js' });
  assert.equal(preview.filesScanned, 1);
  assert.deepEqual(preview.changed.map(item => item.file), [join(directory, 'page.ts')]);
  assert.equal(preview.skipped.some(item => item.file?.includes('/i18n/')), false);
});

test('binding check accepts every declaration form that makes m visible and refuses sibling-scope uses', async t => {
  const root = await temporary(t), directory = join(root, 'src');
  await mkdir(directory);
  const bound = [
    `import { m } from './i18n.js';\nconst t = useTranslations();\nexport const f = () => t('a');\n`,
    `const { messages: m } = await loadLocale(locale);\nconst t = useTranslations();\nexport const f = () => t('a');\n`,
    `const t = useTranslations();\nexport const f = (m) => t('a');\n`,
  ];
  for (const [index, source] of bound.entries()) {
    const file = join(directory, `bound-${index}.ts`);
    await writeFile(file, source);
  }
  const unbound = `const t = useTranslations();\nfunction helper(m: string) { return m; }\nexport const f = () => t('a');\n`;
  await writeFile(join(directory, 'unbound.ts'), unbound);
  const result = await codemodProject({ root, format: 'next-intl', requireMessagesBinding: true, write: true });
  const rewritten = result.changed.map(item => item.file.split('/').pop()).sort();
  assert.deepEqual(rewritten, ['bound-0.ts', 'bound-1.ts', 'bound-2.ts']);
  assert.ok(result.skipped.some(item => item.code === 'MISSING_MESSAGES_BINDING' && item.file.endsWith('unbound.ts')));
});
