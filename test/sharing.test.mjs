import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, writeFile, readFile, unlink, realpath, rename, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'vite';
import { nordbeamLocale } from '../dist/vite.js';
import { Selections } from '../dist/selection.js';
import { fasti18n as before } from './baselines/before_shared_selections_v0_2/vite.js';
import { normalizeLegacyFormatterCacheOutput, temporary, waitFor } from './helpers.mjs';

async function fixture(t) {
  const root = await realpath(await temporary(t));
  await mkdir(join(root, 'messages')); await mkdir(join(root, 'src'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  const en = { shared: 'COMMON_EN {n, number}', a: 'PRIVATE_ALPHA {name}', b: 'PRIVATE_BETA {name}',
    rich: '<b>Hello {name}</b>', ['__proto__']: 'Proto {name}', constructor: 'Constructor', '7': 'Seven', unused: 'UNUSED_SENTINEL' };
  const fr = { ...en, shared: 'COMMON_FR {n, number}' }; delete fr.rich;
  for (const [locale, catalog] of Object.entries({ en, fr })) await writeFile(join(root, `messages/${locale}.json`), JSON.stringify(catalog));
  await writeFile(join(root, 'src/main.js'), 'export const pages=[()=>import("./a.js"),()=>import("./b.js")];');
  await writeFile(join(root, 'src/a.js'), 'import {selectMessages} from "./i18n/index.js";export const load=selectMessages("shared","a","rich","__proto__","7");');
  await writeFile(join(root, 'src/b.js'), 'import {selectMessages} from "./i18n/index.js";export const load=selectMessages("__proto__","rich","shared","b","7");');
  const config = { root, configFile: false, logLevel: 'silent', base: './' };
  const output = { minify: true, rolldownOptions: { input: join(root, 'src/main.js'), preserveEntrySignatures: 'strict', output: { entryFileNames: 'entry.js' } } };
  return { root, en, fr, config, output };
}
const chunks = result => (Array.isArray(result) ? result : [result]).flatMap(result => result.output.filter(item => item.type === 'chunk'));
const sharedModules = result => chunks(result).flatMap(chunk => Object.keys(chunk.modules)).filter(id => id.startsWith('\0virtual:nordbeam-locale/shared/'));

test('SSR shares overlapping functions while preserving rich output, order, fallback and lazy private messages', async t => {
  const { root, config, output } = await fixture(t);
  const result = await build({ ...config, plugins: [nordbeamLocale()], build: { ...output, ssr: true, modulePreload: false } });
  assert.ok(sharedModules(result).length);
  const entry = await import(pathToFileURL(join(root, 'dist/entry.js')));
  const [a, b] = await Promise.all(entry.pages.map(async page => (await page()).load('fr')));
  assert.deepEqual(Object.keys(a.messages), ['7', 'shared', 'a', 'rich', '__proto__']);
  assert.deepEqual(Object.keys(b.messages), ['7', '__proto__', 'rich', 'shared', 'b']);
  assert.equal(Object.getPrototypeOf(a.messages), null);
  for (const key of ['shared', 'rich', '__proto__', '7']) assert.equal(a.messages[key], b.messages[key]);
  assert.equal(a.messages.shared({ n: 1234.5 }), 'COMMON_FR 1\u202f234,5');
  assert.deepEqual(a.messages.rich({ name: 'Ada', b: children => ({ strong: children }) }), [{ strong: ['Hello Ada'] }]);
  assert.equal(a.messages.__proto__({ name: 'Ada' }), 'Proto Ada');
  await assert.rejects((await entry.pages[0]()).load('__proto__'), /Unsupported locale/);
  const graph = new Map(chunks(result).map(chunk => [chunk.fileName, chunk]));
  const page = chunks(result).find(chunk => chunk.facadeModuleId === join(root, 'src/a.js'));
  const french = page.dynamicImports.map(file => graph.get(file)).find(chunk => chunk.facadeModuleId?.endsWith('/fr'));
  const reached = new Set();
  const visit = file => { if (reached.has(file)) return; reached.add(file); for (const dependency of graph.get(file).imports) visit(dependency); };
  visit(french.fileName);
  const text = [...reached].map(file => graph.get(file).code).join('\n');
  assert.match(text, /PRIVATE_ALPHA/); assert.doesNotMatch(text, /PRIVATE_BETA|UNUSED_SENTINEL|COMMON_EN/);
});

test('client sharing defaults on with native preloading and preserves disabled/custom-preload output', async t => {
  const { config, output } = await fixture(t);
  const result = await build({ ...config, plugins: [nordbeamLocale()], build: { ...output, write: false } });
  assert.ok(sharedModules(result).length);
  assert.equal(chunks(result).map(chunk => chunk.code).join('\n').split('COMMON_EN').length - 1, 1);
  for (const modulePreload of [false, { resolveDependencies: (_file, deps) => deps }, { resolveDependencies: () => [] }]) {
    const buildOptions = { ...output, write: false, modulePreload };
    // Compare the current plugin's unminified generated modules with the
    // frozen pre-memo plugin output. This normalization belongs only to this
    // legacy comparison build; the real current controls above and below stay
    // byte-exact, including their minified chunks.
    const current = await build({ ...config, plugins: [nordbeamLocale(), {
      name: 'normalize-legacy-formatter-output', enforce: 'post',
      transform(code, id) {
        return id.includes('virtual:nordbeam-locale/') ? normalizeLegacyFormatterCacheOutput(code) : null;
      },
    }], build: buildOptions });
    // The frozen plugin does not know about current private full-catalog files
    // in the ownership manifest. Each comparison already uses an isolated temp
    // project, so clear generated output before asking the baseline to own it.
    await rm(join(config.root, 'src/i18n'), { recursive: true, force: true });
    const baseline = await build({ ...config, plugins: [before({ baseLocale: 'en' })], build: buildOptions });
    assert.equal(sharedModules(current).length, 0);
    assert.deepEqual(chunks(current).map(chunk => chunk.code).sort(), chunks(baseline).map(chunk => chunk.code).sort());
  }
});

test('sharing can be disabled through plugin or discovered config and library mode keeps independent output', async t => {
  const { root, config, output } = await fixture(t);
  const disabled = await build({ ...config, plugins: [nordbeamLocale({ shareMessages: false })], build: { ...output, write: false } });
  assert.equal(sharedModules(disabled).length, 0);
  await writeFile(join(root, 'nordbeam-i18n.config.json'), JSON.stringify({ shareMessages: false }));
  const discovered = await build({ ...config, plugins: [nordbeamLocale()], build: { ...output, write: false } });
  assert.equal(sharedModules(discovered).length, 0);
  const library = await build({ ...config, plugins: [nordbeamLocale({ baseLocale: 'en' })], build: { ...output, write: false, lib: { entry: join(root, 'src/main.js'), formats: ['es'] } } });
  assert.equal(sharedModules(library).length, 0);
  await writeFile(join(root, 'nordbeam-i18n.config.json'), JSON.stringify({ shareMessages: 'yes' }));
  await assert.rejects(build({ ...config, plugins: [nordbeamLocale()], build: { ...output, write: false } }), /shareMessages must be a boolean/);
});

// Watch events are a log rather than a queue: an earlier rebuild can finish
// after the next write begins, and one write may legitimately cause more than
// one rebuild. A write is answered by the event it causes after it started.
function watchLog(watcher) {
  const log = [];
  watcher.on('event', event => log.push(event));
  return {
    log,
    async expect(from, code, timeout = 20000) {
      const seen = () => log.slice(from).map(event => event.code === 'ERROR' ? `ERROR ${event.error?.message}` : event.code);
      await waitFor(() => log.slice(from).some(event => event.code === code), `Watch did not emit ${code}: ${JSON.stringify(seen())}`, timeout);
      return log.slice(from).find(event => event.code === code);
    },
  };
}
// Poll generated output until it reflects a write. Assertions stay inside
// check, so the last real mismatch is reported after the timeout.
// A watch rebuild can replace dist/ while a test imports it, and Node caches a
// failed import per URL, so a retry would keep failing on the same hashed chunk.
// Each load imports its own copy of dist/, under URLs no earlier attempt used.
let snapshots = 0;
async function importBuild(root) {
  const copy = join(root, `.snapshot-${snapshots++}`);
  await cp(join(root, 'dist'), copy, { recursive: true });
  return import(pathToFileURL(join(copy, 'entry.js')).href);
}

async function eventually(check, timeout = 20000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try { return await check(); }
    catch (error) { if (Date.now() > deadline) throw error; }
    await delay(25);
  }
}

test('build watch replans catalog, route and locale edits and recovers invalid catalogs', async t => {
  const { root, en, fr, config, output } = await fixture(t);
  const results = [], events = [];
  const watcher = await build({ ...config, plugins: [nordbeamLocale(), {
    name: 'record-watch-output',
    watchChange(id) { events.push({ changed: id }); },
    generateBundle(_options, bundle) { results.push(Object.values(bundle).filter(item => item.type === 'chunk')); },
  }], build: { ...output, ssr: true, watch: {} } });
  const watch = watchLog(watcher);
  try {
    await watch.expect(0, 'BUNDLE_END');
    const load = () => importBuild(root);
    // Native watcher events for a repeated path are throttled for 50 ms. Keep
    // fixture edits outside that window, including invalid-edit recovery.
    const guard = () => delay(75);
    // A content check alone can pass on the previous successful output, so every
    // write also waits for the rebuild it causes.
    const change = async action => { await guard(); const from = watch.log.length; await action(); await watch.expect(from, 'BUNDLE_END'); };
    const save = locale => writeFile(join(root, `messages/${locale}.json`), JSON.stringify(locale === 'en' ? en : fr));
    const sharedPair = async locale => {
      const entry = await load();
      return Promise.all(entry.pages.map(async page => (await page()).load(locale)));
    };
    assert.ok(results.at(-1).some(chunk => Object.keys(chunk.modules).some(id => id.startsWith('\0virtual:nordbeam-locale/shared/'))));
    let a, b;
    fr.shared = 'EDITED_FR {n, number}';
    await change(() => save('fr'));
    await eventually(async () => { [a, b] = await sharedPair('fr'); assert.equal(a.messages.shared({ n: 2 }), 'EDITED_FR 2'); });
    assert.equal(a.messages.shared, b.messages.shared);
    await change(() => writeFile(join(root, 'src/b.js'), 'import {selectMessages} from "./i18n/index.js";export const load=selectMessages("shared","unused");'));
    await eventually(async () => { [a, b] = await sharedPair('en'); assert.deepEqual(Object.keys(b.messages), ['shared', 'unused']); assert.equal(b.messages.unused(), 'UNUSED_SENTINEL'); });
    assert.equal(a.messages.shared, b.messages.shared);
    await change(() => writeFile(join(root, 'messages/de.json'), JSON.stringify({ ...en, shared: 'DE_SHARED {n, number}' })));
    await eventually(async () => { [a, b] = await sharedPair('de'); assert.equal(a.messages.shared({ n: 2 }), 'DE_SHARED 2'); }); assert.equal(a.messages.shared, b.messages.shared);
    await change(() => writeFile(join(root, 'messages/de.json'), JSON.stringify({ ...en, shared: 'DE_EDITED {n, number}' })));
    await eventually(async () => { [a, b] = await sharedPair('de'); assert.equal(a.messages.shared({ n: 2 }), 'DE_EDITED 2'); }); assert.equal(a.messages.shared, b.messages.shared);
    await change(() => unlink(join(root, 'messages/de.json')));
    await eventually(async () => assert.rejects((await (await load()).pages[0]()).load('de'), /Unsupported locale/));
    const invalid = async locale => {
      await guard(); const from = watch.log.length;
      await writeFile(join(root, `messages/${locale}.json`), '{"shared":"{broken"}');
      const failure = await watch.expect(from, 'ERROR');
      assert.match(failure.error.message, /closing brace|MALFORMED_ARGUMENT|EXPECT_ARGUMENT_CLOSING_BRACE/);
    };
    // Files that have never compiled successfully are not in catalogFiles yet.
    // Both repairing and removing them must still wake the build watcher.
    await invalid('de');
    await change(() => writeFile(join(root, 'messages/de.json'), JSON.stringify({ ...en, shared: 'REPAIRED_DE {n, number}' })));
    await eventually(async () => { [a, b] = await sharedPair('de'); assert.equal(a.messages.shared({ n: 2 }), 'REPAIRED_DE 2'); }); assert.equal(a.messages.shared, b.messages.shared);
    await invalid('it');
    // 'it' never compiled, so its absence is already observable. Wait for the rebuild instead.
    await change(() => unlink(join(root, 'messages/it.json')));
    await eventually(async () => assert.rejects((await (await load()).pages[0]()).load('it'), /Unsupported locale/));
    await invalid('en');
    await change(() => save('en'));
    await eventually(async () => { [a, b] = await sharedPair('en'); assert.equal(a.messages.shared({ n: 2 }), 'COMMON_EN 2'); }); assert.equal(a.messages.shared, b.messages.shared);
  } finally {
    // Close before the fixture removes the project: a watch build can still be writing src/i18n.
    await watcher.close();
    for (const file of new Set(events.flatMap(event => event.changed?.includes('nordbeam-locale-vite-watch-') ? [event.changed] : []))) {
      await assert.rejects(readFile(file), { code: 'ENOENT' });
    }
  }
  assert.ok(results.length >= 9);
});

test('watch caches follow active selections and removed selections can be restored', async t => {
  const original = Selections.prototype.load, instances = new Set();
  Selections.prototype.load = function (id) { instances.add(this); return original.call(this, id); };
  t.after(() => { Selections.prototype.load = original; });
  for (const shareMessages of [true, false]) {
    const { root, config, output } = await fixture(t);
    instances.clear();
    const watcher = await build({ ...config, plugins: [nordbeamLocale({ shareMessages })], build: { ...output, ssr: true, watch: {} } });
    const watch = watchLog(watcher);
    const entry = () => importBuild(root);
    try {
      await watch.expect(0, 'BUNDLE_END');
      // Every edit abandons the previous selection; null removes the route's
      // selector entirely. The final edit restores an earlier virtual ID.
      const choices = [['shared', 'b'], ['shared', 'unused'], ['shared', 'constructor'], ['shared', '__proto__'], null, ['shared', 'b']];
      for (const keys of choices) {
        // Throttle guard for repeated native events on src/b.js, not a settle wait.
        await delay(75);
        const source = keys ? `import {selectMessages} from './i18n/index.js';export const load=selectMessages(${keys.map(JSON.stringify).join(',')});`
          : 'export const load=async()=>({messages:{}});';
        // Let the previous rebuild finish before the next write can be observed.
        const from = watch.log.length;
        await writeFile(join(root, 'src/b.js'), source);
        await watch.expect(from, 'BUNDLE_END');
        let a, b;
        await eventually(async () => {
          const app = await entry();
          [a, b] = [await (await app.pages[0]()).load('fr'), await (await app.pages[1]()).load('fr')];
          assert.deepEqual(Object.keys(b.messages), keys ?? []);
        });
        if (keys) {
          assert.equal(b.messages.shared({ n: 2 }), 'COMMON_FR 2');
          if (shareMessages) assert.equal(a.messages.shared, b.messages.shared);
        }
        assert.equal(instances.size, 1);
        for (const instance of instances) {
          // Two current selections × (loader + two locales), or one after
          // removal. This catches growth independently of emitted output.
          assert.equal(instance.modules.size, keys ? 6 : 3);
          assert.ok(instance.loaded.size <= instance.modules.size);
        }
      }
    } finally { await watcher.close(); }
  }
});

test('an unchanged invalid catalog reports one watch error and repairs without a stale bridge error', async t => {
  const { root, en, config, output } = await fixture(t);
  const file = join(root, 'messages/de.json');
  await writeFile(file, JSON.stringify(en));
  const watcher = await build({ ...config, plugins: [nordbeamLocale({ baseLocale: 'en' })], build: { ...output, ssr: true, watch: {} } });
  const watch = watchLog(watcher);
  // Close before the fixture removes the project: a watch build can still be writing src/i18n.
  try {
    await watch.expect(0, 'BUNDLE_END');
    // Throttle guards for repeated native events on the same catalog.
    await delay(75); let from = watch.log.length; await unlink(file);
    await watch.expect(from, 'BUNDLE_END');
    await delay(75); from = watch.log.length; await writeFile(file, '{"shared":"{broken"}');
    const failure = await watch.expect(from, 'ERROR'); assert.match(failure.error.message, /INVALID_ICU/);
    // Quiescence window for a negative check: the same invalid input must not
    // produce a second attempt. A late duplicate still fails the final count.
    await delay(200);
    assert.equal(watch.log.filter(event => event.code === 'ERROR').length, 1);
    await delay(75); from = watch.log.length; await writeFile(file, JSON.stringify({ ...en, shared: 'REPAIRED {n, number}' }));
    await watch.expect(from, 'BUNDLE_END');
    const entry = await eventually(() => importBuild(root));
    for (const page of entry.pages) assert.equal((await (await page()).load('de')).messages.shared({ n: 2 }), 'REPAIRED 2');
    assert.equal(watch.log.filter(event => event.code === 'ERROR').length, 1);
  } finally { await watcher.close(); }
});

test('an atomic catalog replacement during the first watch build updates without another edit', async t => {
  const { root, fr, config, output } = await fixture(t);
  const plugin = nordbeamLocale({ baseLocale: 'en' }), start = plugin.buildStart;
  let first = true;
  plugin.buildStart = async function (...args) {
    await start.apply(this, args);
    if (!first) return;
    first = false;
    const file = join(root, 'messages/fr.tmp');
    await writeFile(file, JSON.stringify({ ...fr, shared: 'STARTUP_REPLACEMENT {n, number}' }));
    await rename(file, join(root, 'messages/fr.json'));
  };
  const results = [], errors = [];
  const watcher = await build({ ...config, plugins: [plugin, {
    name: 'startup-replacement-output',
    generateBundle(_options, bundle) {
      results.push(Object.values(bundle).filter(item => item.type === 'chunk').map(item => item.code).join('\n'));
    },
  }], build: { ...output, ssr: true, write: false, watch: {} } });
  try {
    watcher.on('event', event => { if (event.code === 'ERROR') errors.push(event.error); });
    await waitFor(() => results.at(-1)?.includes('STARTUP_REPLACEMENT'), 'Startup replacement left stale output', 20000);
    assert.deepEqual(errors, []);
    assert.doesNotMatch(results.at(-1), /COMMON_FR/);
  } finally { await watcher.close(); }
});

test('an unknown selected key fails a default shared build instead of waiting for discovery', async t => {
  const { config, output } = await fixture(t);
  await writeFile(join(config.root, 'src/a.js'), 'import {selectMessages} from "./i18n/index.js";export const load=selectMessages("shared","nope");');
  const failure = build({ ...config, plugins: [nordbeamLocale()], build: { ...output, write: false } }).then(() => assert.fail('build should reject'), error => error);
  const error = await Promise.race([failure, delay(10_000, undefined, { ref: false }).then(() => { throw new Error('build did not settle within 10 s'); })]);
  assert.match(error.message, /unknown selected message "nope"/);
});

test('a module written during an in-flight watch build is rebuilt without another native event', async t => {
  const { root, config, output } = await fixture(t);
  const probe = join(root, 'src/probe.js'), entry = join(root, 'src/probe-entry.js');
  await writeFile(probe, 'export const value = "OLD";');
  await writeFile(entry, 'import {value} from "./probe.js";export default value;');
  // The write lands after this build read probe.js, so its own output keeps OLD.
  let written = false;
  const outputs = [];
  const watcher = await build({ ...config, plugins: [nordbeamLocale(), {
    name: 'write-during-build',
    transform(code, id) {
      if (id === probe && !written) { written = true; writeFileSync(probe, 'export const value = "NEW";'); }
      return null;
    },
    generateBundle(_options, bundle) {
      outputs.push(Object.values(bundle).filter(item => item.type === 'chunk').map(item => item.code).join('\n'));
    },
  }], build: { ...output, write: false, ssr: true, rolldownOptions: { ...output.rolldownOptions, input: entry }, watch: {} } });
  try {
    await eventually(() => assert.ok(outputs.some(code => code.includes('OLD'))));
    await eventually(() => assert.ok(outputs.some(code => code.includes('NEW'))), 20000);
  } finally { await watcher.close(); }
});
