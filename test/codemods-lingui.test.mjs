import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '@babel/parser';
import { codemodSource } from '@nordbeam/locale-migrate/codemods';
import { planReactMigration } from '@nordbeam/locale-migrate/react';

const lingui = (body, options = {}) => codemodSource(`import { Trans, useLingui } from '@lingui/react';\nimport { defineMessage } from '@lingui/macro';\n${body}`, 'lingui', { filename: 'page.tsx', ...options });
const parses = code => parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });

test('Lingui descriptors keep their values, inside defineMessage() too', () => {
  const result = lingui(`export function Page({ total }) {
  const { i18n } = useLingui();
  return <p>{i18n._({ id: 'facets.remove', message: '{name} ({count})', values: { name: 'x', count: total } })} {i18n._(defineMessage({ id: 'duration.day', message: 'day' }))}</p>;
}`);
  assert.match(result.code, /m\.facets\.remove\(\{ name: 'x', count: total \}\)/);
  assert.match(result.code, /m\.duration\.day\(\)/);
  assert.equal(result.skipped.length, 0);
});

test('a <Trans> id written as an expression is a string, a finite conditional, or reported as dynamic', () => {
  const result = lingui(`export function Page({ open, props }) {
  return <p>
    <Trans id={'program.weeks'} values={{ weeks: 2 }} />
    <Trans id={open ? 'menu.close' : 'menu.open'} />
    <Trans id={open ? defineMessage({ id: 'more.less' }).id : defineMessage({ id: 'more.more' }).id} />
    <Trans id={props.errorMessage} />
  </p>;
}`);
  assert.match(result.code, /\{m\.program\.weeks\(\{ weeks: 2 \}\)\}/);
  assert.match(result.code, /\{\(open \? m\.menu\.close\(\) : m\.menu\.open\(\)\)\}/);
  assert.match(result.code, /\{\(open \? m\.more\.less\(\) : m\.more\.more\(\)\)\}/);
  assert.match(result.code, /<Trans id=\{props\.errorMessage\} \/>/);
  assert.doesNotMatch(result.code, /m\["/);
  assert.deepEqual(result.skipped.map(item => item.code), ['DYNAMIC_MESSAGE_KEY']);
  parses(result.code);
});

test('a parenthesized <Trans> after a comment stays an expression', () => {
  const result = lingui(`export function Banner({ ended }) {
  return <span>{ended ? (
    // The old copy had a catalog entry of its own.
    <Trans id="banner.lapsed" values={{ date: ended }} />
  ) : null}</span>;
}`);
  assert.match(result.code, /\/\/ The old copy[^\n]*\n\s*m\.banner\.lapsed\(\{ date: ended \}\)\n/);
  assert.equal(result.skipped.length, 0);
  parses(result.code);
});

test('elements are bounded by the parser, so a nested /> or a sibling is never swallowed', () => {
  const result = lingui(`export const Page = () => <p><Trans id="first">Hello</Trans> <Trans id="second" /> <Foo title=<Trans id="attribute" /> /></p>;`);
  assert.match(result.code, /\{m\.first\(\)\} \{m\.second\(\)\} <Foo title=\{m\.attribute\(\)\} \/>/);
  parses(result.code);
});

test('Lingui <Trans components> becomes rich() with one slot per numbered component', () => {
  const result = lingui(`export const Page = () => <p><Trans id="terms" values={{ n: 1 }} components={[<a href="/terms" />, <br />, <Link to="/help">help</Link>, <Icon name="i" />]} /></p>;`);
  assert.match(result.code, /^import \{ rich \} from '@nordbeam\/locale\/react\/rich';/);
  assert.match(result.code, /\{rich\(m\.terms, \{ n: 1, tag0: \(children\) => <a href="\/terms">\{children\}<\/a>, tag1: \(\) => <br \/>, tag2: \(children\) => children\.length \? <Link to="\/help">\{children\}<\/Link> : <Link to="\/help">help<\/Link>, tag3: \(children\) => children\.length \? <Icon name="i">\{children\}<\/Icon> : <Icon name="i" \/> \}\)\}/);
  parses(result.code);
  // A message without tags never used its components, and stays a plain call.
  const plain = lingui(`export const Page = () => <p><Trans id="terms" components={{ 0: <b /> }} /></p>;`, { richMessageIds: ['other'] });
  assert.match(plain.code, /\{m\.terms\(\)\}/);
  assert.doesNotMatch(plain.code, /rich/);
  // A component passed by reference cannot be rebuilt around the message's children.
  const reference = lingui(`export const Page = ({ link }) => <p><Trans id="terms" components={[link]} /></p>;`);
  assert.deepEqual(reference.skipped.map(item => item.code), ['RICH_MESSAGE']);
});

test('renamed IDs reach the calls', () => {
  const result = lingui(`export const Page = () => <p><Trans id="toast" /> <Trans id="toast.action" /></p>;`, { messageIds: ['toast.message', 'toast.action'], messageIdRenames: { toast: 'toast.message' } });
  assert.match(result.code, /\{m\.toast\.message\(\)\} \{m\.toast\.action\(\)\}/);
  assert.equal(result.skipped.length, 0);
});

test('the React plan binds m in each component whose only messages were <Trans> elements', () => {
  const plan = planReactMigration(`import { Trans } from '@lingui/react';
export function Title() {
  return <h1><Trans id="title" /></h1>;
}
export const Subtitle = memo(() => <p><Trans id="subtitle" /></p>);
`, { format: 'lingui', i18nImport: './i18n/client' });
  assert.match(plan.code, /export function Title\(\) \{\n  const m = i18n\.useMessages\(\);\n  return <h1>\{m\.title\(\)\}<\/h1>;/);
  assert.match(plan.code, /memo\(\(\) => \{ const m = i18n\.useMessages\(\); return \(<p>\{m\.subtitle\(\)\}<\/p>\);\}\)/);
  assert.match(plan.code, /import \{ i18n \} from "\.\/i18n\/client"/);
  assert.doesNotMatch(plan.code, /@lingui/);
  assert.equal(plan.skipped.length, 0);
  parses(plan.code);
});

test('a <Trans> outside any component stays lazy through a generated message component', () => {
  const plan = planReactMigration(`import { Trans } from '@lingui/react';
const items = [{ label: <Trans id="items.first" values={{ n: 1 }} /> }];
const describe = kind => <Trans id="items.kind" />;
export function List() { return <ul>{items.map(item => <li>{item.label} {describe()}</li>)}</ul>; }
`, { format: 'lingui', i18nImport: './i18n/client', filename: 'list.tsx' });
  assert.match(plan.code, /label: <LocaleMessage render=\{\(m\) => m\.items\.first\(\{ n: 1 \}\)\} \/>/);
  assert.match(plan.code, /const describe = kind => <LocaleMessage render=\{\(m\) => m\.items\.kind\(\)\} \/>;/);
  assert.match(plan.code, /function LocaleMessage\(\{ render \}: \{ render: \(m: ReturnType<typeof i18n\.useMessages>\) => React\.ReactNode \}\) \{\n  return <>\{render\(i18n\.useMessages\(\)\)\}<\/>;\n\}/);
  assert.doesNotMatch(plan.code, /const m = /, 'no component needed a binding of its own');
  parses(plan.code);
  const js = planReactMigration(`import { Trans } from '@lingui/react';\nexport const title = <Trans id="title" />;\n`, { format: 'lingui', i18nImport: './i18n/client', filename: 'title.jsx' });
  assert.match(js.code, /function LocaleMessage\(\{ render \}\) \{/);
});

test('the React plan leaves a file unchanged when its own m would collide with the binding', () => {
  const source = `import { Trans } from '@lingui/react';\nexport function Clock() { const m = moment(); return <p><Trans id="clock" /> {m.format()}</p>; }\n`;
  const plan = planReactMigration(source, { format: 'lingui', i18nImport: './i18n/client' });
  assert.equal(plan.code, source);
  assert.equal(plan.changed, false);
  assert.ok(plan.skipped.some(item => item.code === 'MISSING_MESSAGES_BINDING'));
});
