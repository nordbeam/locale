import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import { codemodProject, codemodSource } from '@nordbeam/locale-migrate/codemods';
import { temporary } from './helpers.mjs';

// Lingui 4 and 5 name messages by their source text, so these sources resolve through a
// source-to-id map, the one migrate-project derives from the migrated catalogs.
const map = {
  'Hello {name}': 'greeting.hello',
  'Welcome {0}, you have {count} items and {1}': 'welcome',
  'Account deleted': 'account.deleted',
  'Hi {name}': 'hi',
  'Saved': 'saved',
  'Delete': 'delete',
  'Rename': 'rename',
  'Archive': 'archive',
  'verb\u0004Archive': 'archive.verb',
  'Documenso will delete <0>all of your documents</0>, along with all of your completed documents.': 'delete.warning',
  'Last initiated {timeAgo} ago': 'last.initiated',
  'Please type <0>{0}</0> to confirm.': 'confirm.type',
  'Line one<0/>Line two': 'lines',
  'Hello world': 'hello.world',
  'Terms & conditions': 'terms',
  'Read the <tag0>docs</tag0>': 'docs',
  'Call <0>me</0> later': 'call.later',
  'direction\u0004Left': 'direction.left',
  '{count, plural, one {# item} other {# items}}': 'items.count',
  'You have {n, plural, one {# item} other {# items}}': 'items.you',
};
const lingui = (body, options = {}) => codemodSource(body, 'lingui', { filename: 'page.tsx', messageIdBySource: map, ...options });
const parses = code => parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
const codes = result => result.skipped.map(item => item.code);

test('tagged macros name identifiers and number other expressions, as Lingui extracts them', () => {
  const result = lingui(`import { useLingui } from '@lingui/react/macro';
import { plural } from '@lingui/core/macro';
export function Page({ user, name, count, items }) {
  const { t } = useLingui();
  const choice = t\`\${plural(count, { one: '# item', other: '# items' })}\`;
  return <p title={t\`Hello \${name}\`}>{t\`Welcome \${user.name}, you have \${count} items and \${items.length}\`}{choice}</p>;
}`);
  assert.match(result.code, /title=\{m\.greeting\.hello\(\{ name \}\)\}/);
  assert.match(result.code, /\{m\.welcome\(\{ 0: user\.name, count, 1: items\.length \}\)\}/);
  // plural() inside the template is part of its message, an ICU plural.
  assert.match(result.code, /const choice = m\.items\.count\(\{ count \}\);/);
  assert.equal(result.replacements, 3);
  assert.deepEqual(result.skipped, []);
  parses(result.code);
});

test('a translator reading a source macro becomes one message call', () => {
  const result = lingui(`import { useLingui } from '@lingui/react';
import { msg, t } from '@lingui/core/macro';
export function Page({ name }) {
  const { _, i18n } = useLingui();
  return <>{_(msg\`Account deleted\`)}{i18n._(msg\`Hi \${name}\`)}{i18n._(msg({ message: 'Saved', comment: 'toast' }))}{i18n._(t\`Delete\`)}</>;
}`);
  assert.match(result.code, /<>\{m\.account\.deleted\(\)\}\{m\.hi\(\{ name \}\)\}\{m\.saved\(\)\}\{m\.delete\(\)\}<\/>/);
  assert.equal(result.replacements, 4);
  assert.deepEqual(result.skipped, []);
  assert.doesNotMatch(result.code, /@lingui/);
  parses(result.code);
});

test("useLingui's t takes a descriptor, a static id with values, or a macro", () => {
  const result = lingui(`import { useLingui } from '@lingui/react/macro';
import { msg } from '@lingui/core/macro';
export function Page({ name, descriptor }) {
  const { t } = useLingui();
  const a = t({ message: 'Delete', comment: 'button' });
  const b = t({ id: 'explicit.id', message: \`Hi \${name}\` });
  const c = t(msg\`Rename\`);
  const d = t({ id: 'explicit.values', message: 'Hi {name}', values: { name } });
  const e = t(descriptor);
  return [a, b, c, d, e];
}`);
  assert.match(result.code, /const a = m\.delete\(\);/);
  assert.match(result.code, /const b = m\.explicit\.id\(\{ name \}\);/);
  assert.match(result.code, /const c = m\.rename\(\);/);
  assert.match(result.code, /const d = m\.explicit\.values\(\{ name \}\);/);
  assert.match(result.code, /const e = t\(descriptor\);/);
  assert.deepEqual(codes(result), ['DYNAMIC_MESSAGE_KEY']);
  parses(result.code);
});

test('msg and defineMessage stay lazy: each becomes the message function', () => {
  const result = lingui(`import { msg, defineMessage } from '@lingui/core/macro';
const STATUS = { archived: msg({ message: 'Archive', context: 'verb' }), renamed: defineMessage({ message: 'Rename' }), saved: msg\`Saved\` };
const byId = defineMessage({ id: 'explicit.lazy' });
export const greeting = (name: string) => msg\`Hi \${name}\`;
export const known = defineMessage({ id: 'explicit.read' }).id;`);
  assert.match(result.code, /const STATUS = \{ archived: m\.archive\.verb, renamed: m\.rename, saved: m\.saved \};/);
  assert.match(result.code, /const byId = m\.explicit\.lazy;/);
  assert.match(result.code, /export const greeting = \(name: string\) => \(\(\) => m\.hi\(\{ name \}\)\);/);
  // `.id` reads the id, not the message, so the macro and its import stay.
  assert.match(result.code, /export const known = defineMessage\(\{ id: 'explicit\.read' \}\)\.id;/);
  assert.match(result.code, /import \{ defineMessage \} from '@lingui\/core\/macro';/);
  assert.deepEqual(result.skipped, []);
  parses(result.code);
});

test('a source in several contexts resolves through the generated ids when the map leaves it out', () => {
  const result = codemodSource(`import { msg } from '@lingui/core/macro';
export const labels = [msg\`Light\`, msg({ message: 'Light', context: 'theme' })];`, 'lingui', { filename: 'labels.ts', messageIds: ['Light', 'theme.Light'] });
  assert.match(result.code, /export const labels = \[m\.Light, m\.theme\.Light\];/);
  assert.deepEqual(result.skipped, []);
});

test('<Trans> children become the message Lingui extracts, rich() when they hold elements', () => {
  const result = lingui(`import { Plural, Trans } from '@lingui/react/macro';
export function Page({ timeAgo, user, n, name }) {
  return <div>
    <Trans>
      Documenso will delete <span className="font-semibold">all of your documents</span>, along with all
      of your completed documents.
    </Trans>
    <Trans>Last initiated {timeAgo} ago</Trans>
    <Trans>
      Please type <span className="font-semibold">{user.email}</span> to confirm.
    </Trans>
    <Trans>Line one<br />Line two</Trans>
    <Trans>Hello{" "}world</Trans>
    <Trans>Terms &amp; conditions</Trans>
    <Trans>Read the <a href="/docs">docs</a></Trans>
    <Trans id="explicit.children">Hello {name}</Trans>
    <Trans context="direction">Left</Trans>
    <Trans>You have <Plural value={n} one="# item" other="# items" /></Trans>
  </div>;
}`);
  assert.match(result.code, /^import \{ rich \} from '@nordbeam\/locale\/react\/rich';/);
  assert.match(result.code, /\{rich\(m\.delete\.warning, \{ tag0: \(children\) => <span className="font-semibold">\{children\}<\/span> \}\)\}/);
  assert.match(result.code, /\{m\.last\.initiated\(\{ timeAgo \}\)\}/);
  assert.match(result.code, /\{rich\(m\.confirm\.type, \{ 0: user\.email, tag0: \(children\) => <span className="font-semibold">\{children\}<\/span> \}\)\}/);
  assert.match(result.code, /\{rich\(m\.lines, \{ tag0: \(\) => <br \/> \}\)\}/);
  assert.match(result.code, /\{m\.hello\.world\(\)\}/);
  assert.match(result.code, /\{m\.terms\(\)\}/);
  // The catalog migration renames numbered tags, so a derived map holds `<tag0>`.
  assert.match(result.code, /\{rich\(m\.docs, \{ tag0: \(children\) => <a href="\/docs">\{children\}<\/a> \}\)\}/);
  assert.match(result.code, /\{m\.explicit\.children\(\{ name \}\)\}/);
  assert.match(result.code, /\{m\.direction\.left\(\)\}/);
  assert.match(result.code, /\{m\.items\.you\(\{ n \}\)\}/);
  assert.equal(result.replacements, 10);
  assert.deepEqual(result.skipped, []);
  parses(result.code);
});

test('a <Trans> nested in another is part of the outer message', () => {
  const result = lingui(`import { Trans } from '@lingui/react/macro';
export const Page = () => <p><Trans>Call <b><Trans>me</Trans></b> later</Trans></p>;`);
  assert.match(result.code, /<p>\{rich\(m\.call\.later, \{ tag0: \(children\) => <b>\{children\}<\/b> \}\)\}<\/p>/);
  assert.equal(result.replacements, 1);
  assert.deepEqual(result.skipped, []);
  parses(result.code);
});

test('a keyed <Trans> in a list becomes a string, or is reported when rich() would need the key', () => {
  const result = lingui(`import { Trans } from '@lingui/react/macro';
export const items = (name) => [<Trans key="a">Hi {name}</Trans>, <Trans key="b">Read the <a href="/docs">docs</a></Trans>];`);
  assert.match(result.code, /\[m\.hi\(\{ name \}\), <Trans key="b">/);
  assert.deepEqual(codes(result), ['RICH_MESSAGE']);
  assert.match(result.skipped[0].reason, /keyed <Trans>/);
  parses(result.code);
});

test('a source missing from the map is reported, never guessed', () => {
  const result = lingui(`import { Trans, useLingui } from '@lingui/react/macro';
export function Page() {
  const { t } = useLingui();
  return <p title={t\`Not in the map\`}><Trans>Nor <b>this</b></Trans></p>;
}`);
  assert.equal(result.replacements, 0);
  assert.deepEqual(codes(result), ['MESSAGE_ID_UNRESOLVED', 'MESSAGE_ID_UNRESOLVED']);
  assert.ok(result.skipped.some(item => item.reason.includes('"Not in the map"')));
  assert.ok(result.skipped.some(item => item.reason.includes('"Nor <0>this</0>"')));
});

test('a translator around a macro migrates in one pass through codemodProject', async t => {
  const root = await temporary(t), directory = join(root, 'src');
  await mkdir(directory);
  await writeFile(join(directory, 'page.tsx'), `import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
export function Page({ name }) {
  const { _ } = useLingui();
  return <p>{_(msg\`Hi \${name}\`)}</p>;
}
`);
  const preview = await codemodProject({ root, format: 'lingui', messageIdBySource: map });
  assert.equal(preview.replacements, 1);
  assert.deepEqual(preview.skipped, []);
});
