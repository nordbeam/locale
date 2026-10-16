import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '@babel/parser';
import { codemodSource } from '@nordbeam/locale-migrate/codemods';

// Lingui extracts plural(), select() and selectOrdinal(), and <Plural>, <Select> and
// <SelectOrdinal>, as ICU choices; these are the strings its catalogs hold for them.
const map = {
  '{count, plural, one {# item} other {# items}}': 'items',
  '{0, plural, one {{years} year} other {{years} years}}': 'age.years',
  '{count, plural, =0 {No items} one {# item} other {# items}}': 'items.none',
  '{name} has {count, plural, one {# item} other {# items}}': 'items.owner',
  '{gender, select, male {He} female {She} other {They}}': 'pronoun',
  '{n, selectordinal, offset:1 one {#st} two {#nd} other {#th}}': 'place',
  '{n, plural, one {# message} other {# messages}}': 'messages.count',
  '{n, plural, =0 {No items} one {<0># item</0>} other {# items}}': 'items.bold',
  'You have {n, plural, one {# message} other {# messages}}': 'messages.you',
  '{0, plural, one {{1} of # row selected.} other {{2} of # rows selected.}}': 'rows.selected',
  '{count, select, other {{count, plural, one {# reply} other {# replies}}}}': 'replies',
};
const lingui = (body, options = {}) => codemodSource(body, 'lingui', { filename: 'page.tsx', messageIdBySource: map, ...options });
const parses = code => parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });

test('plural() on its own is a message: its value is a placeholder and its cases ICU text', () => {
  const result = lingui(`import { plural } from '@lingui/core/macro';
export function age(years, count) {
  return [plural(Math.abs(years), { one: \`\${years} year\`, other: \`\${years} years\` }), plural(count, { one: '# item', other: '# items' }), plural(count, { 0: 'No items', one: '# item', other: '# items' })];
}`);
  assert.match(result.code, /return \[m\.age\.years\(\{ 0: Math\.abs\(years\), years \}\), m\.items\(\{ count \}\), m\.items\.none\(\{ count \}\)\];/);
  assert.deepEqual(result.skipped.filter(item => item.code !== 'INCUMBENT_RUNTIME_IMPORT'), []);
  parses(result.code);
});

test('choices inside a template, select() and selectOrdinal() with an offset', () => {
  const result = lingui(`import { plural, select, selectOrdinal, msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
export const reply = msg({ message: select(count, { other: plural(count, { one: '# reply', other: '# replies' }) }) });
export function Page({ count, name, gender, n }) {
  const { t } = useLingui();
  return [t\`\${name} has \${plural(count, { one: '# item', other: '# items' })}\`, select(gender, { male: 'He', female: 'She', other: 'They' }), selectOrdinal(n, { offset: 1, one: '#st', two: '#nd', other: '#th' })];
}`);
  assert.match(result.code, /return \[m\.items\.owner\(\{ name, count \}\), m\.pronoun\(\{ gender \}\), m\.place\(\{ n \}\)\];/);
  // msg() is translated where it is read, so it becomes the message function with its values.
  assert.match(result.code, /export const reply = \(\(\) => m\.replies\(\{ count \}\)\);/);
  assert.deepEqual(result.skipped, []);
  parses(result.code);
});

test('<Plural>, <Select> and a choice inside <Trans> become calls, rich() when a case holds an element', () => {
  const result = lingui(`import { Plural, Select, Trans } from '@lingui/react/macro';
export function Page({ n, gender, table }) {
  return <div title={<Plural value={n} one="# message" other="# messages" />}>
    <Plural value={n} _0="No items" one={<b># item</b>} other="# items" />
    <Select value={gender} _male="He" _female="She" other="They" />
    <Trans>You have <Plural value={n} one="# message" other="# messages" /></Trans>
    <Plural
      value={table.rows.length}
      one={<Trans>{table.selected.length} of # row selected.</Trans>}
      other={<Trans>{table.selected.length} of # rows selected.</Trans>}
    />
  </div>;
}`);
  assert.match(result.code, /<div title=\{m\.messages\.count\(\{ n \}\)\}>/);
  assert.match(result.code, /\{rich\(m\.items\.bold, \{ n, tag0: \(children\) => <b>\{children\}<\/b> \}\)\}/);
  assert.match(result.code, /\{m\.pronoun\(\{ gender \}\)\}/);
  assert.match(result.code, /\{m\.messages\.you\(\{ n \}\)\}/);
  // A <Trans> in a case is part of the choice: its placeholders continue the numbering.
  assert.match(result.code, /\{m\.rows\.selected\(\{ 0: table\.rows\.length, 1: table\.selected\.length, 2: table\.selected\.length \}\)\}/);
  assert.equal(result.replacements, 5);
  assert.deepEqual(result.skipped, []);
  parses(result.code);
});

test('a choice the catalog does not hold is reported once, with the ICU text it looked for', () => {
  const result = lingui(`import { Plural, Trans, plural } from '@lingui/react/macro';
export function Page({ n }) {
  return <>
    <Plural value={n} one={<Trans>One left</Trans>} other={<Trans># left</Trans>} />
    {plural(n, { one: '# day', other: '# days' })}
  </>;
}`);
  assert.deepEqual(result.skipped.map(item => [item.code, item.callee]), [['MESSAGE_ID_UNRESOLVED', 'plural()'], ['MESSAGE_ID_UNRESOLVED', '<Plural>']]);
  assert.match(result.skipped[1].reason, /"\{n, plural, one \{One left\} other \{# left\}\}"/);
  assert.equal(result.replacements, 0);
});

test('a choice that cannot be read statically is reported, not guessed', () => {
  const result = lingui(`import { plural } from '@lingui/core/macro';
import { Plural } from '@lingui/react/macro';
export function Page({ n, cases, props }) {
  return <>{plural(n, cases)}{plural(n, { ...cases, other: '#' })}<Plural {...props} /></>;
}`);
  assert.deepEqual(result.skipped.map(item => item.code), ['MANUAL_REVIEW', 'MANUAL_REVIEW', 'MANUAL_REVIEW']);
  assert.match(result.skipped[0].reason, /takes a value and an object of cases/);
  assert.match(result.skipped[1].reason, /spread or computed case/);
  assert.match(result.skipped[2].reason, /<Plural> spreads its props/);
});

test('select() and <Select> from other libraries are left alone', () => {
  const result = lingui(`import { Trans } from '@lingui/react/macro';
import { Select } from '@radix-ui/react-select';
import { select } from 'drizzle-orm';
export function Page({ value }) {
  const rows = select(users, { other: 'x' });
  return <><Select value={value} other="y" /><Trans>Hello world</Trans></>;
}`, { messageIdBySource: { 'Hello world': 'hello' } });
  assert.match(result.code, /const rows = select\(users, \{ other: 'x' \}\);/);
  assert.match(result.code, /<Select value=\{value\} other="y" \/>\{m\.hello\(\)\}/);
  assert.deepEqual(result.skipped, []);
});

test('Lingui 5 keeps the whitespace JSX renders and Lingui 4 normalizes it; either catalog resolves', () => {
  const body = `import { Trans, useLingui } from '@lingui/react/macro';
export function Page({ link, product }) {
  const { t } = useLingui();
  return <>
    <Trans>Reason for rejection: </Trans>
    <Trans comment="List formatting">
      {link},{' '}
    </Trans>
    {t\`Successfully updated product \` + product}
    {t\`Use this field to add terms
        and conditions.\`}
  </>;
}`;
  const exact = lingui(body, { messageIdBySource: { 'Reason for rejection: ': 'reason', '{link}, ': 'list', 'Successfully updated product ': 'updated', 'Use this field to add terms\n        and conditions.': 'terms' } });
  const normalized = lingui(body, { messageIdBySource: { 'Reason for rejection:': 'reason', '{link},': 'list', 'Successfully updated product': 'updated', 'Use this field to add terms\nand conditions.': 'terms' } });
  for (const result of [exact, normalized]) {
    assert.deepEqual(result.skipped, []);
    assert.match(result.code, /\{m\.reason\(\)\}\s*\{m\.list\(\{ link \}\)\}\s*\{m\.updated\(\) \+ product\}\s*\{m\.terms\(\)\}/);
  }
});
