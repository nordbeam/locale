import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { check, generate } from '../dist/project.js';
import { exportPo, importPo } from '../dist/translations.js';
import { renameMessage } from '../dist/cli-tools.js';
import { parsePo } from '../dist/po.js';
import { migrateCatalog } from '@nordbeam/locale-migrate/catalog';
import { temporary } from './helpers.mjs';

async function project(t, notes) {
  const root = await temporary(t);
  await mkdir(join(root, 'messages'));
  await writeFile(join(root, 'messages/en.json'), JSON.stringify({ checkout: { title: 'Checkout', pay: 'Pay {amount}' } }));
  await writeFile(join(root, 'messages/sv.json'), JSON.stringify({ checkout: { title: 'Kassa', pay: 'Betala {amount}' } }));
  if (notes !== undefined) await writeFile(join(root, 'messages.notes.json'), JSON.stringify(notes));
  return { root, options: { root, baseLocale: 'en', catalogs: 'messages', notes: 'messages.notes.json', outDir: 'src/i18n' } };
}

test('notes reach the generated hovers and PO exports, follow edits, and a stale note is a check warning', async t => {
  const { root, options } = await project(t, { checkout: { pay: 'Total with VAT,\nformatted by the caller.' } });
  await generate(options);
  const types = () => readFile(join(root, 'src/i18n/messages.d.ts'), 'utf8');
  assert.match(await types(), /\/\*\* Pay \{amount\} — en @remarks Total with VAT, formatted by the caller\. \*\//);
  // An unchanged catalog with changed notes must not reuse the recorded output.
  await writeFile(join(root, 'messages.notes.json'), JSON.stringify({ 'checkout.pay': 'Amount in SEK.', 'checkout.gone': 'Renamed away.' }));
  const result = await generate(options);
  assert.match(await types(), /@remarks Amount in SEK\. \*\//);
  assert.deepEqual(result.warnings.filter(item => item.code === 'UNKNOWN_NOTE').map(item => item.messageId), ['checkout.gone']);
  assert.deepEqual((await check(options)).warnings.filter(item => item.code === 'UNKNOWN_NOTE').map(item => item.messageId), ['checkout.gone']);

  const exported = await exportPo({ ...options, locale: 'sv' });
  assert.match(exported.po, /\n#\. Amount in SEK\.\nmsgctxt "checkout\.pay"\n/);
  assert.equal(parsePo(exported.po).entries.length, 2);
  await writeFile(join(root, 'sv.po'), exported.po);
  const imported = await importPo({ ...options, locale: 'sv', from: join(root, 'sv.po'), dryRun: true });
  assert.equal(imported.unchanged, 2);
});

test('rename moves the message note with the message', async t => {
  const { root, options } = await project(t, { checkout: { pay: 'Amount in SEK.' } });
  const result = await renameMessage({ ...options, from: 'checkout.pay', to: 'checkout.payNow' });
  assert.ok(result.changed.includes(join(root, 'messages.notes.json')));
  assert.deepEqual(JSON.parse(await readFile(join(root, 'messages.notes.json'), 'utf8')), { checkout: { payNow: 'Amount in SEK.' } });
});

test('a notes file in the catalog directory, or one that is not shaped like a catalog, is refused', async t => {
  const { root, options } = await project(t, { checkout: ['not', 'a', 'note'] });
  await assert.rejects(generate(options), error => error.diagnostics?.[0]?.code === 'INVALID_NOTES');
  assert.deepEqual((await check(options)).errors.map(item => item.code), ['INVALID_NOTES']);
  await writeFile(join(root, 'messages/notes.json'), '{}');
  await assert.rejects(generate({ ...options, notes: 'messages/notes.json' }), error => error.diagnostics?.[0]?.code === 'INVALID_NOTES');
});

test('migrate reads a TypeScript dictionary without running it, and keeps comments and descriptions as notes', async t => {
  const root = await temporary(t);
  await writeFile(join(root, 'en.ts'), `import type { Dictionary } from './types';
throw new Error('never runs');
const en = {
  // Heading on /pricing
  title: 'Prices for {plan}',
  cta: 'Buy', // Shown on the checkout button
  legal: {
    /** LEGAL-REVIEW: who can read bank data.
     * Plan D4. */
    body: 'Only you ' +
      \`and your accountant\`,
  },
  computed: label(),
  ...shared,
} as const satisfies Dictionary;
export default en;
`);
  const result = await migrateCatalog({ from: join(root, 'en.ts'), format: 'module', out: join(root, 'messages/en.json'), notes: join(root, 'messages.notes.json') });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'messages/en.json'), 'utf8')), { cta: 'Buy', legal: { body: 'Only you and your accountant' }, title: 'Prices for {plan}' });
  assert.deepEqual(JSON.parse(await readFile(join(root, 'messages.notes.json'), 'utf8')), {
    cta: 'Shown on the checkout button', 'legal.body': 'LEGAL-REVIEW: who can read bank data.\nPlan D4.', title: 'Heading on /pricing',
  });
  assert.deepEqual(result.warnings.map(item => item.code), ['MIGRATION_UNSUPPORTED_VALUE', 'MIGRATION_UNSUPPORTED_VALUE']);

  // FormatJS and ARB descriptions are notes too. Without --notes they are reported as dropped.
  await writeFile(join(root, 'formatjs.json'), JSON.stringify({ save: { defaultMessage: 'Save', description: 'Toolbar button' } }));
  await writeFile(join(root, 'app.arb'), JSON.stringify({ '@@locale': 'en', save: 'Save', '@save': { description: 'Toolbar button' } }));
  for (const [file, format] of [['formatjs.json', 'formatjs'], ['app.arb', 'arb']]) {
    const migrated = await migrateCatalog({ from: join(root, file), format });
    assert.deepEqual({ ...migrated.notes }, { save: 'Toolbar button' });
    assert.ok(migrated.warnings.some(item => item.code === 'MIGRATION_METADATA_DROPPED' && /1 note/.test(item.message)));
  }

  // An existing notes file is never replaced, and then the catalog is not written either.
  const again = await migrateCatalog({ from: join(root, 'en.ts'), format: 'module', out: join(root, 'messages/other.json'), notes: join(root, 'messages.notes.json') });
  assert.deepEqual(again.collisions.map(item => item.code), ['MIGRATION_OUTPUT_EXISTS']);
  await assert.rejects(readFile(join(root, 'messages/other.json')));
});
