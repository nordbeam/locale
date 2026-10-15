import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { detectFramework, initialize, planInitialize } from '../dist/init.js';
import { temporary } from './helpers.mjs';

const cli = (root, ...args) => spawnSync(process.execPath, [resolve('dist/cli.js'), ...args], { cwd: root, encoding: 'utf8' });
const exists = file => access(file).then(() => true, () => false);
const relativeTo = root => file => file.slice(root.length + 1);

async function project(t, dependencies = { '@tanstack/react-start': '1.169.2', '@tanstack/react-router': '1.170.44', '@vitejs/plugin-react': '6.1.2', vite: '8.2.2' }) {
  const root = await temporary(t);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'app', private: true, dependencies }, null, 2));
  return root;
}

async function run(root, framework = 'tanstack-start') {
  const configFile = join(root, 'nordbeam-locale.config.json');
  return initialize({ root, baseLocale: 'en', catalogs: 'messages', outDir: 'src/i18n' }, configFile, await exists(configFile), framework);
}

async function write(root, file, text) {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), text);
}

test('detectFramework finds TanStack Start, and Next.js still wins when both are present', async t => {
  assert.equal(await detectFramework(await project(t)), 'tanstack-start');
  assert.equal(await detectFramework(await project(t, { '@tanstack/react-start': '1.169.2' })), 'tanstack-start');
  assert.equal(await detectFramework(await project(t, { '@tanstack/react-router': '1.170.44', vite: '8.2.2', react: '19.2.0' })), 'vite-react');
  assert.equal(await detectFramework(await project(t, { next: '16.0.0', '@tanstack/react-start': '1.169.2' })), 'next');
});

test('init scaffolds the i18n modules, the Vite config and the three wiring files', async t => {
  const root = await project(t);
  const result = await run(root);
  assert.equal(result.framework, 'tanstack-start');
  assert.deepEqual(result.frameworkCreated.map(relativeTo(root)).sort(), [
    'src/i18n/routing.ts', 'src/i18n/tanstack.ts', 'src/router.tsx', 'src/routes/__root.tsx', 'src/start.ts', 'vite.config.ts',
  ]);
  assert.deepEqual(result.frameworkExisting, []);
  assert.deepEqual(result.frameworkNotes, []);

  const routing = await readFile(join(root, 'src/i18n/routing.ts'), 'utf8');
  assert.match(routing, /import \{ defineRouting \} from '@nordbeam\/locale\/tanstack-start';/);
  assert.match(routing, /import \{ baseLocale, locales \} from '\.\/index';/);
  assert.match(routing, /localePrefix: 'as-needed'/);
  const module = await readFile(join(root, 'src/i18n/tanstack.ts'), 'utf8');
  assert.match(module, /export const i18n = createTanStackStartI18n\(\{ routing, loadLocale \}\);/);
  assert.match(module, /from '\.\/routing';/);

  const config = await readFile(join(root, 'vite.config.ts'), 'utf8');
  assert.match(config, /plugins: \[nordbeamLocale\(\), tanstackStart\(\), viteReact\(\)\]/);
  assert.match(config, /from '@tanstack\/react-start\/plugin\/vite'/);

  assert.match(await readFile(join(root, 'src/start.ts'), 'utf8'), /import \{ routing \} from '\.\/i18n\/routing';[\s\S]*requestMiddleware: \[createLocaleMiddleware\(routing\)\][\s\S]*functionMiddleware: \[createLocaleFunctionMiddleware\(\)\]/);
  assert.match(await readFile(join(root, 'src/router.tsx'), 'utf8'), /import \{ i18n \} from '\.\/i18n\/tanstack';[\s\S]*\.\.\.i18n\.routerOptions\(\)/);
  const rootRoute = await readFile(join(root, 'src/routes/__root.tsx'), 'utf8');
  assert.match(rootRoute, /import \{ i18n \} from '\.\.\/i18n\/tanstack';/);
  assert.match(rootRoute, /beforeLoad: i18n\.beforeLoad/);
  assert.match(rootRoute, /<html \{\.\.\.i18n\.useHtmlAttributes\(\)\}>/);
  assert.match(rootRoute, /<i18n\.Provider><Outlet \/><\/i18n\.Provider>/);
});

test('init never overwrites application files and tells the user exactly what to change', async t => {
  const root = await project(t);
  const files = {
    'vite.config.ts': "import { defineConfig } from 'vite';\nexport default defineConfig({ plugins: [] });\n",
    'src/start.ts': "import { createStart } from '@tanstack/react-start';\nexport const startInstance = createStart(() => ({}));\n",
    'src/router.tsx': "export function getRouter() { return null; }\n",
    'src/routes/__root.tsx': "export const Route = null;\n",
  };
  for (const [file, text] of Object.entries(files)) await write(root, file, text);
  const result = await run(root);
  assert.deepEqual(result.frameworkCreated.map(relativeTo(root)).sort(), ['src/i18n/routing.ts', 'src/i18n/tanstack.ts']);
  assert.deepEqual(result.frameworkExisting.map(relativeTo(root)).sort(), Object.keys(files).sort());
  for (const [file, text] of Object.entries(files)) assert.equal(await readFile(join(root, file), 'utf8'), text, file);

  assert.equal(result.frameworkNotes.length, 4);
  const [vite, start, router, route] = result.frameworkNotes;
  assert.match(vite, /Add nordbeamLocale\(\) from @nordbeam\/locale\/vite to the plugins in vite\.config\.ts, before tanstackStart\(\)/);
  assert.match(start, /In src\/start\.ts, register the locale middleware: .*from '\.\/i18n\/routing'.*requestMiddleware: \[createLocaleMiddleware\(routing\)\]/);
  assert.match(router, /In src\/router\.tsx, spread the locale options into createRouter: import \{ i18n \} from '\.\/i18n\/tanstack'; createRouter\(\{ routeTree, \.\.\.i18n\.routerOptions\(\) \}\)/);
  assert.match(route, /In src\/routes\/__root\.tsx, import \{ i18n \} from '\.\.\/i18n\/tanstack' and: .*beforeLoad: i18n\.beforeLoad.*useHtmlAttributes\(\).*<i18n\.Provider>/);
});

test('files that are already wired produce no notes, on the first run and on a re-run', async t => {
  const root = await project(t);
  await run(root);
  const again = await run(root);
  assert.deepEqual(again.frameworkCreated, []);
  assert.equal(again.frameworkExisting.length, 6);
  assert.deepEqual(again.frameworkNotes, []);
});

test('a missing react plugin is a note, not a Vite config', async t => {
  const root = await project(t, { '@tanstack/react-start': '1.169.2', vite: '8.2.2' });
  const result = await run(root);
  assert.equal(await exists(join(root, 'vite.config.ts')), false);
  assert.deepEqual(result.frameworkNotes.map(note => note.split(',')[0]), ['Install @vitejs/plugin-react']);
});

test('scaffold imports are relative to a custom output directory', async t => {
  const root = await project(t);
  const configFile = join(root, 'nordbeam-locale.config.json');
  await initialize({ root, baseLocale: 'en', catalogs: 'messages', outDir: 'src/lib/generated/i18n' }, configFile, false, 'tanstack-start');
  assert.match(await readFile(join(root, 'src/start.ts'), 'utf8'), /from '\.\/lib\/generated\/i18n\/routing';/);
  assert.match(await readFile(join(root, 'src/routes/__root.tsx'), 'utf8'), /from '\.\.\/lib\/generated\/i18n\/tanstack';/);
});

test('the init preview lists the scaffold without writing it', async t => {
  const root = await project(t);
  const plan = await planInitialize({ root, baseLocale: 'en', catalogs: 'messages', outDir: 'src/i18n' }, { en: { hello: 'Hello' } }, '{"hello":"Hello"}', join(root, 'nordbeam-locale.config.json'), false, 'tanstack-start');
  assert.deepEqual(plan.scaffold.map(relativeTo(root)).sort(), ['src/i18n/routing.ts', 'src/i18n/tanstack.ts', 'src/router.tsx', 'src/routes/__root.tsx', 'src/start.ts', 'vite.config.ts']);
  assert.equal(await exists(join(root, 'src/start.ts')), false);
});

test('init --framework tanstack-start reports the scaffold and the notes on the command line', async t => {
  const root = await project(t);
  await write(root, 'src/start.ts', "export const startInstance = null;\n");
  const result = cli(root, 'init', '--framework', 'tanstack-start');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^Created src\/i18n\/tanstack\.ts$/m);
  assert.match(result.stdout, /^Preserved src\/start\.ts$/m);
  assert.match(result.stdout, /^Next: In src\/start\.ts, register the locale middleware/m);
  assert.match(result.stdout, /TanStack Start scaffold: import \{ i18n \} from "\.\/src\/i18n\/tanstack\.js"/);

  const detected = await project(t);
  const auto = cli(detected, 'init');
  assert.equal(auto.status, 0, auto.stdout + auto.stderr);
  assert.match(auto.stdout, /^Created src\/routes\/__root\.tsx$/m);

  const unknown = cli(root, 'init', '--framework', 'remix');
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /--framework must be .*"tanstack-start"/);
});

test('help and capabilities name the framework', () => {
  const help = cli(process.cwd(), 'init', '--help');
  assert.match(help.stdout, /--framework <next\|vite-react\|vue\|svelte\|solid\|tanstack-start>/);
  assert.match(help.stdout, /nordbeam-locale init --framework tanstack-start/);
  const capabilities = JSON.parse(cli(process.cwd(), 'capabilities', '--json').stdout);
  const init = capabilities.commands.find(command => command.name === 'init');
  assert.match(init.invocation, /tanstack-start/);
});
