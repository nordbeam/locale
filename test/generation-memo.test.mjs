import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { temporary } from './helpers.mjs';

const execFile = promisify(execFileCallback);
const traceCount = (text, kind) => (text.match(new RegExp(`Nordbeam Locale: ${kind} generation generate`, 'g')) ?? []).length;

test('Vite shared client and SSR environments generate once per unchanged input stamp', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'messages')); await mkdir(join(root, 'src'));
  await writeFile(join(root, 'index.html'), '<script type="module" src="/src/main.js"></script>');
  await writeFile(join(root, 'src/main.js'), 'import {hello} from "./i18n/locales/en.js"; console.log(hello);');
  await writeFile(join(root, 'messages/en.json'), '{"hello":"Hello"}');
  const script = `import {build} from 'vite'; import {nordbeamLocale} from './dist/vite.js'; await build({root:${JSON.stringify(root)},configFile:false,logLevel:'silent',builder:{sharedPlugins:true},plugins:[nordbeamLocale({baseLocale:'en'})],environments:{client:{},ssr:{build:{ssr:true},rollupOptions:{input:${JSON.stringify(join(root, 'src/main.js'))}}}}});`;
  const { stderr } = await execFile(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), env: { ...process.env, NORDBEAM_LOCALE_TRACE_GENERATION: '1' } });
  assert.equal(traceCount(stderr, 'vite'), 1);
});

test('Next config calls share one generation while inputs remain unchanged', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'messages'));
  await writeFile(join(root, 'messages/en.json'), '{"hello":"Hello"}');
  const script = `import {withNordbeamLocale} from './dist/next.js'; const configure=withNordbeamLocale({}, {root:${JSON.stringify(root)}}); await Promise.all([configure('phase-production-build',{}),configure('phase-production-build',{}),configure('phase-production-build',{})]);`;
  const { stderr } = await execFile(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), env: { ...process.env, NORDBEAM_LOCALE_TRACE_GENERATION: '1' } });
  assert.equal(traceCount(stderr, 'next'), 1);
});

test('Next generation memo invalidates after a catalog edit', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'messages'));
  const catalog = join(root, 'messages/en.json');
  await writeFile(catalog, '{"hello":"Hello"}');
  const script = `import {withNordbeamLocale} from './dist/next.js'; import {writeFile} from 'node:fs/promises'; const configure=withNordbeamLocale({}, {root:${JSON.stringify(root)}}); await configure('phase-production-build',{}); await writeFile(${JSON.stringify(catalog)},'{"hello":"Welcome"}'); await configure('phase-production-build',{});`;
  const { stderr } = await execFile(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), env: { ...process.env, NORDBEAM_LOCALE_TRACE_GENERATION: '1' } });
  assert.equal(traceCount(stderr, 'next'), 2);
});

test('Next generation memo invalidates after a discovered config edit', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'messages'));
  await writeFile(join(root, 'messages/en.json'), '{"hello":"Hello"}');
  const config = join(root, 'nordbeam-i18n.config.json');
  await writeFile(config, '{"outDir":"generated-a"}');
  const script = `import {withNordbeamLocale} from './dist/next.js'; import {writeFile} from 'node:fs/promises'; const configure=withNordbeamLocale({}, {root:${JSON.stringify(root)}}); await configure('phase-production-build',{}); await writeFile(${JSON.stringify(config)},'{"outDir":"generated-b"}'); await configure('phase-production-build',{});`;
  const { stderr } = await execFile(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), env: { ...process.env, NORDBEAM_LOCALE_TRACE_GENERATION: '1' } });
  assert.equal(traceCount(stderr, 'next'), 2);
});

test('Next generation memo repairs deleted generated output', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'messages'));
  await writeFile(join(root, 'messages/en.json'), '{"hello":"Hello"}');
  const generated = join(root, 'src/i18n/index.js');
  const script = `import {withNordbeamLocale} from './dist/next.js'; import {unlink} from 'node:fs/promises'; const configure=withNordbeamLocale({}, {root:${JSON.stringify(root)}}); await configure('phase-production-build',{}); await unlink(${JSON.stringify(generated)}); await configure('phase-production-build',{});`;
  const { stderr } = await execFile(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), env: { ...process.env, NORDBEAM_LOCALE_TRACE_GENERATION: '1' } });
  assert.equal(traceCount(stderr, 'next'), 2);
});
