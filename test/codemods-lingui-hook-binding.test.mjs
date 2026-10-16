import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '@babel/parser';
import { codemodSource } from '@nordbeam/locale-migrate/codemods';

// <Trans> needs no hook, so a component that only rendered it has no useLingui() declaration
// for the hook binding to replace; the codemod binds m at the top of that component instead.
const lingui = (body) => codemodSource(body, 'lingui', { filename: 'page.tsx', messageIds: ['a.banner', 'a.title'], messagesImport: '@i18n/client', messagesHook: 'useMessages' });
const parses = code => parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });

test('a component that only rendered <Trans> gets its own binding beside one the file already has', () => {
  const result = lingui(`import { Trans, useLingui } from '@lingui/react';

export function Outer({ days }) {
  return <div><Trans id="a.banner" message="Banner {days}" values={{ days }} /><Inner /></div>;
}

function Inner() {
  const { i18n } = useLingui();
  return <p>{i18n._({ id: 'a.title', message: 'Title' })}</p>;
}
`);
  assert.equal(result.code, `import { useMessages } from '@i18n/client';

export function Outer({ days }) {
  const m = useMessages();
  return <div>{m.a.banner({ days })}<Inner /></div>;
}

function Inner() {
  const m = useMessages();
  return <p>{m.a.title()}</p>;
}
`);
  assert.deepEqual(result.skipped, []);
});

test('arrow, memo and nested-callback components are bound once, at their top', () => {
  const result = lingui(`'use client';
import { memo } from 'react';
import { Trans } from '@lingui/react';

export const Banner = ({ days }) => (
  <Trans id="a.banner" message="Banner {days}" values={{ days }} />
);

export const Title = memo(function Title() {
  return <h1><Trans id="a.title" message="Title" /></h1>;
});

export function List({ items }) {
  return <ul>{items.map((days) => <li key={days}><Trans id="a.banner" message="Banner {days}" values={{ days }} /><Trans id="a.title" /></li>)}</ul>;
}
`);
  assert.match(result.code, /^'use client';\nimport \{ useMessages \} from '@i18n\/client';\n/);
  assert.match(result.code, /export const Banner = \(\{ days \}\) => \{\n {2}const m = useMessages\(\);\n {2}return \(\n {2}m\.a\.banner\(\{ days \}\)\n\);\n\};/);
  assert.match(result.code, /memo\(function Title\(\) \{\n {2}const m = useMessages\(\);\n {2}return <h1>\{m\.a\.title\(\)\}<\/h1>;/);
  assert.match(result.code, /export function List\(\{ items \}\) \{\n {2}const m = useMessages\(\);\n {2}return <ul>\{items\.map\(\(days\) => <li key=\{days\}>\{m\.a\.banner\(\{ days \}\)\}\{m\.a\.title\(\)\}<\/li>\)\}<\/ul>;/);
  assert.equal(result.code.match(/useMessages\(\)/g).length, 3);
  assert.deepEqual(result.skipped, []);
  parses(result.code);
});

test('a parameter default does not add a second binding to a body that has one', () => {
  const result = codemodSource(`import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';

export function Combobox({ placeholder = t\`Select values...\` }) {
  const { _ } = useLingui();
  return <p title={placeholder}><Trans>No value found.</Trans></p>;
}
`, 'lingui', { filename: 'combobox.tsx', messageIdBySource: { 'Select values...': 'combo.placeholder', 'No value found.': 'combo.empty' }, messagesImport: '@i18n/client', messagesHook: 'useMessages' });
  // The default runs before the body, so it stays unbound for the caller; the cleanup still applies.
  assert.equal(result.code, `import { useMessages } from '@i18n/client';

export function Combobox({ placeholder = m.combo.placeholder() }) {
  const m = useMessages();
  return <p title={placeholder}>{m.combo.empty()}</p>;
}
`);
});

test('module scope and async server components are left for the caller to bind', () => {
  const source = `import { Trans } from '@lingui/react';

export const columns = [{ render: () => <Trans id="a.title" message="Title" /> }];

export default async function Page() {
  return <Trans id="a.banner" message="Banner {days}" values={{ days: 1 }} />;
}
`;
  const result = lingui(source);
  // Hooks cannot run there, so no binding (and no hook import) is added.
  assert.doesNotMatch(result.code, /useMessages/);
  assert.match(result.code, /render: \(\) => m\.a\.title\(\)/);
  assert.match(result.code, /return m\.a\.banner\(\{ days: 1 \}\);/);
});
