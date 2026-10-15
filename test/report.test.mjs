import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { buildReport } from '../dist/report.js';
import { renderReportPage } from '../dist/report-page.js';
import { temporary } from './helpers.mjs';

const cli = new URL('../dist/cli.js', import.meta.url).pathname;
const run = (cwd, ...args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });

const config = {
  baseLocale: 'en',
  notes: 'notes.json',
  scopes: { site: { modules: ['src/pages/home.tsx'] }, checkout: ['checkout.*'] },
};

async function project(t, overrides = {}) {
  const root = await temporary(t);
  await mkdir(join(root, 'messages'));
  await mkdir(join(root, 'src/pages'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture-app', type: 'module', dependencies: { react: '19.0.0' } }));
  await writeFile(join(root, 'nordbeam-locale.config.json'), JSON.stringify({ ...config, ...overrides.config }));
  await writeFile(join(root, 'messages/en.json'), JSON.stringify(overrides.en ?? {
    home: { title: 'Welcome home', body: 'You have {count, plural, one {# item} other {# items}}' },
    checkout: { pay: 'Pay {amount, number}', when: 'Due {date, date}', place: 'You finished {place, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}' },
    legal: { terms: 'Read the <link>terms</link>', audience: '{who, select, team {Your team} other {Everyone}}' },
    unused: 'Never shown',
  }));
  await writeFile(join(root, 'messages/fr.json'), JSON.stringify(overrides.fr ?? {
    home: { title: 'Bienvenue', body: '' },
    checkout: { pay: 'Pay {amount, number}', when: 'Échéance {date, date}', place: 'Vous avez fini {place, selectordinal, one {#er} other {#e}}' },
    legal: { terms: 'Lisez les <link>conditions</link>' },
    unused: 'Jamais affiché',
  }));
  await writeFile(join(root, 'notes.json'), JSON.stringify({ home: { title: 'Hero heading </script><script>globalThis.pwned = true</script>' } }));
  await writeFile(join(root, 'src/pages/home.tsx'), "import m from '../i18n/messages.js';\nexport const Home = () => m.home.title() + m.home.body({ count: 1 }) + m.home.titel();\n");
  await writeFile(join(root, 'src/pages/checkout.tsx'), "import m from '../i18n/messages.js';\nexport const step = name => m[`checkout.${name}`];\nexport const pay = () => m.checkout.pay({ amount: 1 });\n");
  return root;
}

const load = async root => JSON.parse(await readFile(join(root, 'nordbeam-locale.config.json'), 'utf8'));

test('the report counts coverage, usage, scopes, ICU features and generated sizes', async t => {
  const root = await project(t);
  const report = await buildReport({ ...await load(root), root }, join(root, 'nordbeam-locale.config.json'));
  assert.equal(report.reportVersion, 1);
  assert.equal(report.project.name, 'fixture-app');
  assert.deepEqual(report.project.frameworks, ['react']);
  assert.equal(report.summary.messages, 8);
  assert.equal(report.summary.locales, 2);

  const fr = report.locales.find(locale => locale.locale === 'fr');
  assert.deepEqual({ translated: fr.translated, same: fr.same, blank: fr.blank, missing: fr.missing, extra: fr.extra }, { translated: 5, same: 1, blank: 1, missing: 1, extra: 0 });
  assert.equal(fr.coverage, 6 / 8);
  assert.equal(report.locales[0].locale, 'en');
  assert.equal(report.locales[0].base, true);
  assert.equal(report.summary.untranslated, 2);

  assert.deepEqual(report.features, { plain: 2, arguments: 6, plural: 1, ordinal: 1, select: 1, number: 1, date: 1, tags: 1 });
  const byId = Object.fromEntries(report.messages.map(message => [message.id, message]));
  assert.deepEqual(byId['home.body'].status, { fr: 'blank' });
  assert.deepEqual(byId['checkout.pay'].status, { fr: 'same' });
  assert.deepEqual(byId['legal.audience'].status, { fr: 'missing' });
  assert.match(byId['home.title'].note, /^Hero heading/);

  // A template-literal pattern counts checkout.when and checkout.place as used.
  assert.deepEqual([...report.usage.unused].sort(), ['legal.audience', 'legal.terms', 'unused']);
  assert.deepEqual(byId['checkout.place'].files, ['src/pages/checkout.tsx']);
  assert.equal(report.usage.sourceFiles, 2);
  assert.equal(report.usage.unknown.length, 1);
  assert.equal(report.usage.unknown[0].messageId, 'home.titel');
  assert.equal(report.usage.unknown[0].file, 'src/pages/home.tsx');

  const site = report.scopes.find(scope => scope.name === 'site'), checkout = report.scopes.find(scope => scope.name === 'checkout');
  assert.equal(site.kind, 'modules');
  assert.deepEqual(site.modules, ['src/pages/home.tsx']);
  assert.equal(site.messages, 2);
  assert.equal(checkout.kind, 'messages');
  assert.equal(checkout.messages, 3);
  assert.deepEqual(byId['checkout.pay'].scopes, ['checkout']);

  assert.equal(report.sizes.available, true);
  for (const locale of report.locales) assert.ok(locale.module.brotli > 0 && locale.module.brotli < locale.module.raw, locale.locale);
  assert.ok(site.sizes.en.raw < report.locales[0].module.raw);
  assert.deepEqual(report.namespaces.map(namespace => namespace.name), ['checkout', 'home', 'legal', '']);
  assert.equal(report.namespaces.find(namespace => namespace.name === 'legal').untranslated, 1);
  assert.equal(report.namespaces.find(namespace => namespace.name === 'legal').unused, 2);
});

test('a project that does not compile still gets a report, without generated sizes', async t => {
  const root = await project(t, { en: { broken: 'Hello {name', fine: 'Fine' }, fr: { fine: 'Bien', extra: 'Pas dans le catalogue de base' } });
  const report = await buildReport({ ...await load(root), root, scopes: undefined, notes: undefined }, join(root, 'nordbeam-locale.config.json'));
  assert.equal(report.sizes.available, false);
  assert.match(report.sizes.reason, /does not compile/);
  assert.ok(report.diagnostics.errors.some(error => error.code === 'INVALID_ICU' && error.file === 'messages/en.json'));
  assert.ok(report.diagnostics.errors.some(error => error.code === 'UNKNOWN_MESSAGE' && error.messageId === 'extra'));
  assert.equal(report.summary.messages, 2);
  assert.equal(report.locales.find(locale => locale.locale === 'fr').extra, 1);
});

test('a file that names most of the catalog is a copy, not a use', async t => {
  const en = Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`key${index}`, `Text ${index}`]));
  const root = await project(t, { en, fr: en, config: { scopes: undefined, notes: undefined } });
  await writeFile(join(root, 'src/dictionary.ts'), `export default ${JSON.stringify(en)};\n`);
  await writeFile(join(root, 'src/pages/home.tsx'), "import m from '../i18n/messages.js';\nexport const Home = () => m.key1();\n");
  const report = await buildReport({ ...await load(root), root }, join(root, 'nordbeam-locale.config.json'));
  assert.deepEqual(report.usage.copies, [{ file: 'src/dictionary.ts', messages: 120 }]);
  assert.equal(report.usage.used, 1);
  assert.equal(report.usage.unused.length, 119);
});

test('report writes a self-contained page; the embedded data cannot close its script element', async t => {
  const root = await project(t);
  const result = run(root, 'report');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /report on 8 messages in 2 locales — 75% translated, 3 unused, 0 errors, 1 warning\./);
  assert.match(result.stdout, /→ nordbeam-locale-report\.html/);
  const html = await readFile(join(root, 'nordbeam-locale-report.html'), 'utf8');
  assert.equal(html.split('</script>').length - 1, 2, 'only the two script elements close');
  assert.doesNotMatch(html, /<(?:link|script)[^>]+(?:src|href)=["']?https?:/, 'the page loads nothing from the network');
  const embedded = html.match(/<script type="application\/json" id="report-data">([^]*?)<\/script>/)[1];
  assert.equal(JSON.parse(embedded).messages.find(message => message.id === 'home.title').note, 'Hero heading </script><script>globalThis.pwned = true</script>');

  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  const { document } = dom.window;
  assert.equal(dom.window.pwned, undefined);
  assert.equal(document.querySelectorAll('.kpi').length, 6);
  assert.equal(document.querySelector('.kpi .value').textContent, '8');
  assert.equal(document.querySelectorAll('#table-body tr.msg').length, 8);
  assert.equal(document.querySelectorAll('#coverage-chart .bar-row').length, 1);
  assert.ok(document.querySelectorAll('#treemap rect').length >= 4);
  assert.match(document.getElementById('scopes-list').textContent, /site.*computed from 1 glob/);
  const search = document.getElementById('q');
  search.value = 'checkout';
  search.dispatchEvent(new dom.window.Event('input'));
  assert.equal(document.querySelectorAll('#table-body tr.msg').length, 3);
  assert.equal(document.getElementById('count').textContent, '3 of 8 messages');
  const show = document.getElementById('show');
  search.value = ''; search.dispatchEvent(new dom.window.Event('input'));
  show.value = 'unused'; show.dispatchEvent(new dom.window.Event('change'));
  assert.equal(document.querySelectorAll('#table-body tr.msg').length, 3);
  dom.window.close();
});

test('report --json returns the data with capped lists and writes nothing', async t => {
  const root = await project(t);
  const result = run(root, 'report', '--json', '--limit', '2');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.version, 1);
  assert.equal(output.ok, true);
  assert.equal(output.summary.messages, 8);
  assert.equal(output.messages.length, 2);
  assert.deepEqual(output.truncated, { messages: 6, unused: 1 });
  assert.equal(output.file, undefined);
  assert.equal(existsSync(join(root, 'nordbeam-locale-report.html')), false);

  const written = run(root, 'report', '--json', '--out', 'reports/i18n.html');
  assert.equal(written.status, 0, written.stderr);
  assert.equal(JSON.parse(written.stdout).file, join(await realpath(root), 'reports/i18n.html'));
  assert.ok(existsSync(join(root, 'reports/i18n.html')));

  const stdout = run(root, 'report', '--out', '-');
  assert.equal(stdout.status, 0, stdout.stderr);
  assert.match(stdout.stdout, /^<!doctype html>/);
  assert.match(stdout.stderr, /report on 8 messages/);
});

test('report rejects options that do not apply to it', async t => {
  const root = await project(t);
  for (const args of [['report', '--json', '--open'], ['report', '--only', 'UNUSED_MESSAGE'], ['report', '--id', 'home.title'], ['check', '--open']]) {
    const result = run(root, ...args);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
  }
});

test('the page renders a project with only the base locale and no source files', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'messages'));
  await writeFile(join(root, 'messages/en.json'), JSON.stringify({ hello: 'Hello' }));
  const report = await buildReport({ baseLocale: 'en', root }, join(root, 'nordbeam-locale.config.json'));
  assert.equal(report.summary.coverage, 1);
  assert.deepEqual(report.usage.unused, []);
  const dom = new JSDOM(renderReportPage(report), { runScripts: 'dangerously' });
  const { document } = dom.window;
  assert.match(document.getElementById('coverage-chart').textContent, /Only the base locale exists/);
  assert.match(document.getElementById('usage-body').textContent, /No source files found/);
  assert.match(document.getElementById('scopes-list').textContent, /No scopes configured/);
  assert.equal(document.querySelectorAll('#table-body tr.msg').length, 1);
  dom.window.close();
});
