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
