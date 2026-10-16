import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import { compiled, temporary } from './helpers.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixtures = join(root, 'test/fixtures/svelte');
const svelteEntry = pathToFileURL(join(root, 'packages/locale/dist/svelte.js')).href;
const catalogs = {
  en: { greeting: 'Hello {name}', items: '{count, plural, one {# item} other {# items}}' },
  fr: { greeting: 'Bonjour {name}', items: '{count, plural, one {# article} other {# articles}}' },
};

// Compile the fixtures for server rendering. Their output lives in a temp
// directory whose node_modules links to the workspace, so `svelte` resolves to
// the same module instance the adapter uses.
async function components(t) {
  const dir = await temporary(t);
  await symlink(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
  for (const name of ['Root', 'Child', 'Orphan']) {
    const filename = join(fixtures, `${name}.svelte`);
    const source = (await readFile(filename, 'utf8')).replaceAll('@nordbeam/locale/svelte', svelteEntry);
    const { js } = compile(source, { generate: 'server', filename });
    const code = js.code.replace(/(['"])\.\/([A-Za-z]+)\.svelte\1/g, '$1./$2.js$1');
    await writeFile(join(dir, `${name}.js`), code);
  }
  const load = async name => (await import(pathToFileURL(join(dir, `${name}.js`)).href)).default;
  return { Root: await load('Root'), Orphan: await load('Orphan') };
}

const text = html => html.replace(/<!--.*?-->/gs, '').replace(/\s+/g, ' ').trim();

test('server components read $messages and $locale from the root context', async t => {
  const project = await compiled(t, { baseLocale: 'en', catalogs });
  const { loadLocale } = await project.load('index.js');
  const { Root } = await components(t);
  const initial = await loadLocale('en');
  const { body } = render(Root, { props: { initial, loadLocale } });
  assert.equal(text(body), '<main><p lang="en">Hello Ada / 2 items</p></main>');
});

test('concurrent server renders keep each request locale isolated', async t => {
  const project = await compiled(t, { baseLocale: 'en', catalogs });
  const { loadLocale } = await project.load('index.js');
  const { Root } = await components(t);
  const render$ = async locale => text(render(Root, {
    props: { initial: await loadLocale(locale), loadLocale },
  }).body);
  const bodies = await Promise.all([render$('en'), render$('fr'), render$('en')]);
  assert.deepEqual(bodies, [
    '<main><p lang="en">Hello Ada / 2 items</p></main>',
    '<main><p lang="fr">Bonjour Ada / 2 articles</p></main>',
    '<main><p lang="en">Hello Ada / 2 items</p></main>',
  ]);
});

test('a component without a root i18n context fails with a clear error', async t => {
  const { Orphan } = await components(t);
  // Svelte renders lazily: the body getter is what runs the component.
  assert.throws(() => render(Orphan, { props: {} }).body, /setI18nContext in a parent component/);
});
