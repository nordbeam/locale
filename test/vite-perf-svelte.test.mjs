import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { compile } from 'svelte/compiler';
import { nordbeamLocale } from '../dist/vite.js';
import { temporary } from './helpers.mjs';

// @sveltejs/vite-plugin-svelte is not installed. This stand-in compiles .svelte
// modules with the installed svelte compiler in a normal-order transform, which is
// where the real plugin runs, so nordbeamLocale (enforce: post) sees compiled JS.
const svelte = () => ({
  name: 'test-svelte',
  transform(code, id) {
    if (!/\.svelte(?:$|\?)/.test(id)) return;
    const { js } = compile(code, { filename: id, generate: 'client' });
    return { code: js.code, map: js.map };
  },
});

async function fixture(t) {
  const root = await temporary(t);
  await mkdir(join(root, 'messages'));
  await mkdir(join(root, 'src'));
  await symlink(join(dirname(fileURLToPath(import.meta.url)), '../node_modules'), join(root, 'node_modules'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'messages/en.json'), JSON.stringify({ greeting: 'Hello {name}', unused: 'EN_UNUSED_SENTINEL {value, number}', plain: 'UNUSED_LITERAL_SENTINEL' }));
  await writeFile(join(root, 'messages/fr.json'), JSON.stringify({ greeting: 'Bonjour {name}', unused: 'FR_UNUSED_SENTINEL {value, number}' }));
  return root;
}

test('Svelte components narrow loadLocale to the messages they use', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'src/Greeting.svelte'), `<script module>
  import { loadLocale } from './i18n/index.js';
  export async function load() {
    const { messages } = await loadLocale('en');
    return messages.greeting({ name: 'Ada' });
  }
</script>
<p>Greeting</p>
`);
  await writeFile(join(root, 'src/main.js'), `import { load } from './Greeting.svelte';\nglobalThis.load = load;\n`);
  await writeFile(join(root, 'index.html'), '<div id="app"></div><script type="module" src="/src/main.js"></script>');
  const result = await build({ root, configFile: false, logLevel: 'silent', plugins: [svelte(), nordbeamLocale({ baseLocale: 'en' })], build: { write: false, minify: true } });
  const all = result.output.filter(file => file.type === 'chunk').map(file => file.code).join('\n');
  assert.match(all, /Hello/);
  // Other locales keep their own (greeting-only) chunks; unselected messages never ship.
  assert.doesNotMatch(all, /UNUSED_SENTINEL/);
});
