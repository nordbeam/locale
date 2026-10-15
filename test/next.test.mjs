import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { withNordbeamLocale } from '../dist/next.js';
import { createNextI18n } from '../dist/next-runtime.js';
import { temporary } from './helpers.mjs';

async function withNodeEnv(value, run) {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = value;
  try { return await run(); }
  finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
}

test('withNordbeamLocale generates before returning static Next configuration', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'messages'));
  await writeFile(join(root, 'messages/en.json'), JSON.stringify({ greeting: 'Hello {name}' }));
  await writeFile(join(root, 'nordbeam-i18n.config.json'), JSON.stringify({ baseLocale: 'en', outDir: 'generated' }));
  const configure = withNordbeamLocale({ reactStrictMode: true }, { root });
  const result = await configure('phase-production-build', {});
  assert.deepEqual(result, { reactStrictMode: true });
  await access(join(root, 'generated/index.js'));
  assert.match(await readFile(join(root, 'generated/internal/locales/en.js'), 'utf8'), /Hello/);
});

test('withNordbeamLocale composes async config and explicit generation options', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'catalogs'));
  await writeFile(join(root, 'catalogs/en.json'), JSON.stringify({ greeting: 'Hello' }));
  const seen = [];
  const configure = withNordbeamLocale(async (phase, context) => {
    seen.push([phase, context]);
    return { poweredByHeader: false };
  }, { root, baseLocale: 'en', catalogs: 'catalogs', outDir: 'i18n' });
  const context = { defaultConfig: {} };
  assert.deepEqual(await configure('phase-development-server', context), { poweredByHeader: false });
  assert.deepEqual(seen, [['phase-development-server', context]]);
  await access(join(root, 'i18n/index.d.ts'));
});

test('withNordbeamLocale derives validation and its catalog watcher from the Next environment', async t => {
  const root = await temporary(t);
  const catalog = join(root, 'messages/en.json');
  const generated = join(root, 'generated/internal/locales/en.js');
  await mkdir(join(root, 'messages'));
  await writeFile(catalog, JSON.stringify({ greeting: 'Hello {name}' }));
  await writeFile(join(root, 'nordbeam-i18n.config.json'), JSON.stringify({
    baseLocale: 'en', outDir: 'generated', development: true,
  }));

  await withNodeEnv('production', () => withNordbeamLocale({}, { root })('phase-production-build', {}));
  assert.doesNotMatch(await readFile(generated, 'utf8'), /expected message arguments/);

  await writeFile(join(root, 'nordbeam-i18n.config.json'), JSON.stringify({
    baseLocale: 'en', outDir: 'generated', development: false,
  }));
  const nextModule = pathToFileURL(resolve('dist/next.js')).href;
  const development = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import { readFile, writeFile } from 'node:fs/promises';
    import { withNordbeamLocale } from ${JSON.stringify(nextModule)};
    const root = ${JSON.stringify(root)};
    const catalog = ${JSON.stringify(catalog)};
    const generated = ${JSON.stringify(generated)};
    await withNordbeamLocale({}, { root })('phase-development-server', {});
    if (!(await readFile(generated, 'utf8')).includes('expected message arguments')) throw new Error('development validation is absent');
    await new Promise(resolve => setTimeout(resolve, 75));
    await writeFile(catalog, JSON.stringify({ greeting: 'Welcome {name}' }));
    const deadline = Date.now() + 4000;
    while (!(await readFile(generated, 'utf8')).includes('Welcome')) {
      if (Date.now() > deadline) throw new Error('Next development watcher did not rebuild the edited catalog');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  `], { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'development' } });
  assert.equal(development.status, 0, development.stdout + development.stderr);
});

test('withNordbeamLocale rejects invalid composed configuration and catalog errors retain locations', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'messages'));
  await writeFile(join(root, 'messages/en.json'), '{"bad":"{count, plural, other {x}"}');
  await assert.rejects(withNordbeamLocale(async () => null, { root })('phase-production-build', {}), /must resolve to an object/);
  await assert.rejects(withNordbeamLocale({}, { root, baseLocale: 'en' })('phase-production-build', {}), /messages\/en\.json:1:/);
});

test('createNextI18n validates route locales and creates typed static params', async () => {
  const loaded = [];
  const next = createNextI18n({
    locales: ['en', 'fr'],
    loadLocale: async locale => { loaded.push(locale); return { locale }; },
  });
  assert.equal(next.hasLocale('fr'), true);
  assert.equal(next.hasLocale('de'), false);
  assert.equal(next.requireLocale('en'), 'en');
  assert.throws(() => next.requireLocale('de'), /Unsupported locale: de/);
  assert.deepEqual(await next.loadLocale('fr'), { locale: 'fr' });
  assert.deepEqual(loaded, ['fr']);
  assert.deepEqual(next.generateStaticParams(), [{ locale: 'en' }, { locale: 'fr' }]);
  assert.deepEqual(next.generateStaticParams('lang'), [{ lang: 'en' }, { lang: 'fr' }]);
});
