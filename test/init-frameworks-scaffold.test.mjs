import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { detectFramework, initialize } from '../dist/init.js';
import { temporary } from './helpers.mjs';

const cli = (root, ...args) => spawnSync(process.execPath, [resolve('dist/cli.js'), ...args], { cwd: root, encoding: 'utf8' });
const ok = result => assert.equal(result.status, 0, result.stdout + result.stderr);
const exists = file => access(file).then(() => true, () => false);

async function project(t, packageJson) {
  const root = await temporary(t);
  if (packageJson) await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'app', private: true, ...packageJson }, null, 2));
  return root;
}

async function run(root, framework) {
  const configFile = join(root, 'nordbeam-locale.config.json');
  return initialize({ root, baseLocale: 'en', catalogs: 'messages', outDir: 'src/i18n' }, configFile, await exists(configFile), framework);
}

const components = {
  vue: { dependency: 'vue', plugin: '@vitejs/plugin-vue', call: 'vue()', statement: "import vue from '@vitejs/plugin-vue';" },
  svelte: { dependency: 'svelte', plugin: '@sveltejs/vite-plugin-svelte', call: 'svelte()', statement: "import { svelte } from '@sveltejs/vite-plugin-svelte';" },
  solid: { dependency: 'solid-js', plugin: 'vite-plugin-solid', call: 'solid()', statement: "import solid from 'vite-plugin-solid';" },
};

test('detectFramework maps dependency combinations to scaffolds', async t => {
  const cases = [
    [{ dependencies: { next: '16.0.0', vite: '8.2.2', react: '19.2.0' } }, 'next'],
    [{ devDependencies: { vite: '8.2.2', svelte: '5.0.0' } }, 'svelte'],
    [{ devDependencies: { vite: '8.2.2', '@sveltejs/kit': '2.0.0' } }, 'svelte'],
    [{ devDependencies: { vite: '8.2.2', vue: '3.5.0' } }, 'vue'],
    [{ peerDependencies: { vite: '8.2.2', 'solid-js': '1.9.0' } }, 'solid'],
    [{ dependencies: { vite: '8.2.2', react: '19.2.0' } }, 'vite-react'],
    [{ devDependencies: { vite: '8.2.2' } }, 'vite-react'],
    [{ dependencies: { vite: '8.2.2', vue: '3.5.0', react: '19.2.0' } }, 'vue'],
    [{ dependencies: { react: '19.2.0' } }, undefined],
    [{ dependencies: { vue: '3.5.0' } }, undefined],
    [{ dependencies: {} }, undefined],
  ];
  for (const [packageJson, expected] of cases) {
    const root = await project(t, packageJson);
    assert.equal(await detectFramework(root), expected, JSON.stringify(packageJson));
  }
  assert.equal(await detectFramework(await project(t)), undefined);
  const malformed = await project(t);
  await writeFile(join(malformed, 'package.json'), '{ "dependencies": ');
  assert.equal(await detectFramework(malformed), undefined);
});

for (const [framework, { dependency, plugin, call, statement }] of Object.entries(components)) {
  test(`init scaffolds ${framework} adapter and a Vite config with its plugin`, async t => {
    const root = await project(t, { devDependencies: { vite: '8.2.2', [dependency]: '1.0.0', [plugin]: '1.0.0' } });
    const result = await run(root, framework);
    assert.equal(result.framework, framework);
    assert.deepEqual(result.frameworkCreated.map(file => file.slice(root.length + 1)).sort(), ['src/i18n/' + framework + '.ts', 'vite.config.ts'].sort());
    assert.deepEqual(result.frameworkExisting, []);
    assert.deepEqual(result.frameworkNotes, []);

    const adapter = await readFile(join(root, 'src/i18n', `${framework}.ts`), 'utf8');
    assert.match(adapter, new RegExp(`from '@nordbeam/locale/${framework}'`));
    assert.match(adapter, /from '\.\/index';\nimport messages from '\.\/locales\/en';/);
    assert.match(adapter, /export const i18n = create\w+I18n\(\{ initial: \{ locale: baseLocale, messages \}, loadLocale \}\);/);
    assert.doesNotMatch(adapter, /await/);

    const config = await readFile(join(root, 'vite.config.ts'), 'utf8');
    assert.ok(config.includes(statement), config);
    assert.match(config, /import \{ nordbeamLocale \} from 'nordbeam-locale\/vite';/);
    assert.match(config, new RegExp(`plugins: \\[${call.replace('(', '\\(').replace(')', '\\)')}, nordbeamLocale\\(\\)\\]`));
  });

  test(`init ${framework} without its Vite plugin creates the adapter and a next-step note but no config`, async t => {
    const root = await project(t, { devDependencies: { vite: '8.2.2', [dependency]: '1.0.0' } });
    const result = await run(root, framework);
    assert.deepEqual(result.frameworkCreated.map(file => file.slice(root.length + 1)), ['src/i18n/' + framework + '.ts']);
    assert.equal(await exists(join(root, 'vite.config.ts')), false);
    assert.equal(result.frameworkNotes.length, 1);
    assert.match(result.frameworkNotes[0], new RegExp(`Install ${plugin.replace(/[/.]/g, '\\$&')}, then add ${call.replace(/[()]/g, '\\$&')} and nordbeamLocale\\(\\)`));
  });

  test(`init ${framework} preserves an existing Vite config and re-runs report existing files`, async t => {
    const root = await project(t, { devDependencies: { vite: '8.2.2', [dependency]: '1.0.0', [plugin]: '1.0.0' } });
    await writeFile(join(root, 'vite.config.mjs'), 'export default {}\n');
    const first = await run(root, framework);
    assert.deepEqual(first.frameworkExisting, [join(root, 'vite.config.mjs')]);
    assert.deepEqual(first.frameworkCreated.map(file => file.slice(root.length + 1)), ['src/i18n/' + framework + '.ts']);
    assert.equal(await readFile(join(root, 'vite.config.mjs'), 'utf8'), 'export default {}\n');
    assert.equal(await exists(join(root, 'vite.config.ts')), false);

    const adapter = await readFile(join(root, 'src/i18n', `${framework}.ts`), 'utf8');
    const again = await run(root, framework);
    assert.deepEqual(again.frameworkCreated, []);
    assert.deepEqual(again.frameworkExisting.map(file => file.slice(root.length + 1)).sort(), ['src/i18n/' + framework + '.ts', 'vite.config.mjs']);
    assert.equal(await readFile(join(root, 'src/i18n', `${framework}.ts`), 'utf8'), adapter);
  });
}

test('init with a Vite plugin config is idempotent and keeps an app-owned adapter', async t => {
  const root = await project(t, { devDependencies: { vite: '8.2.2', svelte: '5.0.0', '@sveltejs/vite-plugin-svelte': '1.0.0' } });
  await run(root, 'svelte');
  const edited = '// app-owned\n' + await readFile(join(root, 'src/i18n/svelte.ts'), 'utf8');
  await writeFile(join(root, 'src/i18n/svelte.ts'), edited);
  const again = await run(root, 'svelte');
  assert.deepEqual(again.frameworkCreated, []);
  assert.equal(await readFile(join(root, 'src/i18n/svelte.ts'), 'utf8'), edited);
});

test('init without --framework detects the component framework and scaffolds it', async t => {
  const root = await project(t, { devDependencies: { vite: '8.2.2', vue: '3.5.0', '@vitejs/plugin-vue': '6.0.0' } });
  const result = cli(root, 'init');
  ok(result);
  assert.match(result.stdout, /^Created src\/i18n\/vue\.ts$/m);
  assert.match(result.stdout, /^Created vite\.config\.ts$/m);
  assert.match(await readFile(join(root, 'vite.config.ts'), 'utf8'), /plugins: \[vue\(\), nordbeamLocale\(\)\]/);
  assert.match(await readFile(join(root, 'src/i18n/vue.ts'), 'utf8'), /createVueI18n/);
});
