import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { CodemodStrictError, codemodProject, codemodSource } from '@nordbeam/locale-migrate/codemods';
import { temporary } from './helpers.mjs';

test('next-intl and i18next codemods preserve namespaces, values, and dynamic calls', () => {
  const next = codemodSource(`const t = useTranslations('Checkout');\nt('title'); t('total', {count}); t(key);`, 'next-intl');
  assert.equal(next.code, `const t = useTranslations('Checkout');\nm.Checkout.title(); m.Checkout.total({count}); t(key);`);
  assert.equal(next.replacements, 2); assert.equal(next.skipped[0].reason, 'message key is dynamic');
  assert.equal(next.compatibility.directRewrites, 2);
  assert.equal(next.compatibility.fallbackStrategy, 'lazy-legacy-boundary');
  assert.equal(next.compatibility.fallbackCalls.length, 1);
  assert.equal(next.skipped[0].code, 'DYNAMIC_MESSAGE_KEY');
  assert.match(next.skipped[0].action, /literal key|typed message map/);
  assert.deepEqual(next.compatibility.fallbackFiles, []);
  assert.deepEqual(next.compatibility.files, []);
  const i18next = codemodSource(`const {t: translate} = useTranslation('shop');\ntranslate('price', {amount});`, 'i18next');
  assert.match(i18next.code, /m\.shop\.price\(\{amount\}\)/);
  assert.equal(i18next.compatibility.fallbackRequired, false);
});

test('FormatJS and Lingui codemods rewrite only proven static calls', () => {
  const formatjs = codemodSource(`const intl = useIntl();\nintl.formatMessage({ id: 'product.price', defaultMessage: 'Price' }, values);`, 'formatjs');
  assert.match(formatjs.code, /m\.product\.price\(values\)/);
  const lingui = codemodSource(`const {i18n: locale} = useLingui();\nlocale._('save', {name});`, 'lingui');
  assert.match(lingui.code, /m\.save\(\{name\}\)/);
});

test('codemods handle server helpers, JSX components, aliases, and bracket escape keys', () => {
  const server = codemodSource(`const t = await getTranslations({locale, namespace: 'Account'});\nt('user-name');`, 'next-intl');
  assert.match(server.code, /m\["Account\.user-name"\]\(\)/);
  const reactIntl = codemodSource(`import {FormattedMessage} from 'react-intl';\nconst intl = useIntl();\n<section><FormattedMessage id="checkout.title" values={{count: 2}} /></section>`, 'formatjs');
  assert.match(reactIntl.code, /\{m\.checkout\.title\(\{count: 2\}\)\}/);
  const lingui = codemodSource(`const {i18n, _: translate} = useLingui();\n<Trans id="save" values={values} />; translate('cancel');`, 'lingui');
  assert.match(lingui.code, /\{m\.save\(values\)\}/); assert.match(lingui.code, /m\.cancel\(\)/);
  const i18next = codemodSource(`const {ready, t: translate} = useTranslation('shop', {keyPrefix: 'cart'});\ntranslate('total'); <Trans i18nKey="items" count={count} values={values} />`, 'i18next');
  assert.match(i18next.code, /m\.shop\.cart\.total\(\)/);
  assert.match(i18next.code, /\{m\.items\(\{\.\.\.\(values\),count:count\}\)\}/);
  const rich = codemodSource(`const t = useTranslations('Article'); t.rich('body', {strong});`, 'next-intl');
  assert.equal(rich.replacements, 0);
  assert.ok(rich.skipped.some(item => item.callee === 't.rich' && /not supported/.test(item.reason)));
  const perCall = codemodSource(`const {t} = useTranslation(); t('title', {ns: 'account'}); t('legacy', 'Default'); <Trans ns="shop" i18nKey="empty" />`, 'i18next');
  assert.match(perCall.code, /m\.account\.title\(\)/);
  assert.match(perCall.code, /\{m\.shop\.empty\(\)\}/);
  assert.match(perCall.code, /t\('legacy', 'Default'\)/);
  assert.ok(perCall.skipped.some(item => item.reason.includes('default value')));
});

test('auto mode covers Vue I18n, Tolgee, next-international, and typesafe-i18n', () => {
  const source = `
const {t: vueT} = useI18n(); vueT('vue.title');
const {t: tolgeeT} = useTranslate(); tolgeeT('tolgee.title', values);
const nextT = useI18n(); nextT('next.title');
const {LL: strings} = useI18nContext(); strings.product.price({amount: 2});`;
  const result = codemodSource(source, 'auto');
  assert.match(result.code, /m\.vue\.title\(\)/);
  assert.match(result.code, /m\.tolgee\.title\(values\)/);
  assert.match(result.code, /m\.next\.title\(\)/);
  assert.match(result.code, /m\.product\.price\(\{amount: 2\}\)/);
});

test('package-specific source format aliases select their underlying codemod', () => {
  assert.match(codemodSource(`const {t}=useTranslation(); t('hello');`, 'react-i18next').code, /m\.hello\(\)/);
  assert.match(codemodSource(`const intl=useIntl(); intl.formatMessage({id:'hello'});`, 'react-intl').code, /m\.hello\(\)/);
  assert.match(codemodSource(`const {t}=useI18n(); t('hello');`, 'nuxt-i18n').code, /m\.hello\(\)/);
});

test('codemods cover Svelte stores and Angular service injection', () => {
  const svelte = codemodSource(`import {_, t} from 'svelte-i18n';\n$_('nav.home'); $t('nav.about', values);`, 'svelte-i18n');
  assert.match(svelte.code, /m\.nav\.home\(\)/); assert.match(svelte.code, /m\.nav\.about\(values\)/);
  const transloco = codemodSource(`const locale = inject(TranslocoService); locale.translate('account.title', values);`, 'transloco');
  assert.match(transloco.code, /m\.account\.title\(values\)/);
  const ngx = codemodSource(`const locale = inject(TranslateService); locale.instant('account.save');`, 'ngx-translate');
  assert.match(ngx.code, /m\.account\.save\(\)/);
});

test('commented bindings and unrelated translation-like calls are untouched', () => {
  const source = `// const t = useTranslations();\nconst prose = "const t = useTranslations()";\nt('not-proven');`;
  const result = codemodSource(source, 'auto');
  assert.equal(result.code, source); assert.equal(result.replacements, 0);
});

test('nested translation calls migrate innermost-first without corrupting source offsets', () => {
  const source = `const { t } = useTranslation();
const value = t('entity.failed', { entity: t('issue.label', { count: 1 }) });`;
  const first = codemodSource(source, 'i18next');
  assert.equal(first.replacements, 1);
  assert.match(first.code, /t\('entity\.failed', \{ entity: m\.issue\.label\(\{count: 1\}\) \}\)/);
  assert.ok(first.skipped.some(item => item.reason.includes('inner call first')));
  const second = codemodSource(first.code, 'i18next');
  assert.equal(second.replacements, 1);
  assert.match(second.code, /m\.entity\.failed\(\{entity: m\.issue\.label\(\{count: 1\}\)\}\)/);
  assert.equal(codemodSource(second.code, 'i18next').replacements, 0);
});

test('finite conditional message keys lower to typed branches and unknown leaves fail closed', () => {
  const source = `const t = useTranslations(); t(flag ? 'retry' : nested ? 'download' : \`cancel\`, {name});`;
  const result = codemodSource(source, 'next-intl', { messageIds: ['retry', 'download', 'cancel'] });
  assert.equal(result.replacements, 1);
  assert.match(result.code, /\(flag \? m\.retry\(\{name\}\) : \(nested \? m\.download\(\{name\}\) : m\.cancel\(\{name\}\)\)\)/);
  assert.equal(result.skipped.length, 0);

  const unknown = codemodSource(`const t = useTranslations(); t(flag ? 'known' : dynamicKey);`, 'next-intl', { messageIds: ['known'] });
  assert.equal(unknown.replacements, 0);
  assert.match(unknown.code, /t\(flag \? 'known' : dynamicKey\)/);
  assert.ok(unknown.skipped.some(item => item.reason === 'message key is dynamic'));

  const svelte = codemodSource(`<script>import { t } from 'svelte-i18n';</script><button aria-label={$t(done ? 'retry' : 'download', { values: { count } })} />`, 'svelte-i18n', {
    filename: 'Download.svelte',
    messagesImport: './i18n.js',
  });
  assert.equal(svelte.replacements, 1);
  assert.match(svelte.code, /done \? m\.retry\(\{ count \}\) : m\.download\(\{ count \}\)/);
  assert.doesNotMatch(svelte.code, /svelte-i18n/);
});

test('project codemods converge nested translation calls in one reviewed operation', async t => {
  const root = await temporary(t), directory = join(root, 'src'), file = join(directory, 'nested.ts');
  await mkdir(directory);
  await writeFile(file, `import {useTranslation} from 'react-i18next';\nconst {t}=useTranslation();\nexport const label=t('outer', {value: t('inner')});\n`);
  const preview = await codemodProject({ root, format: 'react-i18next', messagesImport: './i18n.js' });
  assert.equal(preview.replacements, 2);
  assert.equal(preview.skipped.length, 0);
  assert.equal(preview.compatibility.fallbackRequired, false);
  const applied = await codemodProject({ root, format: 'react-i18next', messagesImport: './i18n.js', write: true });
  assert.equal(applied.replacements, 2);
  assert.equal(await readFile(file, 'utf8'), `import { m } from './i18n.js';\nexport const label=m.outer({value: m.inner()});\n`);
});

test('rich FormatJS component behavior is reported instead of flattened', () => {
  const source = `import { FormattedMessage } from 'react-intl';
const value = <FormattedMessage id="welcome" tagName="p" values={{name: <strong>{name}</strong>}} />;`;
  const result = codemodSource(source, 'formatjs');
  assert.equal(result.replacements, 0);
  assert.equal(result.code, source);
  assert.ok(result.skipped.some(item => item.reason.includes('rich-component')));
});

test('plain JSX message components preserve their surrounding expression context', () => {
  const source = `import { FormattedMessage } from 'react-intl';
const node = condition ? (<FormattedMessage id="yes" />) : (<FormattedMessage id="no" />);`;
  const result = codemodSource(source, 'formatjs');
  assert.equal(result.replacements, 2);
  assert.match(result.code, /condition \? \(m\.yes\(\)\) : \(m\.no\(\)\)/);
});

test('nested JSX inside component values cannot truncate a component rewrite', () => {
  const source = `import { FormattedMessage } from 'react-intl';
<FormattedMessage id="hint" values={{br: <br />, count: 2}} tagName="p" />;`;
  const result = codemodSource(source, 'formatjs');
  assert.equal(result.replacements, 0);
  assert.equal(result.code, source);
  assert.ok(result.skipped.some(item => item.reason.includes('nested JSX')));
});

test('project codemods preview by default and require write to change files', async t => {
  const root = await temporary(t), directory = join(root, 'src'), file = join(directory, 'page.ts');
  await mkdir(directory); await writeFile(file, `const t = useTranslations();\nt('hello');\n`);
  const preview = await codemodProject({ root, format: 'next-intl' });
  assert.equal(preview.dryRun, true); assert.equal(preview.replacements, 1);
  assert.deepEqual(preview.compatibility.files.map(item => ({ file: item.file, directRewrites: item.directRewrites, fallbackRequired: item.fallbackRequired })), [{ file, directRewrites: 1, fallbackRequired: false }]);
  assert.equal(await readFile(file, 'utf8'), `const t = useTranslations();\nt('hello');\n`);
  const applied = await codemodProject({ root, format: 'next-intl', write: true });
  assert.equal(applied.dryRun, false); assert.equal(await readFile(file, 'utf8'), `m.hello();\n`);
});

test('project compatibility reports only fallback files and never fuzzy-selects IDs', async t => {
  const root = await temporary(t), directory = join(root, 'src');
  await mkdir(directory);
  const staticFile = join(directory, 'static.ts'), dynamicFile = join(directory, 'dynamic.ts'), dynamicTwoFile = join(directory, 'dynamic-two.ts');
  await writeFile(staticFile, `const t = useTranslations(); t('known');\n`);
  await writeFile(dynamicFile, `const t = useTranslations(); export const f = (key: string) => t(key);\n`);
  await writeFile(dynamicTwoFile, `const t = useTranslations(); export const f = (key: string) => t(key);\n`);
  const result = await codemodProject({ root, format: 'next-intl' });
  assert.deepEqual(result.compatibility.fallbackFiles, [dynamicTwoFile, dynamicFile].sort());
  assert.deepEqual(result.compatibility.files.map(item => ({ file: item.file, directRewrites: item.directRewrites, fallbackRequired: item.fallbackRequired })), [
    { file: dynamicTwoFile, directRewrites: 0, fallbackRequired: true },
    { file: dynamicFile, directRewrites: 0, fallbackRequired: true },
    { file: staticFile, directRewrites: 1, fallbackRequired: false },
  ]);
  assert.equal(result.compatibility.files.find(item => item.file === dynamicFile)?.fallbackCalls.length, 1);
});

test('CLI exposes machine-readable auto previews and explicit writes', async t => {
  const root = await temporary(t), directory = join(root, 'src'), file = join(directory, 'page.ts');
  await mkdir(directory); await writeFile(file, `const t = useTranslations(); t('hello');\n`);
  const cli = join(process.cwd(), 'dist/cli.js');
  const preview = spawnSync(process.execPath, [cli, 'codemod', '--format', 'auto', '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).replacements, 1);
  assert.match(await readFile(file, 'utf8'), /t\('hello'\)/);
  const write = spawnSync(process.execPath, [cli, 'codemod', '--format', 'auto', '--write'], { cwd: root, encoding: 'utf8' });
  assert.equal(write.status, 0, write.stderr);
  assert.match(await readFile(file, 'utf8'), /m\.hello\(\)/);
});

test('CLI messages-import binds custom-call rewrites only when requested', async t => {
  const root = await temporary(t), directory = join(root, 'src'), file = join(directory, 'custom.ts');
  await mkdir(directory); await writeFile(file, `export const label = $t('hello');\n`);
  const cli = join(process.cwd(), 'dist/cli.js');
  const write = spawnSync(process.execPath, [cli, 'codemod', '--format', 'next-intl', '--custom-call', '$t', '--messages-import', './i18n.js', '--write'], { cwd: root, encoding: 'utf8' });
  assert.equal(write.status, 0, write.stderr);
  const output = await readFile(file, 'utf8');
  assert.match(output, /import \{ m \} from '\.\/i18n\.js';/);
  assert.match(output, /m\.hello\(\)/);
});

test('AST-backed calls accept static templates, classify dynamic templates, and gate generated IDs', () => {
  const result = codemodSource("const t=useTranslations(); t(`known`); t(`user.${id}`); t('missing');", 'next-intl', { messageIds: ['known'] });
  assert.match(result.code, /m\.known\(\)/);
  assert.ok(result.skipped.some(item => item.reason === 'message key is a dynamic template literal'));
  assert.ok(result.skipped.some(item => item.reason.includes('absent from generated message types')));
});

test('direct typesafe-i18n dynamic properties are explicit skips', () => {
  const source = `const {LL}=useI18nContext(); LL[key]();`;
  const result = codemodSource(source, 'typesafe-i18n');
  assert.equal(result.code, source);
  assert.equal(result.replacements, 0);
  assert.ok(result.skipped.some(item => item.reason === 'message key is dynamic'));
});

test('custom wrappers and explicit non-self-closing message components migrate', () => {
  const wrapped = codemodSource("translateForApp('checkout.pay', {amount})", 'next-intl', { customCalls: [{ callee: 'translateForApp' }] });
  assert.equal(wrapped.code, 'm.checkout.pay({amount})');
  const jsx = codemodSource("import {FormattedMessage} from 'react-intl'; const node=<FormattedMessage id=\"hello\">Hello</FormattedMessage>;", 'formatjs');
  assert.match(jsx.code, /const node=m\.hello\(\)/);
});

test('messagesImport is opt-in, merges value imports, and is idempotent', () => {
  const options = { customCalls: [{ callee: 'translateForApp' }], messagesImport: './i18n.js' };
  const merged = codemodSource("import { existing } from './i18n.js';\ntranslateForApp('hello');", 'next-intl', options);
  assert.match(merged.code, /import \{ existing, m \} from '\.\/i18n\.js';/);
  assert.match(merged.code, /m\.hello\(\)/);
  const typeOnly = codemodSource("import type { Messages } from './i18n.js';\ntranslateForApp('hello');", 'next-intl', options);
  assert.match(typeOnly.code, /import \{ m \} from '\.\/i18n\.js';/);
  assert.match(typeOnly.code, /import type \{ Messages \} from '\.\/i18n\.js';/);
  const conflictingType = codemodSource("import { type m } from './i18n.js';\ntranslateForApp('hello');", 'next-intl', options);
  assert.equal(conflictingType.replacements, 0);
  assert.ok(conflictingType.skipped.some(item => /type-only import/.test(item.reason)));
  const untouched = codemodSource('const value = 1;', 'next-intl', options);
  assert.equal(untouched.code, 'const value = 1;');
  assert.doesNotMatch(untouched.code, /messages|i18n/);
  const second = codemodSource(merged.code, 'next-intl', options);
  assert.equal(second.replacements, 0);
  assert.equal(second.code, merged.code);
});

test('messagesImport merges Svelte instance-script imports for script and markup rewrites', () => {
  const source = `<script lang="ts">\nimport { helper } from './i18n.js';\nconst label = $t('label');\n</script>\n<h1>{$t('title')}</h1>`;
  const result = codemodSource(source, 'svelte-i18n', { filename: 'Page.svelte', customCalls: [{ callee: '$t' }], messagesImport: './i18n.js' });
  assert.equal(result.replacements, 2);
  assert.match(result.code, /import \{ helper, m \} from '\.\/i18n\.js';/);
  assert.match(result.code, /const label = m\.label\(\)/);
  assert.match(result.code, /<h1>\{m\.title\(\)\}<\/h1>/);
  assert.equal(codemodSource(result.code, 'svelte-i18n', { filename: 'Page.svelte', customCalls: [{ callee: '$t' }], messagesImport: './i18n.js' }).replacements, 0);
  const moduleAndMarkup = codemodSource(`<script context="module">export const moduleTitle = $t('module');</script><h1>{$t('title')}</h1>`, 'svelte-i18n', { filename: 'ModulePage.svelte', customCalls: [{ callee: '$t' }], messagesImport: './i18n.js' });
  assert.equal(moduleAndMarkup.replacements, 2);
  assert.equal((moduleAndMarkup.code.match(/import \{ m \} from '\.\/i18n\.js';/g) ?? []).length, 2);
  assert.match(moduleAndMarkup.code, /moduleTitle = m\.module\(\)/);
  assert.match(moduleAndMarkup.code, /<h1>\{m\.title\(\)\}<\/h1>/);
});

test('explicit type-import moves preserve aliases, mixed imports, Svelte annotations, and idempotency', async t => {
  const options = { messagesImport: '$lib/i18n/nordbeam', moveTypeImports: ['MessageFormatter'] };
  const mixed = codemodSource("import { locale, type MessageFormatter as Formatter, type Other } from 'svelte-i18n';\nconst value: Formatter | Other = locale;", 'svelte-i18n', { ...options, filename: 'mixed.ts' });
  assert.equal(mixed.replacements, 0);
  assert.equal(mixed.typeImportsMoved, 1);
  assert.match(mixed.code, /import type \{ MessageFormatter as Formatter \} from '\$lib\/i18n\/nordbeam';/);
  assert.match(mixed.code, /import \{ locale, type Other \} from 'svelte-i18n';/);
  assert.equal(codemodSource(mixed.code, 'svelte-i18n', { ...options, filename: 'mixed.ts' }).typeImportsMoved, 0);

  const svelte = codemodSource(`<script lang="ts">\nimport type { MessageFormatter } from 'svelte-i18n';\nfunction render($t: MessageFormatter) { return $t('title'); }\n</script>`, 'svelte-i18n', { ...options, filename: 'Page.svelte', customCalls: [{ callee: '$t' }] });
  assert.equal(svelte.replacements, 1);
  assert.equal(svelte.typeImportsMoved, 1);
  assert.match(svelte.code, /import type \{ MessageFormatter \} from '\$lib\/i18n\/nordbeam';/);
  assert.match(svelte.code, /function render\(_t: MessageFormatter\)/);
  assert.match(svelte.code, /return m\.title\(\)/);
  const genericScript = codemodSource(`<script lang="ts" generics="T extends Record<string, unknown>">\nimport type { MessageFormatter } from 'svelte-i18n';\nconst formatter = null as MessageFormatter | null;\n</script>`, 'svelte-i18n', { ...options, filename: 'Generic.svelte' });
  assert.equal(genericScript.typeImportsMoved, 1);
  assert.equal(genericScript.skipped.length, 0);
  assert.match(genericScript.code, /generics="T extends Record<string, unknown>">/);

  assert.throws(() => codemodSource("import type { MessageFormatter } from 'svelte-i18n';", 'svelte-i18n', { moveTypeImports: ['MessageFormatter'] }), /requires messagesImport/);
  const root = await temporary(t), directory = join(root, 'src'), file = join(directory, 'types.ts');
  await mkdir(directory); await writeFile(file, "import type { MessageFormatter } from 'svelte-i18n';\nexport type Formatter = MessageFormatter;\n");
  const applied = await codemodProject({ root, format: 'svelte-i18n', messagesImport: './nordbeam.js', moveTypeImports: ['MessageFormatter'], write: true });
  assert.equal(applied.replacements, 0);
  assert.equal(applied.typeImportsMoved, 1);
  assert.equal(applied.changed[0].typeImportsMoved, 1);
  assert.match(await readFile(file, 'utf8'), /from '\.\/nordbeam\.js'/);
});

test('Lingui source macros migrate through an extracted catalog source map', () => {
  const options = { messageIds: ['hash.save', 'hash.logout'], messageIdBySource: new Map([['Save', 'hash.save'], ['Log out', 'hash.logout']]) };
  const tagged = codemodSource("import {useLingui,Trans} from '@lingui/react/macro'; const {t}=useLingui(); t`Save`; <Trans>Log out</Trans>;", 'lingui', options);
  assert.equal(tagged.replacements, 2);
  assert.match(tagged.code, /m\.hash\.save\(\)/);
  assert.match(tagged.code, /m\.hash\.logout\(\)/);
  assert.equal(tagged.compatibility.fallbackRequired, false);
  const msgTagged = codemodSource("import {msg} from '@lingui/macro'; msg\`Logout\`;", 'lingui', { messageIdBySource: { Logout: 'hash.logout' }, messageIds: ['hash.logout'] });
  assert.match(msgTagged.code, /m\.hash\.logout\(\)/);
  const unmapped = codemodSource("const {t}=useLingui(); t`Unknown`;", 'lingui');
  assert.ok(unmapped.skipped.some(item => item.reason.includes('source-to-id mapping')));
  assert.equal(unmapped.compatibility.fallbackStrategy, 'lazy-legacy-boundary');
  const outsideCatalog = codemodSource("import {t} from '@lingui/macro'; t`Save`;", 'lingui', { messageIds: ['hash.logout'], messageIdBySource: new Map([['Save', 'hash.save']]) });
  assert.equal(outsideCatalog.replacements, 0);
  assert.ok(outsideCatalog.skipped.some(item => item.reason.includes('absent from generated message types')));
});

test('Angular translation pipes migrate only known generated message IDs', () => {
  const result = codemodSource(`<h1>{{ 'account.title' | transloco }}</h1><p>{{ dynamic | transloco }}</p>`, 'transloco', { filename: 'page.component.html', messageIds: ['account.title'] });
  assert.match(result.code, /\{\{ m\.account\.title\(\) \}\}/);
  assert.match(result.code, /dynamic \| transloco/);
});

test('adversarial constructs are either rewritten exactly or diagnosed fail-closed', () => {
  const aliases = codemodSource(`import {useTranslations as useT} from 'next-intl'; const t=useT('Shop'); t('price');`, 'next-intl');
  assert.match(aliases.code, /m\.Shop\.price\(\)/);
  assert.equal(aliases.skipped.length, 0);

  const nextI18nextAlias = codemodSource(`import {useTranslation as useT} from 'next-i18next'; const {t}=useT('Shop'); t(key);`, 'next-i18next');
  assert.equal(nextI18nextAlias.replacements, 0);
  assert.ok(nextI18nextAlias.skipped.some(item => item.reason === 'message key is dynamic'));

  const scopedNamespaces = codemodSource(`import {useTranslation} from 'react-i18next'; const {t}=useTranslation('one'); const a=t('title'); function Child(){ const {t}=useTranslation('two'); return t('title'); }`, 'i18next');
  assert.equal(scopedNamespaces.replacements, 0);
  assert.ok(scopedNamespaces.skipped.every(item => /multiple namespace|scope declarations/.test(item.reason)));

  const shadowed = codemodSource(`import {useTranslation} from 'react-i18next'; const {t}=useTranslation(); function render(t){return t('shadowed')} render(t('outer')); t?.('optional');`, 'i18next');
  assert.match(shadowed.code, /function render\(t\)\{return t\('shadowed'\)\}/);
  assert.match(shadowed.code, /render\(m\.outer\(\)\)/);
  assert.match(shadowed.code, /t\?\.\('optional'\)/);
  assert.ok(shadowed.skipped.some(item => /shadowed by a function parameter/.test(item.reason)));
  assert.ok(shadowed.skipped.some(item => /optional translation call/.test(item.reason)));

  const blockShadowed = codemodSource(`const {t}=useTranslation(); { t('before'); const t=other(); t('after'); }`, 'i18next');
  assert.equal(blockShadowed.replacements, 0);
  assert.equal(blockShadowed.skipped.filter(item => /local scope binding/.test(item.reason)).length, 2);

  const dynamicNamespace = codemodSource(`const {t}=useTranslation(namespace); t('price');`, 'i18next');
  assert.equal(dynamicNamespace.replacements, 0);
  assert.ok(dynamicNamespace.skipped.some(item => /namespace.*dynamic/.test(item.reason)));

  const nestedInternationalOptions = codemodSource(`import {useI18n} from 'next-international'; const {t}=useI18n(foo(bar())); t('price');`, 'next-international');
  assert.equal(nestedInternationalOptions.replacements, 0);
  assert.ok(nestedInternationalOptions.skipped.some(item => /namespace.*dynamic/.test(item.reason)));
  const nestedTypesafeOptions = codemodSource(`import {useI18nContext} from 'typesafe-i18n'; const {LL}=useI18nContext(foo(bar())); LL.page.title();`, 'typesafe-i18n');
  assert.equal(nestedTypesafeOptions.replacements, 0);
  assert.ok(nestedTypesafeOptions.skipped.some(item => /namespace.*dynamic/.test(item.reason)));

  const wrapper = codemodSource(`const {t}=useTranslation(); const translate=(key)=>t(key); translate('price');`, 'i18next');
  assert.equal(wrapper.replacements, 0);
  assert.ok(wrapper.skipped.some(item => /wrapper delegates/.test(item.reason)));

  const componentAlias = codemodSource(`import {FormattedMessage as Msg} from 'react-intl'; const node=<Msg id="hello"/>;`, 'formatjs');
  assert.match(componentAlias.code, /m\.hello\(\)/);
  const rich = codemodSource(`import {FormattedMessage} from 'react-intl'; <FormattedMessage id="hello" values={{bold:<strong/>}}/>;`, 'formatjs');
  assert.equal(rich.replacements, 0);
  assert.ok(rich.skipped.some(item => /rich-component|nested JSX/.test(item.reason)));

  const nestedDescriptorId = codemodSource(`const intl=useIntl(); intl.formatMessage({meta:{id:'wrong'}, defaultMessage:'Hello'});`, 'formatjs');
  assert.equal(nestedDescriptorId.replacements, 0);
  assert.ok(nestedDescriptorId.skipped.some(item => item.reason === 'descriptor has no static id'));
  const nestedJsxId = codemodSource(`import {FormattedMessage} from 'react-intl'; <FormattedMessage values={{id:'wrong'}}/>;`, 'formatjs');
  assert.equal(nestedJsxId.replacements, 0);
  assert.ok(nestedJsxId.skipped.some(item => item.reason === 'component has no static id'));

  const interpolated = codemodSource('const {t}=useTranslation(); const label=`prefix ${t("hello")} suffix`;', 'i18next');
  assert.match(interpolated.code, /prefix \$\{m\.hello\(\)\} suffix/);
  const returnComponent = codemodSource(`import {FormattedMessage} from 'react-intl'; export function Label(){ return <FormattedMessage id="hello"/>; }`, 'formatjs');
  assert.match(returnComponent.code, /return m\.hello\(\)/);
  const jsxTextQuote = codemodSource(`import {useTranslation} from 'react-i18next'; const prose=<div>Don't hide calls</div>; const {t}=useTranslation(); t('hello');`, 'i18next');
  assert.match(jsxTextQuote.code, /m\.hello\(\)/);
  const unsafe = codemodSource(`const t=useTranslations(); t('constructor');`, 'next-intl');
  assert.match(unsafe.code, /m\["constructor"\]\(\)/);

  const angular = codemodSource(`<p>{{ dynamic | translate }}</p>`, 'ngx-translate', { filename: 'page.component.html' });
  assert.equal(angular.replacements, 0);
  assert.ok(angular.skipped.some(item => /pipe key is dynamic/.test(item.reason)));
  const angularOptions = codemodSource(`<p>{{ 'hello' | translate: params }}</p>`, 'ngx-translate', { filename: 'page.component.html' });
  assert.equal(angularOptions.replacements, 0);
  assert.ok(angularOptions.skipped.some(item => /pipe options/.test(item.reason)));
  const angularDirective = codemodSource(`<p [translate]="key" [translateParams]="params"></p>`, 'ngx-translate', { filename: 'page.component.html' });
  assert.equal(angularDirective.replacements, 0);
  assert.ok(angularDirective.skipped.some(item => /directive/.test(item.reason)));
});

test('codemods keep lexical ownership and reparse JSX output', () => {
  const scope = codemodSource(`import {useTranslations} from 'next-intl'; function A(){const t=useTranslations(); return t('inside')} function B(){return t('outside')}`, 'next-intl');
  assert.match(scope.code, /m\.inside\(\)/);
  assert.match(scope.code, /t\('outside'\)/);
  assert.ok(scope.skipped.some(item => /outside the lexical scope/.test(item.reason)));

  const defaultExport = codemodSource(`import {FormattedMessage as Msg} from 'react-intl'; export default <Msg id="hello"/>;`, 'formatjs');
  assert.equal(defaultExport.replacements, 1);
  assert.match(defaultExport.code, /export default m\.hello\(\)/);
  assert.doesNotMatch(defaultExport.code, /export default \{m/);

  const nullish = codemodSource(`import {FormattedMessage} from 'react-intl'; export const value = title ?? <FormattedMessage id="hello"/>;`, 'formatjs');
  assert.match(nullish.code, /title \?\? m\.hello\(\)/);

  const jsxUrl = codemodSource(`import {useTranslations} from 'next-intl'; const prose=<div>https://example.test/Don't say t('fake')</div>; const t=useTranslations(); t('real');`, 'next-intl');
  assert.match(jsxUrl.code, /m\.real\(\)/);
  assert.doesNotMatch(jsxUrl.code, /m\.fake/);

  const regex = codemodSource(`import {useTranslations} from 'next-intl'; const pattern=/t\\('fake'\\)/g; const t=useTranslations(); t('real');`, 'next-intl');
  assert.match(regex.code, /m\.real\(\)/);
  assert.doesNotMatch(regex.code, /m\.fake/);

  const customConflict = codemodSource(`import {useTranslations} from 'next-intl'; const t=useTranslations(namespace); t('title');`, 'next-intl', {
    customCalls: [{ callee: 't', namespace: 'Static' }],
  });
  assert.equal(customConflict.replacements, 0);
  assert.ok(customConflict.skipped.some(item => /dynamic|multiple namespace/.test(item.reason)));
});

test('Angular documented service and bare directive forms are diagnosed', () => {
  const service = codemodSource(`import {TranslateService} from '@ngx-translate/core'; const service=inject(TranslateService); service.get('title');`, 'ngx-translate');
  assert.equal(service.replacements, 0);
  assert.ok(service.skipped.some(item => /service member/.test(item.reason)));
  const directive = codemodSource(`<span translate>title</span>`, 'ngx-translate', { filename: 'page.component.html' });
  assert.equal(directive.replacements, 0);
  assert.ok(directive.skipped.some(item => /directive/.test(item.reason)));
});

test('codemods remove dead formatter bindings and only their import specifiers', () => {
  const aliased = codemodSource(`import { useTranslations as useT, other } from 'next-intl';\nconst t = useT();\nt('hello');`, 'next-intl');
  assert.equal(aliased.code, `import { other } from 'next-intl';\nm.hello();`);
  const middle = codemodSource(`import { before, useTranslations, after } from 'next-intl';\nconst t = useTranslations();\nt('hello');`, 'next-intl');
  assert.equal(middle.code, `import { before, after } from 'next-intl';\nm.hello();`);

  const mixed = codemodSource(`import { useTranslation as useT, other } from 'react-i18next';\nconst { t: translate, ready } = useT();\ntranslate('hello');`, 'i18next');
  assert.equal(mixed.code, `import { useTranslation as useT, other } from 'react-i18next';\nconst { ready } = useT();\nm.hello();`);

  const direct = codemodSource(`import { t as translate, other } from 'i18next';\ntranslate('hello');`, 'i18next');
  assert.equal(direct.code, `import { other } from 'i18next';\nm.hello();`);
});

test('formatter cleanup is scope-aware, preserves public/callback shape, and is idempotent', () => {
  const source = `import { useTranslations } from 'next-intl';\nconst t = useTranslations();\nfunction callback(t) { return t; }\nconst keep = 1;\nt('hello');`;
  const first = codemodSource(source, 'next-intl');
  assert.doesNotMatch(first.code, /useTranslations|const t =/);
  assert.match(first.code, /function callback\(t\) \{ return t; \}/);
  assert.match(first.code, /const keep = 1;/);
  assert.equal(codemodSource(first.code, 'next-intl').code, first.code);

  const exported = codemodSource(`import { useTranslations } from 'next-intl';\nexport const t = useTranslations();\nt('hello');`, 'next-intl');
  assert.match(exported.code, /export const t = useTranslations\(\)/);
  assert.match(exported.code, /m\.hello\(\)/);
});

test('strict cleanup rolls back unresolved calls without deleting bindings', () => {
  const source = `import { useTranslations } from 'next-intl';\nconst t = useTranslations();\nt(key);`;
  assert.throws(() => codemodSource(source, 'next-intl', { strict: true }), CodemodStrictError);
  const preview = codemodSource(source, 'next-intl');
  assert.equal(preview.code, source);
});

test('explicit custom calls can cross parameter/local scope boundaries safely', () => {
  const parameter = codemodSource(`function render($t) { return $t('hello'); }`, 'next-intl', { customCalls: [{ callee: '$t' }] });
  assert.equal(parameter.code, `function render(_t) { return m.hello(); }`);
  assert.equal(codemodSource(parameter.code, 'next-intl', { customCalls: [{ callee: '$t' }] }).code, parameter.code);

  const typedParameter = codemodSource(`function render($t: MessageFormatter) { return $t('hello'); }`, 'svelte-i18n', { customCalls: [{ callee: '$t' }] });
  assert.equal(typedParameter.code, `function render(_t: MessageFormatter) { return m.hello(); }`);

  const local = codemodSource(`async function render() { const $t = await getFormatter(); return $t('hello'); }`, 'next-intl', { customCalls: [{ callee: '$t' }] });
  assert.match(local.code, /^async function render\(\) \{\s+return m\.hello\(\); \}$/);
});

test('explicit custom calls preserve mixed dynamic bindings and fail closed', () => {
  const source = `async function render() { const $t = await getFormatter(); return [$t('hello'), $t(key)]; }`;
  const preview = codemodSource(source, 'next-intl', { customCalls: [{ callee: '$t' }] });
  assert.match(preview.code, /const \$t = await getFormatter\(\)/);
  assert.match(preview.code, /m\.hello\(\)/);
  assert.match(preview.code, /\$t\(key\)/);
  assert.throws(() => codemodSource(source, 'next-intl', { customCalls: [{ callee: '$t' }], strict: true }), CodemodStrictError);

  const nativeShadow = codemodSource(`import { useTranslations } from 'next-intl'; const t = useTranslations(); function f(t) { return t('shadowed'); } t('outer');`, 'next-intl');
  assert.match(nativeShadow.code, /return t\('shadowed'\)/);
  assert.match(nativeShadow.code, /m\.outer\(\)/);

  const conflict = codemodSource(`import { useTranslations } from 'next-intl'; const t = useTranslations(namespace); t('hello');`, 'next-intl', { customCalls: [{ callee: 't', namespace: 'Static' }] });
  assert.equal(conflict.replacements, 0);
  assert.ok(conflict.skipped.some(item => /multiple namespace/.test(item.reason)));
});

test('explicit custom provenance wins over synthesized native Svelte stores only when requested', () => {
  const source = `import { t } from 'svelte-i18n';\nasync function local() { const $t = await getFormatter(); return $t('local'); }\nfunction callback($t) { return $t('callback'); }`;
  const custom = codemodSource(source, 'svelte-i18n', { customCalls: [{ callee: '$t' }] });
  assert.doesNotMatch(custom.code, /from 'svelte-i18n'|getFormatter/);
  assert.match(custom.code, /return m\.local\(\)/);
  assert.match(custom.code, /function callback\(_t\) \{ return m\.callback\(\); \}/);

  const nativeOnly = codemodSource(`import { t } from 'svelte-i18n';\nfunction callback($t) { return $t('callback'); }`, 'svelte-i18n');
  assert.equal(nativeOnly.replacements, 0);
  assert.match(nativeOnly.code, /\$t\('callback'\)/);
  assert.ok(nativeOnly.skipped.some(item => /shadowed by a function parameter/.test(item.reason)));
});

test('Svelte cleanup removes static native imports while preserving explicit custom provenance', () => {
  const source = `<script>
import { _, t } from 'svelte-i18n';
function render($t) { return [$t('callback'), $_('native')]; }
</script>`;
  const result = codemodSource(source, 'svelte-i18n', {
    filename: 'Combined.svelte',
    customCalls: [{ callee: '$t' }],
    messagesImport: './i18n.js',
  });
  assert.equal(result.replacements, 2);
  assert.match(result.code, /m\.callback\(\)/);
  assert.match(result.code, /m\.native\(\)/);
  assert.doesNotMatch(result.code, /from ['"]svelte-i18n['"]/);
  assert.match(result.code, /import \{ m \} from ['"]\.\/i18n\.js['"]/);
});

test('Svelte cleanup retains native fallback imports for mixed static and dynamic custom calls', () => {
  const source = `<script>
import { _, t } from 'svelte-i18n';
function render($t) { return [$t('callback'), $t(dynamicKey), $_('native')]; }
</script>`;
  const result = codemodSource(source, 'svelte-i18n', {
    filename: 'Mixed.svelte',
    customCalls: [{ callee: '$t' }],
    messagesImport: './i18n.js',
  });
  assert.equal(result.replacements, 2);
  assert.match(result.code, /m\.callback\(\)/);
  assert.match(result.code, /m\.native\(\)/);
  assert.match(result.code, /\$t\(dynamicKey\)/);
  assert.match(result.code, /from ['"]svelte-i18n['"]/);
  assert.match(result.code, /import \{ m \} from ['"]\.\/i18n\.js['"]/);
  assert.ok(result.skipped.some(item => item.callee === '$t' && item.reason === 'message key is dynamic'));
});

test('Svelte i18n values wrappers are unwrapped only when metadata is absent', () => {
  const wrapped = codemodSource(`<script>import { t } from 'svelte-i18n'; const label = $t('count', { values: { count } });</script>`, 'svelte-i18n', { filename: 'Page.svelte' });
  assert.equal(wrapped.replacements, 1);
  assert.match(wrapped.code, /m\.count\(\{ count \}\)/);
  const metadata = codemodSource(`<script>import { t } from 'svelte-i18n'; const label = $t('count', { values: { count }, locale: 'fr' });</script>`, 'svelte-i18n', { filename: 'Page.svelte' });
  assert.equal(metadata.replacements, 0);
  assert.match(metadata.code, /\$t\('count', \{ values: \{ count \}, locale: 'fr' \}\)/);
  assert.ok(metadata.skipped.some(item => /unsupported svelte-i18n option/.test(item.reason)));
});

test('Svelte codemods rewrite only balanced calls in quoted attributes', () => {
  const source = `<script>
import { t } from 'svelte-i18n';
const fakeMarkup = "<button title=\\"{$t('fake')}\\">";
</script>
<!-- title="{$t('comment')}" -->
{@html '<button title="{$t("html_string")}">'}
<button title="{$t('search_for')} {name} {$t('search_help')}" aria-label='{$t("aria_label")} {$t("aria_hint")}' data-note="literal $t('plain_string')" />
<button title="{$t(dynamicKey)}" />
`;
  const result = codemodSource(source, 'svelte-i18n', { filename: 'Button.svelte' });
  assert.equal(result.replacements, 4);
  assert.match(result.code, /title="\{m\.search_for\(\)\} \{name\} \{m\.search_help\(\)\}"/);
  assert.match(result.code, /aria-label='\{m\.aria_label\(\)\} \{m\.aria_hint\(\)\}'/);
  assert.match(result.code, /data-note="literal \$t\('plain_string'\)"/);
  assert.match(result.code, /fakeMarkup = "<button title=\\"\{\$t\('fake'\)\}\\">"/);
  assert.match(result.code, /\{\$t\(dynamicKey\)\}/);
  assert.ok(result.skipped.some(item => item.callee === '$t' && item.reason === 'message key is dynamic'));
  assert.equal(codemodSource(result.code, 'svelte-i18n', { filename: 'Button.svelte' }).replacements, 0);

  const malformed = `<button title="{$t('broken')">`;
  const preview = codemodSource(malformed, 'svelte-i18n', { filename: 'Broken.svelte' });
  assert.equal(preview.replacements, 0);
  assert.equal(preview.code, malformed);
  assert.ok(preview.skipped.some(item => /interpolation is unclosed/.test(item.reason)));
  assert.throws(() => codemodSource(`${source}${malformed}`, 'svelte-i18n', { filename: 'Broken.svelte', strict: true }), CodemodStrictError);

  // The Svelte overlay is filename-gated; HTML-looking JavaScript remains
  // opaque when a caller supplies a script filename.
  const script = `const html = \`<button title="{\$t('fake')}\">\`;`;
  const scriptResult = codemodSource(script, 'svelte-i18n', { filename: 'fixture.ts', customCalls: [{ callee: '$t' }] });
  assert.equal(scriptResult.replacements, 0);
  assert.equal(scriptResult.code, script);
});

test('Svelte quoted-attribute scanning stays linear across large component files', () => {
  const source = (count) => {
    let result = '';
    for (let index = 0; index < count; index++) result += `<button data-id="row-${index}" title="{$t('title_${index}')} {name}" aria-label='{$t("label_${index}")} {$t("hint_${index}")}'></button>\n`;
    return result;
  };
  const small = source(250), smallStarted = performance.now();
  codemodSource(small, 'svelte-i18n', { filename: 'Large.svelte', customCalls: [{ callee: '$t' }] });
  const smallMilliseconds = performance.now() - smallStarted;
  const large = source(2000), largeStarted = performance.now();
  const result = codemodSource(large, 'svelte-i18n', { filename: 'Large.svelte', customCalls: [{ callee: '$t' }] });
  const largeMilliseconds = performance.now() - largeStarted;
  assert.equal(result.replacements, 6000);
  // This is intentionally a generous wall-clock guard. The ratio catches a
  // quadratic scan while the floor keeps a noisy sub-millisecond sample from
  // making the test flaky on slower local machines.
  assert.ok(largeMilliseconds < Math.max(2000, smallMilliseconds * 20), `${largeMilliseconds.toFixed(1)}ms exceeds linear-growth budget from ${smallMilliseconds.toFixed(1)}ms`);
});

test('strict codemods fail before writing unresolved calls', async t => {
  assert.throws(() => codemodSource(`const t=useTranslations(); t(key);`, 'next-intl', { strict: true }), CodemodStrictError);
  const root = await temporary(t), directory = join(root, 'src'), file = join(directory, 'page.ts');
  await mkdir(directory); await writeFile(file, `const t = useTranslations();\nt(key);\n`);
  await assert.rejects(codemodProject({ root, format: 'next-intl', write: true, strict: true }), /Strict codemod refused/);
  assert.equal(await readFile(file, 'utf8'), `const t = useTranslations();\nt(key);\n`);
});

test('strict project codemods accept static calls after safe residue cleanup', async t => {
  const root = await temporary(t), directory = join(root, 'src'), file = join(directory, 'page.ts');
  await mkdir(directory); await writeFile(file, `import { useTranslations } from 'next-intl';\nconst t = useTranslations();\nt('hello');\n`);
  await codemodProject({ root, format: 'next-intl', write: true, strict: true });
  assert.doesNotMatch(await readFile(file, 'utf8'), /next-intl|t\('hello'\)/);
  assert.match(await readFile(file, 'utf8'), /m\.hello\(\)/);
});

test('strict CLI reports every unresolved construct in JSON and NDJSON', async t => {
  const root = await temporary(t), directory = join(root, 'src');
  await mkdir(directory);
  await writeFile(join(directory, 'page.ts'), `const t=useTranslations();\nt(firstKey);\nt(secondKey);\n`);
  const cli = join(process.cwd(), 'dist/cli.js');
  const json = spawnSync(process.execPath, [cli, 'codemod', '--format', 'next-intl', '--strict', '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(json.status, 4, json.stdout + json.stderr);
  const report = JSON.parse(json.stdout);
  assert.equal(report.errors.length, 2);
  assert.ok(report.errors.every(item => item.code === 'UNRESOLVED_MIGRATION_CONSTRUCT'));
  assert.ok(report.errors.every(item => item.detailCode === 'DYNAMIC_MESSAGE_KEY' && item.action && Number.isInteger(item.offset)));
  const ndjson = spawnSync(process.execPath, [cli, 'codemod', '--format', 'next-intl', '--strict', '--ndjson'], { cwd: root, encoding: 'utf8' });
  assert.equal(ndjson.status, 4, ndjson.stdout + ndjson.stderr);
  const events = ndjson.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.filter(item => item.type === 'diagnostic' && item.code === 'UNRESOLVED_MIGRATION_CONSTRUCT').length, 2);
  assert.ok(events.filter(item => item.type === 'diagnostic').every(item => item.message.includes('[DYNAMIC_MESSAGE_KEY]')));
  assert.equal(events.at(-1).status, 'failed');
});
