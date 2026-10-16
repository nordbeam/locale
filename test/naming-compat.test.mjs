import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { access, mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { createPlan, parsePlan, serializePlan, PlanApplyError } from '../dist/plan-apply.js';
import { generate } from '../dist/project.js';
import { inspectProject } from '../dist/inspect.js';
import { temporary } from './helpers.mjs';

const execFile = promisify(execFileCallback);

async function fixture(t) {
  const root = await temporary(t);
  await mkdir(join(root, 'messages'));
  await writeFile(join(root, 'messages/en.json'), JSON.stringify({ greeting: 'Hello {name}', farewell: 'Bye' }));
  return root;
}

test('an output generated under the legacy manifest name stays owned and is migrated by the next write', async t => {
  const root = await fixture(t);
  const options = { root, baseLocale: 'en', outDir: 'generated' };
  await generate(options);
  const current = join(root, 'generated/.nordbeam-locale-manifest.json');
  const legacy = join(root, 'generated/.nordbeam-i18n-manifest.json');
  await rename(current, legacy);

  await writeFile(join(root, 'messages/en.json'), JSON.stringify({ greeting: 'Hi {name}' }));
  const next = await generate(options);
  assert.ok(next.changed.length > 0);
  await access(current);
  await assert.rejects(access(legacy), { code: 'ENOENT' });
  assert.deepEqual((await readdir(join(root, 'generated'))).filter(name => name.includes('manifest')), ['.nordbeam-locale-manifest.json']);
});

test('a legacy-named output still removes files that dropped out of the project', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'messages/fr.json'), JSON.stringify({ greeting: 'Salut {name}', farewell: 'Au revoir' }));
  const options = { root, baseLocale: 'en', outDir: 'generated' };
  const initial = await generate(options);
  const legacy = join(initial.outDir, '.nordbeam-i18n-manifest.json');
  await rename(join(initial.outDir, '.nordbeam-locale-manifest.json'), legacy);
  await unlink(join(root, 'messages/fr.json'));
  await generate(options);
  await assert.rejects(access(join(initial.outDir, 'locales/fr.js')), { code: 'ENOENT' });
  await assert.rejects(access(legacy), { code: 'ENOENT' });
  await access(join(initial.outDir, '.nordbeam-locale-manifest.json'));
});

test('a legacy manifest is reported as owned by inspection', async t => {
  const root = await fixture(t);
  await generate({ root, baseLocale: 'en', outDir: 'generated' });
  await rename(join(root, 'generated/.nordbeam-locale-manifest.json'), join(root, 'generated/.nordbeam-i18n-manifest.json'));
  const inspected = await inspectProject({ root, baseLocale: 'en', outDir: 'generated' }, join(root, 'nordbeam-locale.config.json'));
  assert.equal(inspected.generated.manifestExists, true);
  assert.equal(inspected.generated.manifestValid, true);
  assert.equal(inspected.generated.manifest, join(root, 'generated/.nordbeam-i18n-manifest.json'));
});

test('the persistent cache defaults to node_modules/.cache/nordbeam-locale', async t => {
  const root = await fixture(t);
  await generate({ root, baseLocale: 'en', outDir: 'generated', persistentCache: true });
  assert.ok((await readdir(join(root, 'node_modules/.cache/nordbeam-locale'))).length > 0);
  await assert.rejects(access(join(root, 'node_modules/.cache/nordbeam-i18n')), { code: 'ENOENT' });
});

test('inspection recognizes the legacy Vite and Next wrapper names as configured', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'vite.config.ts'), "import { nordbeamI18n } from 'nordbeam-locale/vite';\nexport default { plugins: [nordbeamI18n()] };\n");
  await writeFile(join(root, 'next.config.mjs'), "import { withNordbeamI18n } from '@nordbeam/locale/next';\nexport default withNordbeamI18n({});\n");
  const inspected = await inspectProject({ root, baseLocale: 'en', outDir: 'generated' }, join(root, 'nordbeam-locale.config.json'));
  const byKind = Object.fromEntries(inspected.integrations.map(item => [item.kind, item.configured]));
  assert.equal(byKind.next, true);
  assert.equal(byKind['vite-react'], true);
});

test('the legacy trace variable still enables generation traces', async t => {
  const root = await fixture(t);
  const script = `import {withNordbeamLocale} from './dist/next.js'; const configure=withNordbeamLocale({}, {root:${JSON.stringify(root)}}); await configure('phase-production-build',{});`;
  const { stderr } = await execFile(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), env: { ...process.env, NORDBEAM_I18N_TRACE_GENERATION: '1', NORDBEAM_LOCALE_TRACE_GENERATION: '' } });
  assert.match(stderr, /Nordbeam Locale: next generation generate/);
});

test('plans written with the legacy tool version still parse and apply', async t => {
  const root = await temporary(t);
  const legacy = await createPlan({ root, toolVersion: 'nordbeam-i18n/plan-apply/1', changes: [{ path: 'generated.ts', content: 'x\n' }] });
  assert.equal(legacy.toolVersion, 'nordbeam-i18n/plan-apply/1');
  assert.deepEqual(parsePlan(serializePlan(legacy)), legacy);
  const current = await createPlan({ root, changes: [{ path: 'generated.ts', content: 'x\n' }] });
  assert.equal(current.toolVersion, 'nordbeam-locale/plan-apply/1');
  assert.deepEqual(parsePlan(serializePlan(current)), current);
  const unknown = await createPlan({ root, toolVersion: 'nordbeam-other/plan-apply/1', changes: [{ path: 'generated.ts', content: 'x\n' }] });
  assert.throws(() => parsePlan(serializePlan(unknown)), error => error instanceof PlanApplyError && error.code === 'INVALID_PLAN');
});
