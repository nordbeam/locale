import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import { codemodProject, codemodSource } from '@nordbeam/locale-migrate/codemods';
import { temporary } from './helpers.mjs';

const intl = (body, options = {}) => codemodSource(body, 'react-intl', { filename: 'page.tsx', ...options });
const parses = code => parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });

test('a defineMessages constant in the file resolves in formatMessage and FormattedMessage spreads, and goes once nothing reads it', () => {
  const result = intl(`import { defineMessages, FormattedMessage, useIntl } from 'react-intl';

const messages = defineMessages({
  title: { id: 'page.title', defaultMessage: 'Title' },
  'item-count': { id: 'page.count', defaultMessage: '{count} items', description: 'Counter' },
});

export function Page({ count }) {
  const intl = useIntl();
  return <h1 title={intl.formatMessage(messages.title)}><FormattedMessage {...messages['item-count']} values={{ count }} /></h1>;
}
`);
  assert.equal(result.replacements, 2);
  assert.deepEqual(result.skipped, []);
  // The import cleanup removes the react-intl import line itself and keeps the blank line after it.
  assert.equal(result.code.trimStart(), `export function Page({ count }) {
  return <h1 title={m.page.title()}>{m.page.count({ count })}</h1>;
}
`);
});

test('a defineMessages constant that is exported, or still read, stays with its import', () => {
  const exported = intl(`import { defineMessages, useIntl } from 'react-intl';
export const messages = defineMessages({ title: { id: 'page.title', defaultMessage: 'Title' } });
export function Title() { const intl = useIntl(); return intl.formatMessage(messages.title); }
`);
  assert.equal(exported.replacements, 1);
  assert.match(exported.code, /import \{ defineMessages \} from 'react-intl';\nexport const messages = defineMessages/);
  assert.match(exported.code, /return m\.page\.title\(\);/);

  const listed = intl(`import { defineMessages, useIntl } from 'react-intl';
const messages = defineMessages({ title: { id: 'page.title' }, other: { id: 'page.other' } });
export function Title() { const intl = useIntl(); return [intl.formatMessage(messages.title), Object.keys(messages)]; }
`);
  assert.equal(listed.replacements, 1);
  assert.match(listed.code, /const messages = defineMessages/);
});

test('a defineMessage constant, destructured formatMessage and this.props.intl resolve too', () => {
  const result = intl(`import { defineMessage, defineMessages, injectIntl, useIntl } from 'react-intl';
const greeting = defineMessage({ id: 'home.greeting', defaultMessage: 'Hello' });
const labels = defineMessages({ save: { id: 'actions.save' } });
export function Greeting() { const { formatMessage } = useIntl(); return formatMessage(greeting); }
class Save extends React.Component { render() { return this.props.intl.formatMessage(labels.save); } }
export default injectIntl(Save);
`);
  assert.equal(result.replacements, 2);
  assert.match(result.code, /return m\.home\.greeting\(\);/);
  assert.match(result.code, /return m\.actions\.save\(\);/);
  assert.doesNotMatch(result.code, /defineMessages?\b/);
  assert.match(result.code, /import \{ injectIntl \} from 'react-intl';/);
  parses(result.code);
});

test('a conditional between descriptor constants lowers to one call per branch', () => {
  const result = intl(`import { defineMessages, useIntl } from 'react-intl';
const messages = defineMessages({ mute: { id: 'account.mute' }, unmute: { id: 'account.unmute' }, block: { id: 'account.block' } });
export function Menu({ muting, blocked, name, other }) {
  const intl = useIntl();
  return [
    intl.formatMessage(muting ? messages.unmute : messages.mute, { name }),
    intl.formatMessage(blocked ? { id: 'account.unblock' } : muting ? messages.unmute : messages.block),
    intl.formatMessage(muting ? messages.unmute : other),
  ];
}
`);
  assert.equal(result.replacements, 2);
  assert.match(result.code, /\(muting \? m\.account\.unmute\(\{ name \}\) : m\.account\.mute\(\{ name \}\)\)/);
  assert.match(result.code, /\(blocked \? m\.account\.unblock\(\) : \(muting \? m\.account\.unmute\(\) : m\.account\.block\(\)\)\)/);
  assert.match(result.code, /intl\.formatMessage\(muting \? messages\.unmute : other\)/);
  assert.deepEqual(result.skipped.filter(item => item.code !== 'INCUMBENT_RUNTIME_IMPORT').map(item => item.reason), ['descriptor has no static id']);
});

test('a descriptor that is not a static defineMessages entry is still reported', () => {
  const result = intl(`import { defineMessages, FormattedMessage, useIntl } from 'react-intl';
const messages = defineMessages({ title: { id: 'page.title' }, computed: { id: \`page.\${kind}\` } });
export function Page({ descriptor, messages }) {
  const intl = useIntl();
  return <p>{intl.formatMessage(descriptor)}{intl.formatMessage(messages.computed)}<FormattedMessage {...descriptor} /></p>;
}
export function Other() { const intl = useIntl(); return intl.formatMessage(messages.title); }
`);
  // `messages` is also a parameter name in this file, so no `messages.*` is resolved by name.
  assert.equal(result.replacements, 0);
  const reasons = result.skipped.filter(item => item.code === 'DYNAMIC_MESSAGE_KEY').map(item => item.reason);
  assert.deepEqual(reasons.sort(), ['component spreads descriptor, a descriptor with no static id', 'descriptor has no static id', 'descriptor has no static id', 'descriptor has no static id']);

  const unshadowed = intl(`import { defineMessages, useIntl } from 'react-intl';
const messages = defineMessages({ title: { id: 'page.title' }, computed: { id: \`page.\${kind}\` } });
export function Page() { const intl = useIntl(); return [intl.formatMessage(messages.title), intl.formatMessage(messages.computed)]; }
`);
  assert.equal(unshadowed.replacements, 1);
  assert.equal(unshadowed.skipped.filter(item => item.code === 'DYNAMIC_MESSAGE_KEY').length, 1);
  assert.match(unshadowed.code, /const messages = defineMessages/, 'a constant still read by an unresolved call stays');
});

test('values holding an element or a rich renderer become rich(), also through a name bound to an element', () => {
  const result = intl(`import { FormattedMessage, useIntl } from 'react-intl';
export function Notice({ filter, user, renderBold }) {
  const intl = useIntl();
  const settings_link = (
    <a href="/settings"><FormattedMessage id="filter.settings_link" defaultMessage="settings page" /></a>
  );
  let expired = null;
  expired = <b>expired</b>;
  function strong(chunks) { return <strong>{chunks}</strong>; }
  return <>
    <FormattedMessage id="filter.review" defaultMessage="Go to the {settings_link}." values={{ settings_link }} />
    <FormattedMessage id="filter.state" defaultMessage="{state}" values={{ state: expired }} />
    <FormattedMessage id="filter.title" defaultMessage="Added to {title}." values={{ title: filter.get('title') }} />
    <FormattedMessage id="user.name" defaultMessage="{name} follows you" values={{ name: <bdi>{user.name}</bdi> }} />
    <FormattedMessage id="user.bold" defaultMessage="<b>Hi</b> <s>there</s>" values={{ b: chunks => <b>{chunks}</b>, s: strong }} />
    <span aria-label={intl.formatMessage({ id: 'user.label' }, { link: <a href="/u">{user.name}</a> })} />
  </>;
}
`);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.replacements, 7);
  assert.match(result.code, /^import \{ rich \} from '@nordbeam\/locale\/react\/rich';/);
  assert.match(result.code, /\{rich\(m\.filter\.review, \{ settings_link \}\)\}/);
  assert.match(result.code, /\{rich\(m\.filter\.state, \{ state: expired \}\)\}/);
  assert.match(result.code, /\{m\.filter\.title\(\{ title: filter\.get\('title'\) \}\)\}/);
  assert.match(result.code, /\{rich\(m\.user\.name, \{ name: <bdi>\{user\.name\}<\/bdi> \}\)\}/);
  assert.match(result.code, /\{rich\(m\.user\.bold, \{ b: chunks => <b>\{chunks\}<\/b>, s: strong \}\)\}/);
  assert.match(result.code, /aria-label=\{rich\(m\.user\.label, \{ link: <a href="\/u">\{user\.name\}<\/a> \}\)\}/);
  assert.match(result.code, /<a href="\/settings">\{m\.filter\.settings_link\(\)\}<\/a>/);
  parses(result.code);
});

test('tagName wraps the message in that element', () => {
  const result = intl(`import { FormattedMessage } from 'react-intl';
export const Title = ({ count, items }) => <div>
  <FormattedMessage id="title" tagName="h2" />
  <FormattedMessage id="hint" defaultMessage="{br} {count}" values={{ br: <br />, count }} tagName="p" />
  {items.map(item => <FormattedMessage key={item.id} id="item" tagName={Fragment} values={{ name: item.name }} />)}
</div>;
`);
  assert.equal(result.replacements, 3);
  assert.deepEqual(result.skipped, []);
  assert.match(result.code, /<h2>\{m\.title\(\)\}<\/h2>/);
  assert.match(result.code, /<p>\{rich\(m\.hint, \{ br: <br \/>, count \}\)\}<\/p>/);
  assert.match(result.code, /items\.map\(item => <Fragment key=\{item\.id\}>\{m\.item\(\{ name: item\.name \}\)\}<\/Fragment>\)/);
  parses(result.code);

  const children = intl(`import { FormattedMessage } from 'react-intl';
export const Rich = () => <FormattedMessage id="rich">{text => <b>{text}</b>}</FormattedMessage>;
`);
  assert.equal(children.replacements, 0);
  assert.ok(children.skipped.some(item => item.code === 'RICH_MESSAGE'));
});

test('an element by name in Lingui and i18next values is reported, not printed as [object Object]', () => {
  const lingui = codemodSource(`import { Trans } from '@lingui/react';
export function Notice() {
  const link = <a href="/terms">terms</a>;
  return <p><Trans id="notice.terms" values={{ link }} /><Trans id="notice.plain" values={{ name: 'x' }} /></p>;
}
`, 'lingui', { filename: 'notice.tsx' });
  assert.equal(lingui.replacements, 1);
  assert.match(lingui.code, /<Trans id="notice\.terms" values=\{\{ link \}\} \/>/);
  assert.ok(lingui.skipped.some(item => item.code === 'RICH_MESSAGE' && /React element by name/.test(item.reason)));

  const i18next = codemodSource(`import { Trans, useTranslation } from 'react-i18next';
export function Notice() {
  const { t } = useTranslation();
  const link = <a href="/terms">{t('terms')}</a>;
  return <Trans i18nKey="notice.terms" values={{ link }} />;
}
`, 'react-i18next', { filename: 'notice.tsx' });
  assert.ok(i18next.skipped.some(item => item.code === 'RICH_MESSAGE' && /React element by name/.test(item.reason)));
  assert.match(i18next.code, /<Trans i18nKey="notice\.terms" values=\{\{ link \}\} \/>/);
});

test('codemodProject resolves descriptor constants another module exports, and drops imports it no longer reads', async t => {
  const root = await temporary(t), src = join(root, 'src');
  await mkdir(join(src, 'messages'), { recursive: true });
  await mkdir(join(src, 'menu'), { recursive: true });
  await writeFile(join(src, 'messages', 'index.ts'), `import { defineMessages } from 'react-intl';
export const menuMessages = defineMessages({ open: { id: 'menu.open', defaultMessage: 'Open' } });
const shared = defineMessages({ close: { id: 'menu.close', defaultMessage: 'Close' } });
export default shared;
`);
  await writeFile(join(src, 'menu', 'labels.js'), `import { defineMessage } from 'react-intl';
export const quit = defineMessage({ id: 'menu.quit', defaultMessage: 'Quit' });
`);
  await writeFile(join(src, 'menu', 'Menu.tsx'), `import { FormattedMessage, useIntl } from 'react-intl';
import shared, { menuMessages } from '../messages';
import { quit } from './labels.js';
import { helper } from './helper';

export function Menu() {
  const intl = useIntl();
  return <nav aria-label={intl.formatMessage(menuMessages.open)}><FormattedMessage {...shared.close} />{intl.formatMessage(quit)}{helper()}</nav>;
}
`);
  await writeFile(join(src, 'menu', 'helper.ts'), `export const helper = () => null;\n`);
  const preview = await codemodProject({ root, format: 'react-intl', messagesImport: './i18n' });
  assert.equal(preview.replacements, 3);
  assert.deepEqual(preview.skipped.filter(item => item.code !== 'INCUMBENT_RUNTIME_IMPORT'), []);
  const applied = await codemodProject({ root, format: 'react-intl', messagesImport: './i18n', write: true });
  assert.equal(applied.replacements, 3);
  assert.equal(await readFile(join(src, 'menu', 'Menu.tsx'), 'utf8'), `import { m } from './i18n';
import { helper } from './helper';

export function Menu() {
  return <nav aria-label={m.menu.open()}>{m.menu.close()}{m.menu.quit()}{helper()}</nav>;
}
`);
  // The modules that declare the descriptors are left as they were.
  assert.match(await readFile(join(src, 'messages', 'index.ts'), 'utf8'), /export const menuMessages = defineMessages/);

  // Alone, codemodSource knows only the file's own constants.
  const alone = codemodSource(`import { useIntl } from 'react-intl';\nimport { menuMessages } from '../messages';\nexport const Open = () => { const intl = useIntl(); return intl.formatMessage(menuMessages.open); };\n`, 'react-intl', { filename: 'Open.tsx' });
  assert.equal(alone.replacements, 0);
  assert.ok(alone.skipped.some(item => item.reason === 'descriptor has no static id'));
});
