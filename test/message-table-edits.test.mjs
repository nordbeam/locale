import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompiler, compileProject, compileSelection } from '../dist/compiler.js';
import { parseCatalogSnapshot } from '../dist/catalog-input.js';
import { createCompiler as previousCompiler, compileSelection as previousSelection } from './baselines/before_message_tables_v0_2/dist/compiler.js';
import { parseCatalogSnapshot as previousSnapshot } from './baselines/before_message_tables_v0_2/dist/catalog-input.js';
import { normalizeLegacyFormatterCacheOutput, normalizeLegacyProject } from './helpers.mjs';

const capture = fn => {
  try { return { project: fn() }; }
  catch (error) { return { name: error.name, message: error.message, diagnostics: error.diagnostics }; }
};

test('simultaneous text and contract edits preserve canonical tables through failures and key churn', t => {
  let states = 0;
  const ids = ['2', '10', '__proto__', 'é', '\ud800', '💡', ...Array.from({ length: 90 }, (_, i) => `page.m${i}`)];
  for (const owned of [false, true]) for (const maxMessageCacheBytes of [0, 256, 64 * 1024 * 1024]) for (const development of [false, true]) {
    const compile = createCompiler({ maxMessageCacheBytes }), previous = previousCompiler({ maxMessageCacheBytes });
    const catalogs = Object.fromEntries(['en', 'fr', 'ar'].map(locale => [locale,
      Object.fromEntries(ids.filter((_, i) => locale !== 'ar' || i % 2).map(id => [id, `${locale} ${id}: {value}`]))]));
    const prepare = parser => owned ? Object.fromEntries(Object.entries(catalogs).map(([locale, catalog]) => [locale, parser(JSON.stringify(catalog))])) : catalogs;
    const verify = (options = {}) => {
      const current = { baseLocale: 'en', development, ...options, catalogs: prepare(parseCatalogSnapshot) };
      const old = { ...current, catalogs: prepare(previousSnapshot) };
      const actual = capture(() => compile(current)), expected = capture(() => previous(old));
      assert.deepEqual(actual.project ? { ...actual, project: normalizeLegacyProject(actual.project) } : actual, expected); assert.deepEqual(actual, capture(() => compileProject(current)));
      if (actual.project) for (const locale of actual.project.locales) {
        const keys = Object.keys(catalogs.en).slice(0, 10).reverse();
        assert.equal(normalizeLegacyFormatterCacheOutput(compileSelection(actual.project, 'index.js', locale, keys)), previousSelection(expected.project, 'index.js', locale, keys));
      }
      states++;
    };
    verify(); verify();
    let revision = 0;
    for (const count of [1, 17, 32, 33, 64, 96, 2]) {
      revision++;
      for (const id of ids.slice(0, count)) catalogs.fr[id] = `Revision ${revision}: {value, number}`;
      verify(); verify({ timeZone: 'Asia/Tokyo' }); verify();
      // Change raw contracts again, including a sorted-late source error.
      for (const id of ids.slice(0, count)) catalogs.fr[id] = `Revision ${revision}: {value, date}`;
      catalogs.fr[ids[count - 1]] = '{broken'; verify();
      catalogs.fr[ids[count - 1]] = `Repaired ${revision}: {value, date}`; verify();
    }
    // Simultaneous insertion/removal keeps the size but changes the ID set.
    delete catalogs.en[ids[0]]; delete catalogs.fr[ids[0]]; delete catalogs.ar[ids[0]];
    catalogs.en.added = 'Added {value}'; catalogs.fr.added = 'Ajout {value, number}'; verify();
    catalogs.fr.unknown = 'Unknown {value}'; verify(); delete catalogs.fr.unknown; verify();
    delete catalogs.fr[ids[1]]; verify(); verify({ missing: 'error' }); verify();
    catalogs.en[ids[1]] = 'New base {value, number}'; verify();
    catalogs.fr[ids[1]] = 'Restored {value, number}'; verify();
    // Multiple failures must still choose the first canonical message ID.
    catalogs.fr['page.m9'] = '{broken'; catalogs.fr['page.m1'] = '{also_broken'; verify();
    catalogs.fr['page.m1'] = 'One {value}'; verify();
    catalogs.fr['page.m9'] = 'Nine {value}'; verify();
    catalogs.fr = Object.fromEntries(Object.entries(catalogs.fr).reverse()); verify();
    delete catalogs.ar; verify();
  }
  t.diagnostic(`${states} simultaneous-edit comparisons with cold and preceding compilers`);
});
