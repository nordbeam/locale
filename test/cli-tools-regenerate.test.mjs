import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extractMessage, renameMessage } from '../dist/cli-tools.js';
import { generate } from '../dist/project.js';
import { temporary } from './helpers.mjs';

async function project(t, source) {
  const root = await temporary(t);
  await mkdir(join(root, 'messages')); await mkdir(join(root, 'src'));
  await writeFile(join(root, 'messages/en.json'), JSON.stringify({ hello: 'Hello', checkout: { pay: 'Pay now' } }, null, 2) + '\n');
  await writeFile(join(root, 'messages/fr.json'), JSON.stringify({ hello: 'Salut', checkout: { pay: 'Payer' } }, null, 2) + '\n');
  await writeFile(join(root, 'src/app.ts'), source);
  await generate({ root, baseLocale: 'en', catalogs: 'messages', outDir: 'generated' });
  return root;
}

test('rename warns about dynamic references it cannot rewrite and reports ids and locales', async t => {
  const source = [
    'm.checkout.pay();',
    'const key = `checkout.${step}`;',
    'const other = `hello.${step}`;',
    'const prefix = "checkout." + step;',
    '// `checkout.${step}` in a comment is prose',
  ].join('\n') + '\n';
  const root = await project(t, source);
  const result = await renameMessage({ root, baseLocale: 'en', catalogs: 'messages', outDir: 'generated', sourceDir: 'src', from: 'checkout.pay', to: 'checkout.submit' });
  assert.deepEqual(result.ids, [{ from: 'checkout.pay', to: 'checkout.submit' }]);
  assert.deepEqual(result.locales, ['en', 'fr']);
  const dynamic = result.warnings.filter(warning => warning.code === 'RENAME_DYNAMIC_REFERENCE');
  assert.equal(dynamic.length, 2);
  assert.deepEqual(dynamic.map(warning => warning.location.line), [2, 4]);
  assert.equal(dynamic[0].file, join(root, 'src/app.ts'));
  assert.equal(dynamic[0].location.column, 13);
  assert.equal(await readFile(join(root, 'src/app.ts'), 'utf8'), source.replace('m.checkout.pay()', 'm.checkout.submit()'));
});

test('rename without a dynamic reference returns no warnings', async t => {
  const root = await project(t, 'm.checkout.pay();\n');
  const result = await renameMessage({ root, baseLocale: 'en', catalogs: 'messages', outDir: 'generated', sourceDir: 'src', from: 'checkout.pay', to: 'checkout.submit' });
  assert.deepEqual(result.warnings, []);
});

test('rename marks output stale by default and regenerates it on request', async t => {
  const root = await project(t, 'm.checkout.pay();\n');
  const stale = await renameMessage({ root, baseLocale: 'en', catalogs: 'messages', outDir: 'generated', sourceDir: 'src', from: 'checkout.pay', to: 'checkout.submit' });
  assert.equal(stale.regenerated, false);
  assert.equal(stale.stale, true);
  assert.equal(stale.next, 'nordbeam-locale generate');
  assert.doesNotMatch(await readFile(join(root, 'generated/messages.d.ts'), 'utf8'), /checkout\.submit/);

  const fresh = await renameMessage({ root, baseLocale: 'en', catalogs: 'messages', outDir: 'generated', sourceDir: 'src', from: 'checkout.submit', to: 'checkout.confirm', regenerate: true });
  assert.equal(fresh.regenerated, true);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.next, undefined);
  assert.ok(fresh.generated.some(file => file === join(root, 'generated/messages.d.ts')));
  assert.match(await readFile(join(root, 'generated/messages.d.ts'), 'utf8'), /"checkout\.confirm"/);
});

test('extract marks output stale with a next command unless regeneration is requested', async t => {
  const root = await project(t, 'm.hello();\n');
  const stale = await extractMessage({ root, baseLocale: 'en', catalogs: 'messages', outDir: 'generated', id: 'checkout.total', message: 'Total' });
  assert.equal(stale.stale, true);
  assert.equal(stale.regenerated, false);
  assert.equal(stale.next, 'nordbeam-locale generate');
  assert.doesNotMatch(await readFile(join(root, 'generated/messages.d.ts'), 'utf8'), /checkout\.total/);

  const fresh = await extractMessage({ root, baseLocale: 'en', catalogs: 'messages', outDir: 'generated', id: 'checkout.cancel', message: 'Cancel', regenerate: true });
  assert.equal(fresh.stale, false);
  assert.equal(fresh.regenerated, true);
  assert.equal(fresh.next, undefined);
  const declarations = await readFile(join(root, 'generated/messages.d.ts'), 'utf8');
  assert.match(declarations, /"checkout\.cancel"/);
  assert.match(declarations, /"checkout\.total"/);
});
