import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { createGenerator, generate } from '../dist/project.js';
import { nordbeamLocale } from '../dist/vite.js';
import { temporary, waitFor } from './helpers.mjs';

const catalog = {
  home: { title: 'Home', 'sign-up': 'Sign up', secret: 'Hidden' },
  pricing: { title: 'Pricing', faq: 'FAQ', plan: { basic: 'Basic', pro: 'Pro' } },
  app: { dashboard: 'Dashboard' },
  footer: { legal: 'Legal' },
  lazy: { body: 'Later' },
  legal: { terms: 'Terms' },
};

const files = {
  // JSONC with a relative extends, as tsconfig files are written.
  'tsconfig.json': '{\n  // paths live in the base config\n  "extends": "./tsconfig.base.json",\n}\n',
  'tsconfig.base.json': '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }\n',
  'src/router.ts': "import { routeTree } from './routeTree.gen';\nexport const router = { routeTree };\n",
  // The generated route tree imports every route, so the scope excludes it.
  'src/routeTree.gen.ts': "import './routes/app';\nimport './routes/index';\nexport const routeTree = {};\n",
  'src/routes/index.tsx': [
    "import { Hero } from '../components/Hero.js';",
    "import { footer } from '@/lib/footer';",
    "import type { Plan } from './types';",
    "const Lazy = () => import('./lazy');",
    // The apostrophe would pair with the quote that opens 'home.sign-up'.
    "export const Page = ({ m, t, plan }) => <p>Don't {m.home.title()} {t('home.sign-up')} {m[`pricing.plan.${plan}`]()}</p>;",
  ].join('\n'),
  'src/routes/types.ts': "export type Plan = 'basic' | 'pro';\n",
  'src/routes/lazy.ts': 'export default m => m.lazy.body();\n',
  'src/routes/app.tsx': 'export default m => m.app.dashboard();\n',
  'src/components/Hero.tsx': 'export const Hero = ({ m }) => m.pricing.title();\n',
  'src/lib/footer.ts': 'export const footer = m => { const { footer } = m; return footer.legal(); };\n',
};

async function project(t, scope = {}) {
  const root = await temporary(t);
  const write = async (path, text) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); };
  for (const [path, text] of Object.entries(files)) await write(path, text);
  await write('messages/en.json', JSON.stringify(catalog));
  await write('messages/de.json', JSON.stringify({ ...catalog, pricing: { ...catalog.pricing, title: 'Preise' } }));
  const options = {
    root, baseLocale: 'en',
    scopes: { site: { modules: ['src/router.ts', 'src/routes/index.tsx'], exclude: ['src/routeTree.gen.ts'], messages: ['legal.*'], ...scope } },
  };
  return { root, options, write };
}

const siteIds = ['footer.legal', 'home.sign-up', 'home.title', 'lazy.body', 'legal.terms', 'pricing.plan.basic', 'pricing.plan.pro', 'pricing.title'];

test('a module scope holds the messages its modules and their imports name', async t => {
  const { root, options } = await project(t);
  const result = await generate(options);
  assert.deepEqual([...result.groups['scopes/site/index.js']].sort(), siteIds);
  const reached = result.scopeFiles.map(file => file.slice(root.length + 1)).sort();
  assert.deepEqual(reached, ['src/components/Hero.tsx', 'src/lib/footer.ts', 'src/router.ts', 'src/routes/index.tsx', 'src/routes/lazy.ts', 'src/routes/types.ts']);
  const { loadLocale } = await import(pathToFileURL(join(root, 'src/i18n/scopes/site/index.js')).href);
  const { messages } = await loadLocale('de');
  assert.equal(messages.pricing.title(), 'Preise');
  assert.equal(Object.hasOwn(messages, 'app.dashboard'), false);
});

test('an edit to a module of the scope regenerates the scope in a watch session', async t => {
  const { options, write } = await project(t);
  const run = createGenerator(options);
  await run();
  await write('src/components/Hero.tsx', 'export const Hero = ({ m }) => [m.pricing.title(), m.pricing.faq()];\n');
  const next = await run();
  assert.deepEqual([...next.groups['scopes/site/index.js']].sort(), [...siteIds, 'pricing.faq'].sort());
  assert.ok(next.changed.some(file => file.includes('scopes/site/')));
});

test('a module pattern that matches nothing, or modules that name no message, fail generation', async t => {
  const missing = await project(t, { modules: ['src/pages/*.tsx'], messages: undefined });
  await assert.rejects(generate(missing.options), error => error.diagnostics?.some(item => item.code === 'SCOPE_MODULE_NOT_FOUND' && item.message.includes('src/pages/*.tsx')));
  const empty = await project(t, { modules: ['src/routes/types.ts'], messages: undefined });
  await assert.rejects(generate(empty.options), error => error.diagnostics?.some(item => item.code === 'EMPTY_SCOPE'));
});

test('in development, reading a message the scope left out logs which one', async t => {
  const { root, options } = await project(t);
  await generate({ ...options, development: true });
  const { loadLocale } = await import(pathToFileURL(join(root, 'src/i18n/scopes/site/index.js')).href);
  const { messages } = await loadLocale('en');
  const errors = [];
  const original = console.error;
  console.error = message => { errors.push(message); };
  try {
    assert.equal(messages.home.title(), 'Home');
    assert.equal(messages.pricing.plan.pro(), 'Pro');
    assert.equal(messages.home.secret, undefined);
    assert.equal(messages.home.secret, undefined);
    assert.equal(messages.app, undefined);
    assert.equal(messages['pricing.faq'], undefined);
    assert.ok(Object.keys(messages).includes('pricing.title'));
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 3);
  assert.match(errors[0], /"home\.secret" is not in the "site" scope/);
  assert.match(errors[1], /"app"/);
  assert.match(errors[2], /"pricing\.faq"/);
  await generate(options);
  assert.doesNotMatch(await readFile(join(root, 'src/i18n/scopes/site/index.js'), 'utf8'), /\$guard/);
});

test('vite dev regenerates a module scope when a file it was computed from changes', async t => {
  const root = await realpath(await temporary(t));
  await mkdir(join(root, 'messages'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'messages/en.json'), JSON.stringify({ a: 'A', b: 'B' }));
  await writeFile(join(root, 'src/page.ts'), 'export const read = m => m.a();\n');
  const plugin = nordbeamLocale({ baseLocale: 'en', scopes: { site: { modules: ['src/page.ts'] } } });
  const server = await createServer({ root, configFile: false, logLevel: 'silent', plugins: [plugin], server: { host: '127.0.0.1', port: 0 } });
  t.after(() => server.close());
  await server.listen();
  // The development loader lists the messages the scope leaves out.
  const loader = join(root, 'src/i18n/scopes/site/index.js');
  assert.match(await readFile(loader, 'utf8'), /\$outside=new Set\(\["b"\]\)/);
  await writeFile(join(root, 'src/page.ts'), 'export const read = m => [m.a(), m.b()];\n');
  await waitFor(async () => /\$outside=new Set\(\[\]\)/.test(await readFile(loader, 'utf8')), 'the scope did not follow the edit');
});
