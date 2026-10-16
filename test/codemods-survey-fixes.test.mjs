import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { codemodProject, codemodSource } from '@nordbeam/locale-migrate/codemods';
import { revisionMapper } from '../packages/locale-migrate/dist/codemod-positions.js';
import { temporary } from './helpers.mjs';

const lineOf = (text, needle) => text.slice(0, text.indexOf(needle)).split('\n').length;

test('a project preview reports skips at their lines in the unchanged file, and a write at their lines in the written one', async t => {
  const root = await temporary(t), directory = join(root, 'src'), file = join(directory, 'page.tsx');
  await mkdir(directory, { recursive: true });
  // The first call spans three lines and becomes one; the nested call takes a second pass.
  const source = `import { useTranslation } from 'react-i18next';
export function Page({ state }) {
  const { t } = useTranslation();
  const title = t(
    'page.title',
  );
  const label = t('page.label', { name: t('page.name') });
  return <p title={title}>{label} {t(state)} {t(\`page.\${state}\`)}</p>;
}
`;
  await writeFile(file, source);
  const preview = await codemodProject({ root, format: 'react-i18next', messagesImport: './i18n.js' });
  const skips = preview.skipped.filter(item => item.code !== 'INCUMBENT_RUNTIME_IMPORT');
  assert.deepEqual(skips.map(item => [item.code, item.line, item.column, source.slice(item.offset, item.offset + 8)]), [
    ['DYNAMIC_MESSAGE_KEY', 8, 36, 't(state)'],
    ['DYNAMIC_TEMPLATE_KEY', 8, 47, 't(`page.'],
  ]);
  assert.equal(skips[0].line, lineOf(source, 't(state)'));

  await codemodProject({ root, format: 'react-i18next', messagesImport: './i18n.js', write: true });
  const written = await readFile(file, 'utf8');
  const again = await codemodProject({ root, format: 'react-i18next', messagesImport: './i18n.js' });
  const after = again.skipped.find(item => item.code === 'DYNAMIC_MESSAGE_KEY');
  assert.equal(after.line, lineOf(written, 't(state)'));
  assert.equal(written.slice(after.offset, after.offset + 8), 't(state)');
});

test('the revision mapper maps text the rewrite kept exactly and rewritten text to where it started', () => {
  const before = 'const a = t(\n  "x.y",\n);\nconst b = t(key);\n';
  const after = 'import { m } from "./i18n";\nconst a = m.x.y();\nconst b = t(key);\n';
  const map = revisionMapper(before, after);
  assert.equal(map(after.indexOf('t(key)')), before.indexOf('t(key)'));
  assert.equal(map(after.indexOf('m.x.y')), before.indexOf('t(\n'));
  assert.equal(map(0), 0);
  assert.equal(revisionMapper('same', 'same')(2), 2);
});

const i18next = (body, filename = 'page.tsx') => codemodSource(`import { useTranslation, withTranslation } from 'react-i18next';\nimport type { TFunction } from 'i18next';\n${body}`, 'react-i18next', { filename });
const unbound = result => result.skipped.filter(item => item.code === 'UNBOUND_TRANSLATOR').map(item => [item.callee, /comes from ([^,(]+)/.exec(item.reason)[1].trim()]);

test('translators from parameters, props and locals are reported as UNBOUND_TRANSLATOR in a file without a hook', () => {
  const result = i18next(`export const label = (t: TFunction, count: number) => t('items.count', { count });
export const actions = [{ name: ({ t }) => t('actions.rename') }];
class Legacy extends React.Component {
  render() {
    const { t } = this.props;
    return <p>{t('legacy.title')} {this.props.t('legacy.body')}</p>;
  }
}
export const Wrapped = withTranslation()(function Card(props) { return props.t('card.title'); });
export function helper(i18n) { return i18n.t('helper.text'); }
export const unrelated = (items) => items.map(t => t.name);
`);
  assert.deepEqual(unbound(result), [
    ['t', 'a parameter typed TFunction'],
    ['t', 'a function parameter'],
    ['t', 'this.props'],
    ['this.props.t', 'this.props'],
    ['props.t', 'component props'],
    ['i18n.t', 'a function parameter'],
  ]);
  assert.equal(result.replacements, 0);
  assert.match(result.skipped.find(item => item.code === 'UNBOUND_TRANSLATOR').action, /message functions/);
});

test('a hook-bound call is rewritten and not also reported, and a shadowing parameter keeps its one diagnostic', () => {
  const result = i18next(`export function Page() {
  const { t } = useTranslation();
  const format = (t) => t('inner.key');
  return t('page.title') + format(t);
}
`);
  assert.equal(result.replacements, 1);
  assert.match(result.code, /m\.page\.title\(\)/);
  const inner = result.skipped.filter(item => item.offset !== undefined && result.code.slice(item.offset).startsWith("t('inner.key')"));
  assert.equal(inner.length, 1);
  assert.equal(inner[0].code, 'AMBIGUOUS_BINDING');
});

test('a file that does not reference the library reports nothing for a parameter named t', () => {
  const result = codemodSource('export const run = (t) => t("anything");\n', 'react-i18next', { filename: 'util.ts' });
  assert.deepEqual(result.skipped, []);
});

test('a parameter whose function type only mentions the translator type is not a translator', () => {
  const result = i18next(`export function perform(message: ((count: number, t: TFunction) => string) | undefined, context: { t: TFunction }) {
  return message?.(1, context.t);
}
export const label = (t?: TFunction | undefined) => t?.('maybe.label');
`);
  assert.deepEqual(unbound(result), [['t', 'a parameter typed TFunction']]);
});

test('react-intl, Lingui and next-intl translators from props, parameters and locals are reported', () => {
  const intl = codemodSource(`import { injectIntl, type IntlShape } from 'react-intl';
class Banner extends React.PureComponent {
  render() {
    const { intl } = this.props;
    return intl.formatMessage({ id: 'banner.title' });
  }
}
export const describe = (intl: IntlShape) => intl.formatMessage({ id: 'describe' });
export const format = (formatMessage: ReturnType<typeof useIntl>['formatMessage']) => formatMessage({ id: 'format' });
export default injectIntl(Banner);
`, 'react-intl', { filename: 'banner.tsx' });
  assert.deepEqual(unbound(intl), [['intl.formatMessage', 'this.props'], ['intl.formatMessage', 'a parameter typed IntlShape'], ['formatMessage', "a parameter typed ReturnType<typeof useIntl>['formatMessage']"]]);

  const lingui = codemodSource(`import type { I18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { getI18nInstance } from './i18n';
export const schema = (i18n: I18n) => i18n._(msg\`Required\`);
export async function handler() {
  const i18n = await getI18nInstance();
  return i18n._(msg\`Your account was disabled\`);
}
`, 'lingui', { filename: 'schema.ts' });
  assert.deepEqual(unbound(lingui).map(([callee]) => callee), ['i18n._', 'i18n._']);
  assert.match(lingui.skipped.find(item => item.code === 'UNBOUND_TRANSLATOR' && /local value/.test(item.reason)).reason, /await getI18nInstance\(\)/);

  const next = codemodSource(`import { getTranslations } from 'next-intl/server';
export default async function Page() {
  const [t, navT] = await Promise.all([getTranslations('page'), getTranslations('nav')]);
  return <h1>{t('title')} {navT('home')} {navT.rich('more', { b: chunks => <b>{chunks}</b> })}</h1>;
}
`, 'next-intl', { filename: 'page.tsx' });
  assert.deepEqual(unbound(next).map(([callee, source]) => [callee, source.split(' ')[0]]), [['t', 'a'], ['navT', 'a'], ['navT.rich', 'a']]);
});
