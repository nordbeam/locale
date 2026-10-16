import test from 'node:test';
import assert from 'node:assert/strict';
import { codemodSource } from '@nordbeam/locale-migrate/codemods';

// Prettier 3 ends every multi-line argument list with a comma (`trailingComma: "all"`).
const component = (imports, hook, call) => `${imports}\nexport function Card({ n }) {\n  ${hook}\n  return ${call};\n}\n`;

test('a trailing comma after the last argument converts the call in every format', () => {
  const intl = codemodSource(component(`import { useIntl } from 'react-intl';`, 'const intl = useIntl();', `intl.formatMessage(
    { id: 'card.count', defaultMessage: '{n} items' },
    { n: intl.formatNumber(n) },
  )`), 'react-intl', { filename: 'card.tsx' });
  assert.deepEqual(intl.skipped, []);
  assert.match(intl.code, /return m\.card\.count\(\{ n: intl\.formatNumber\(n\) \}\);/);

  const i18next = codemodSource(component(`import { useTranslation } from 'react-i18next';`, 'const { t } = useTranslation();', `t(\n    'card.count',\n    { count: n },\n  )`), 'react-i18next', { filename: 'card.tsx' });
  assert.deepEqual(i18next.skipped, []);
  assert.match(i18next.code, /return m\.card\.count\(\{count: n\}\);/);

  const nextIntl = codemodSource(component(`import { useTranslations } from 'next-intl';`, `const t = useTranslations('card');`, `t('count', { n },)`), 'next-intl', { filename: 'card.tsx' });
  assert.deepEqual(nextIntl.skipped, []);
  assert.match(nextIntl.code, /return m\.card\.count\(\{ n \}\);/);

  const lingui = codemodSource(component(`import { useLingui } from '@lingui/react';`, 'const { i18n } = useLingui();', `i18n._(\n    { id: 'card.count', values: { n } },\n  )`), 'lingui', { filename: 'card.tsx' });
  assert.deepEqual(lingui.skipped, []);
  assert.match(lingui.code, /m\.card\.count\(\{ n \}\)/);
});

test('a trailing comma inside an i18next options object does not leave an empty field', () => {
  const result = codemodSource(component(`import { useTranslation } from 'react-i18next';`, 'const { t } = useTranslation();', `t('card.count', { count: n, ns: 'common', })`), 'react-i18next', { filename: 'card.tsx' });
  assert.deepEqual(result.skipped, []);
  assert.match(result.code, /return m\.common\.card\.count\(\{count: n\}\);|return m\.card\.count\(\{count: n\}\);/);
});

test('a real third argument is still reported', () => {
  const result = codemodSource(component(`import { useTranslation } from 'react-i18next';`, 'const { t } = useTranslation();', `t('card.count', '{{count}} items', { count: n })`), 'react-i18next', { filename: 'card.tsx' });
  assert.deepEqual(result.skipped.map(item => item.reason), ['call has unsupported extra arguments']);
});
