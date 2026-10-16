import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { spawnSync } from 'node:child_process';
import { createGenerator, generate } from '../dist/project.js';
import { importChain, moduleScopeIds, sourceMessageIds } from '../dist/scope-modules.js';
import { nordbeamLocale } from '../dist/vite.js';
import { temporary, waitFor } from './helpers.mjs';

const cli = new URL('../dist/cli.js', import.meta.url).pathname;

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

test('non-ASCII property names and string-keyed segments name messages, and their imports are followed', async () => {
  const ids = ['Sökförslag', 'video.för', 'video.på', 'Schemalägg', 'video.title', 'ünïcode.ñame'];
  const code = [
    "import { Sökförslag } from './sök';",
    'm.Sökförslag(); m.video.för(); m?.video?.på(); m.video[\'title\']();',
    'm[\'Schemalägg\'](); m.ünïcode["ñame"]();',
  ].join('\n');
  assert.deepEqual([...sourceMessageIds(code, ids)].sort(), [...ids].sort());
  // A word that only contains an ID is not a chain: `xför` is not `för`, `m.videoför` is not `video.för`.
  assert.deepEqual([...sourceMessageIds('m.videoför(); xvideo.för;', ids)], []);
});

test('the crawl follows an import that names non-ASCII bindings', async t => {
  const { root, options, write } = await project(t, { modules: ['src/routes/sv.tsx'], exclude: undefined, messages: undefined });
  await write('src/routes/sv.tsx', "import { Sökruta } from '../components/Sökruta';\nexport default Sökruta;\n");
  await write('src/components/Sökruta.tsx', 'export const Sökruta = m => m.pricing.faq();\n');
  const result = await generate(options);
  assert.deepEqual([...result.groups['scopes/site/index.js']], ['pricing.faq']);
  assert.ok(result.scopeFiles.includes(join(root, 'src/components/Sökruta.tsx')));
});

test('a computed read of the messages object in a file the crawl reads is a warning, once for every scope that reads it', async t => {
  const { root, options, write } = await project(t);
  options.scopes.other = { modules: ['src/components/Status.tsx'] };
  await write('src/routes/index.tsx', "import { Status } from '../components/Status';\nexport const Page = ({ m }) => <Status m={m} />;\n");
  await write('src/components/Status.tsx', [
    'export const Status = ({ m, state, tier, key, rows, index }) => <>',
    '  {m.pricing.title()}',
    '  {m[state]()}',
    '  {m.pricing.plan[tier]()}',
    "  {m['home.title']()} {m[`pricing.plan.${tier}`]()} {rows[index]}",
    '  {m[key]() /* nordbeam-locale-ignore */}',
    '</>;',
  ].join('\n'));
  const result = await generate(options);
  const warnings = result.warnings.filter(warning => warning.code === 'SCOPE_DYNAMIC_ACCESS');
  assert.deepEqual(warnings.map(warning => [warning.file, warning.location.line, warning.location.column]), [
    [join(root, 'src/components/Status.tsx'), 3, 4],
    [join(root, 'src/components/Status.tsx'), 4, 4],
  ]);
  assert.equal(warnings[0].message, 'src/components/Status.tsx:3 reads m[state], so the scopes "site", "other" cannot tell which message it is and may lack it.');
  assert.match(warnings[1].message, /reads m\.pricing\.plan\[tier\], so the scopes/);
  assert.match(warnings[0].hint, /map of message functions/);

  await writeFile(join(root, 'nordbeam-locale.config.json'), JSON.stringify({ baseLocale: 'en', scopes: options.scopes }));
  const report = JSON.parse(spawnSync(process.execPath, [cli, 'check', '--json'], { cwd: root, encoding: 'utf8' }).stdout);
  assert.deepEqual(report.warnings.filter(warning => warning.code === 'SCOPE_DYNAMIC_ACCESS').map(warning => [warning.file, warning.location.line]), [['src/components/Status.tsx', 3], ['src/components/Status.tsx', 4]]);
});

test('the fixture project, with a template key on the messages object, has no dynamic read warning', async t => {
  const { options } = await project(t);
  assert.deepEqual((await generate(options)).warnings.filter(warning => warning.code === 'SCOPE_DYNAMIC_ACCESS'), []);
});

test('dynamicImports: false stops the crawl at import(), and the trace says why each message is in the scope', async t => {
  const { root, options } = await project(t, { dynamicImports: false });
  const result = await generate(options);
  assert.deepEqual([...result.groups['scopes/site/index.js']].sort(), siteIds.filter(id => id !== 'lazy.body'));
  const ids = [...siteIds, 'app.dashboard', 'home.secret', 'pricing.faq'];
  const traced = await moduleScopeIds({ root, scope: 'site', modules: ['src/router.ts', 'src/routes/index.tsx'], exclude: ['src/routeTree.gen.ts'], ids, outDir: 'src/i18n', trace: true });
  const relative = file => file.slice(root.length + 1);
  assert.deepEqual(importChain(traced.trace, traced.trace.ids.get('lazy.body')[0]).map(link => [relative(link.file), link.dynamic]), [['src/routes/index.tsx', false], ['src/routes/lazy.ts', true]]);
  assert.deepEqual(importChain(traced.trace, traced.trace.ids.get('footer.legal')[0]).map(link => relative(link.file)), ['src/routes/index.tsx', 'src/lib/footer.ts']);
  assert.equal(traced.trace.files.get(join(root, 'src/router.ts')).from, undefined);
});

test('inspect --scope lists what the crawl reached and explains one message', async t => {
  const { root, options } = await project(t);
  await writeFile(join(root, 'nordbeam-locale.config.json'), JSON.stringify({ baseLocale: 'en', scopes: options.scopes }));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });
  const json = run('inspect', '--scope', 'site', '--id', 'lazy.body', '--json');
  assert.equal(json.status, 0, json.stderr);
  const result = JSON.parse(json.stdout);
  assert.equal(result.scope, 'site');
  assert.equal(result.messageCount, siteIds.length);
  assert.equal(result.withoutDynamicImports, siteIds.length - 1);
  assert.deepEqual(result.message.chain, [{ file: 'src/routes/index.tsx', dynamic: false }, { file: 'src/routes/lazy.ts', dynamic: true }]);
  assert.ok(result.files.some(file => file.file === 'src/routes/lazy.ts' && file.dynamic && file.messages === 1));
  const human = run('inspect', '--scope', 'site');
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /Scope site: 8 messages .* named in 6 files/);
  assert.match(human.stdout, /"dynamicImports": false .* 7 messages/);
  const unknown = run('inspect', '--scope', 'sitee', '--json');
  assert.equal(unknown.status, 2);
  assert.equal(JSON.parse(unknown.stdout).errors[0].suggestion, 'site');
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
