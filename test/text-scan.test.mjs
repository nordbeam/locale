import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseSync } from 'oxc-parser';
import { planTextFixes, scanText } from '../dist/text-scan.js';
import { temporary } from './helpers.mjs';

const cli = new URL('../dist/cli.js', import.meta.url).pathname;
const run = (cwd, ...args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });

const en = { home: { title: 'Welcome home', greeting: 'Hello {name}' }, common: { save: 'Save', cancel: 'Cancel' }, nav: { settings: 'Settings' } };
const sv = { home: { title: 'Välkommen hem', greeting: 'Hej {name}' }, common: { save: 'Spara', cancel: 'Avbryt' }, nav: { settings: 'Inställningar' } };

// A component that already uses the translator, so the scan learns `t` and `t<-useT`.
const header = `import { useT } from '../i18n';
import { notify } from '../notify';

export function Header({ count, locale }) {
  const t = useT();
  notify(t('common.save'));
  notify(t('common.cancel'));
  notify(t('home.title'));
  return (
    <header>
      <h1>{t('home.title')}</h1>
      <p>{t('home.greeting', { name: 'Ada' })}</p>
      <button title={t('common.save')}>{t('common.save')}</button>
      <p>You have {count} invoices</p>
      <a href="/settings" className="text-sm font-medium">Settings</a>
      <span>{locale === 'en' ? 'Cancel' : 'Avbryt'}</span>
      <input placeholder="Search invoices" />
      <img alt="Company logo" src="/logo.png" />
      <p>Terms &amp; conditions</p>
    </header>
  );
}
`;

async function project(t, files = {}, config = {}) {
  const root = await temporary(t);
  const write = async (path, text) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); };
  await write('package.json', JSON.stringify({ name: 'text-fixture', type: 'module', dependencies: { react: '19.0.0' } }));
  await write('nordbeam-locale.config.json', JSON.stringify({ baseLocale: 'en', ...config }));
  await write('messages/en.json', JSON.stringify(en, null, 2) + '\n');
  await write('messages/sv.json', JSON.stringify(sv, null, 2) + '\n');
  await write('src/i18n.ts', 'export function useT() { return (id, values) => id; }\n');
  await write('src/notify.ts', 'export function notify(text) { console.log(text); }\n');
  await write('src/components/Header.tsx', header);
  for (const [path, text] of Object.entries(files)) await write(path, text);
  return root;
}

const scan = (root, options = {}) => scanText({ root, baseLocale: 'en', ...options });
const texts = (result, file) => result.findings.filter(finding => !file || finding.file.endsWith(file)).map(finding => finding.text).sort();

test('JSX text, attributes and sentences with values are UI text; message calls and code are not', async t => {
  const root = await project(t);
  const result = await scan(root);
  assert.deepEqual(texts(result, 'Header.tsx'), ['Cancel', 'Company logo', 'Search invoices', 'Settings', 'Terms & conditions', 'You have {count} invoices']);
  const byText = Object.fromEntries(result.findings.map(finding => [finding.text, finding]));
  assert.deepEqual(byText['You have {count} invoices'].args.map(arg => arg.name), ['count']);
  assert.equal(byText['You have {count} invoices'].line, 14);
  assert.equal(byText['Search invoices'].confidence, 'high');
  // The same text as a catalog message: the fix can reuse it.
  assert.deepEqual(byText.Settings.catalog, { id: 'nav.settings', locale: 'en', exact: true });
  // An inline translation is one finding with both texts, matched in every locale.
  assert.deepEqual(byText.Cancel.translations, { en: 'Cancel', sv: 'Avbryt' });
  assert.deepEqual(byText.Cancel.catalog, { id: 'common.cancel', locale: 'en', exact: true });
  assert.equal(byText.Cancel.context, 'mixed');
  // t takes the message ID as its first argument.
  assert.equal(result.translators.get('t'), 0);
});

test('code, names, ignore comments and opaque elements are not findings', async t => {
  const root = await project(t, {
    'src/components/Noise.tsx': `export function Noise() {
  const key = 'user_id';
  const url = 'https://example.com/docs';
  return (
    <div className="flex items-center gap-2" data-testid="noise-root" style={{ width: '12px' }}>
      <code>npm install nordbeam</code>
      <span translate="no">Untranslatable product</span>
      {/* nordbeam-locale-ignore */}
      <p>Ignored by comment</p>
      <p>LinkedIn</p>
      <p>Acme Nautics AB</p>
      <p>EN</p>
      <p>{key} {url}</p>
      <p>yyyy-MM-dd</p>
    </div>
  );
}
`,
    'src/components/Skipped.tsx': '// nordbeam-locale-ignore-file\nexport const Skipped = () => <p>Not scanned at all</p>;\n',
    'src/components/Header.test.tsx': 'export const Fixture = () => <p>Test fixture text</p>;\n',
  });
  const result = await scan(root);
  assert.deepEqual(texts(result, 'Noise.tsx'), []);
  assert.deepEqual(texts(result, 'Skipped.tsx'), []);
  assert.deepEqual(texts(result, '.test.tsx'), []);
  assert.ok(result.ignored.comment >= 1, JSON.stringify(result.ignored));
  assert.ok(result.ignored.name >= 2, JSON.stringify(result.ignored));
});

test('an ignore comment after code covers its line; one on its own line covers the next node only', async t => {
  const root = await project(t, {
    'src/components/Scoped.tsx': `export function Scoped() {
  const label = 'Beta release'; // nordbeam-locale-ignore
  return (
    <div>
      <p title={label}>Version two preview</p>
      {/* nordbeam-locale-ignore */}
      <p>Debug panel</p>
      <p>Shown text</p>
    </div>
  );
}
`,
    'src/components/Linted.tsx': `export function Linted() {
  // eslint-disable-next-line i18next/no-literal-string
  return (
    <div>
      <p>Still reported</p>
      {/* eslint-disable i18next/no-literal-string */}
      <p>Inside the disabled block</p>
      <p>Also inside</p>
      {/* eslint-enable i18next/no-literal-string */}
      <p>After the block</p>
    </div>
  );
}
`,
  });
  const result = await scan(root);
  assert.deepEqual(texts(result, 'Scoped.tsx'), ['Shown text', 'Version two preview']);
  assert.deepEqual(texts(result, 'Linted.tsx'), ['After the block', 'Still reported']);
  assert.equal(result.ignored.comment, 4, JSON.stringify(result.ignored));
});

test('configuration excludes files, accepts text, and adds attributes and calls', async t => {
  const root = await project(t, {
    'src/legacy/Old.tsx': 'export const Old = () => <p>Legacy screen</p>;\n',
    'src/components/Badge.tsx': `export const Badge = ({ say }) => (
  <div slogan="Shown on hover">
    <span>Beta</span>
    <span>v2 preview</span>
    {say('Configured call text')}
  </div>
);
`,
  });
  const before = await scan(root);
  assert.deepEqual(texts(before, 'Badge.tsx'), ['Beta', 'v2 preview']);
  assert.deepEqual(texts(before, 'Old.tsx'), ['Legacy screen']);
  const after = await scan(root, { text: { exclude: ['src/legacy/**'], ignore: ['Beta', '/^v\\d+ /'], attributes: ['slogan'], calls: ['say'] } });
  assert.deepEqual(texts(after, 'Badge.tsx'), ['Configured call text', 'Shown on hover']);
  assert.deepEqual(texts(after, 'Old.tsx'), []);
});

test('a position that receives messages elsewhere is learned, so plain text there is reported', async t => {
  const root = await project(t, {
    'src/components/Profile.tsx': `import { notify } from '../notify';
import { track } from '../track';
export function save() {
  notify('Profile updated');
  track('Profile updated');
}
`,
    'src/track.ts': 'export function track(event) {}\n',
  });
  const result = await scan(root);
  const profile = result.findings.filter(finding => finding.file.endsWith('Profile.tsx'));
  assert.equal(profile.length, 1, JSON.stringify(profile));
  assert.match(profile[0].where, /notify/);
  assert.ok(result.learned.some(sink => sink.sink === 'call:notify#0' && sink.messages >= 3));
});

test('Vue templates and Svelte components are scanned like JSX', async t => {
  const root = await project(t, {
    'src/components/Card.vue': `<template>
  <section :title="$t('home.title')">
    <h2>{{ $t('home.title') }}</h2>
    <p>Unsaved changes</p>
    <button title="Close dialog" class="btn btn-primary">{{ 'Discard' }}</button>
  </section>
</template>
<script setup lang="ts">
const label = 'Draft';
</script>
`,
    'src/components/Banner.svelte': `<script>
  export let name;
</script>
<div class="banner" aria-label="Announcement">
  <p>Hello {name}, welcome back</p>
  {#if name}<span>Signed in</span>{/if}
</div>
`,
  });
  const result = await scan(root);
  assert.deepEqual(texts(result, 'Card.vue'), ['Close dialog', 'Discard', 'Unsaved changes']);
  assert.deepEqual(texts(result, 'Banner.svelte'), ['Announcement', 'Hello {name}, welcome back', 'Signed in']);
  const close = result.findings.find(finding => finding.text === 'Close dialog');
  assert.equal(close.line, 5);
});

const profile = `import { useState } from 'react';
export function Profile() {
  const [open] = useState(false);
  return <div><button>Save</button><button title="Cancel">Spara</button><p>Brand new text</p></div>;
}
`;

test('--fix reuses catalog messages, adding the translator hook and its import where a component lacks them', async t => {
  const root = await project(t, {
    'src/components/Profile.tsx': profile,
    'src/components/Plain.tsx': 'export function Plain() {\n  return <p>Save</p>;\n}\n',
  });
  const result = await scan(root);
  const plan = await planTextFixes(result, { root, baseLocale: 'en' });
  const kinds = Object.fromEntries(plan.skipped.map(item => [item.text, item.kind]));
  // Spara is the Swedish text of common.save: reusing it would show English users "Save" instead.
  assert.equal(kinds.Spara, 'other-locale');
  // No hook calls, so it may be a server component: the plan does not add one.
  assert.equal(plan.skipped.find(item => item.file.endsWith('Plain.tsx'))?.kind, 'no-binding');
  assert.deepEqual(plan.messages, []);

  const written = run(root, 'hardcoded', '--fix', '--write', '--json');
  assert.equal(written.status, 0, written.stderr + written.stdout);
  const body = JSON.parse(written.stdout);
  // Save and Cancel in Profile, Settings and the inline Cancel in Header.
  assert.equal(body.written.replaced, 4);
  const source = await readFile(join(root, 'src/components/Profile.tsx'), 'utf8');
  assert.equal(source, `import { useState } from 'react';
import { useT } from '../i18n';
export function Profile() {
  const t = useT();
  const [open] = useState(false);
  return <div><button>{t('common.save')}</button><button title={t('common.cancel')}>Spara</button><p>Brand new text</p></div>;
}
`);
  assert.equal(parseSync('Profile.tsx', source).errors.length, 0);
  const header = await readFile(join(root, 'src/components/Header.tsx'), 'utf8');
  assert.match(header, /<a href="\/settings" className="text-sm font-medium">\{t\('nav\.settings'\)\}<\/a>/);
  assert.match(header, /<span>\{t\('common\.cancel'\)\}<\/span>/);
  assert.equal(parseSync('Header.tsx', header).errors.length, 0);
});

test('--extract adds new messages, with the other locale when the source spells it out', async t => {
  const root = await project(t, { 'src/components/Profile.tsx': profile });
  const written = run(root, 'hardcoded', '--extract', '--write', '--json');
  assert.equal(written.status, 0, written.stderr + written.stdout);
  const catalog = JSON.parse(await readFile(join(root, 'messages/en.json'), 'utf8'));
  const swedish = JSON.parse(await readFile(join(root, 'messages/sv.json'), 'utf8'));
  assert.equal(catalog.profile?.brandNewText, 'Brand new text');
  // Header uses home.* three times, so its new text joins that namespace; common.* is for reuse only.
  assert.deepEqual(Object.keys(catalog.common), ['save', 'cancel']);
  const invoices = Object.entries(catalog.home).find(([, text]) => text === 'You have {count} invoices');
  assert.ok(invoices, JSON.stringify(catalog.home));
  const source = await readFile(join(root, 'src/components/Header.tsx'), 'utf8');
  assert.ok(source.includes(`<p>{t('home.${invoices[0]}', { count })}</p>`), source);
  assert.equal(parseSync('Header.tsx', source).errors.length, 0);
  // Spara matched only the Swedish catalog: the new message keeps what English users see, and records the Swedish.
  const spara = Object.entries(catalog.profile).find(([, text]) => text === 'Spara');
  assert.ok(spara, JSON.stringify(catalog.profile));
  assert.equal(swedish.profile[spara[0]], 'Spara');
  // Nothing high-confidence is left in Profile.
  const after = await scan(root);
  assert.deepEqual(after.findings.filter(finding => finding.file.endsWith('Profile.tsx') && finding.confidence === 'high').map(finding => finding.text), []);
});

test('hardcoded reports JSON, fails under --strict, and rejects options that do not fit', async t => {
  const root = await project(t);
  const listed = run(root, 'hardcoded', '--json');
  assert.equal(listed.status, 0, listed.stderr);
  const body = JSON.parse(listed.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.summary.findings, body.findings.length);
  assert.equal(body.findings[0].file, 'src/components/Header.tsx');
  assert.ok(body.learned.length > 0);

  const strict = run(root, 'hardcoded', '--strict');
  assert.equal(strict.status, 1);
  assert.match(strict.stdout, /UI text outside the catalog/);

  for (const args of [['hardcoded', '--write'], ['hardcoded', '--confidence', 'low'], ['check', '--fix'], ['hardcoded', '--fix', '--id', 'x']]) {
    const result = run(root, ...args, '--json');
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
    assert.equal(JSON.parse(result.stdout || result.stderr).errors[0].code, 'USAGE');
  }
});

test('doctor summarizes hardcoded text as a warning', async t => {
  const root = await project(t);
  const result = run(root, 'doctor', '--json');
  const body = JSON.parse(result.stdout);
  const warning = body.warnings.find(item => item.code === 'HARDCODED_TEXT');
  assert.ok(warning, JSON.stringify(body.warnings));
  assert.match(warning.message, /^6 strings of UI text in 1 source file are not catalog messages/);
  assert.equal(body.hardcoded.high, 6);
  assert.equal(body.hardcoded.inCatalog, 2);
});

test('worker threads find exactly what one thread finds', async t => {
  const files = {};
  for (let i = 0; i < 24; i++) files[`src/pages/Page${i}.tsx`] = `export function Page${i}({ n }) {\n  return <main><h1>Page number ${i}</h1><p>Showing {n} results</p></main>;\n}\n`;
  const root = await project(t, files);
  const shape = result => result.findings.map(finding => `${finding.file}:${finding.line}:${finding.column}:${finding.text}:${finding.confidence}`);
  const one = await scan(root, { workers: 1 }), many = await scan(root, { workers: 3 });
  assert.equal(one.findings.length, 6 + 48);
  assert.deepEqual(shape(many), shape(one));
  assert.equal(many.timing.workers, 3);
  // Workers inherit the process's flags; --input-type, from `node -e`, must not stop them loading.
  const script = `const { scanText } = await import(${JSON.stringify(new URL('../dist/text-scan.js', import.meta.url).href)}); const r = await scanText({ root: ${JSON.stringify(root)}, baseLocale: 'en', workers: 2 }); console.log(r.findings.length);`;
  const evaluated = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(evaluated.stderr, '');
  assert.equal(evaluated.stdout.trim(), String(one.findings.length));
});

test('persistentCache reuses the facts of unchanged files and rereads changed ones', async t => {
  const root = await project(t, { 'src/components/Profile.tsx': profile });
  const options = { persistentCache: '.cache/locale' };
  const cold = await scan(root, options);
  assert.equal(cold.timing.cached, 0);
  const warm = await scan(root, options);
  assert.equal(warm.timing.cached, warm.sourceFiles);
  assert.deepEqual(warm.findings, cold.findings);
  // Write different content of a different length, so the stamp changes even on coarse clocks.
  await writeFile(join(root, 'src/components/Profile.tsx'), profile.replace('Brand new text', 'A completely different sentence'));
  const changed = await scan(root, options);
  assert.equal(changed.timing.cached, changed.sourceFiles - 1);
  assert.ok(texts(changed, 'Profile.tsx').includes('A completely different sentence'));
  assert.ok(!texts(changed, 'Profile.tsx').includes('Brand new text'));
  // A catalog change invalidates every entry: known IDs decide what is a message call.
  await writeFile(join(root, 'messages/en.json'), JSON.stringify({ ...en, extra: 'Extra' }));
  assert.equal((await scan(root, options)).timing.cached, 0);
});
