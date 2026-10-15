import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompiler, compileProject } from '../dist/compiler.js';
import { parseCatalogSnapshot } from '../dist/catalog-input.js';
import { createCompiler as precedingCompiler } from './baselines/before_snapshot_edits_v0_2/dist/compiler.js';
import { parseCatalogSnapshot as precedingSnapshot } from './baselines/before_snapshot_edits_v0_2/dist/catalog-input.js';
import { normalizeLegacyProject } from './helpers.mjs';

const capture = operation => {
  try { return { project: operation() }; }
  catch (error) { return { name: error.name, message: error.message, diagnostics: error.diagnostics }; }
};

test('owned JSON traversal preserves validation order and cached recovery across layout and source changes', t => {
  let checks = 0;
  for (const maxMessageCacheBytes of [0, 256, 64 * 1024 * 1024]) for (const development of [false, true]) {
    const compile = createCompiler({ maxMessageCacheBytes });
    const before = precedingCompiler({ maxMessageCacheBytes });
    const currentInputs = new Map(), oldInputs = new Map();
    const input = (texts, cache, parse, fresh) => Object.fromEntries(Object.entries(texts).map(([locale, text]) => {
      let entry = cache.get(locale);
      if (fresh || entry?.text !== text) { entry = { text, catalog: parse(text) }; cache.set(locale, entry); }
      return [locale, entry.catalog];
    }));
    const texts = {
      en: '{"page":{"hello":"Hi {name}","count":"{n, plural, one {One} other {#}}"},"plain":"Base","__proto__":"Prototype","2":"Two","10":"Ten"}',
      fr: '{"page":{"hello":"Salut {name}"},"plain":"French"}',
    };
    const verify = (fresh = false, extra = {}) => {
      const current = { baseLocale: 'en', development, ...extra, catalogs: input(texts, currentInputs, parseCatalogSnapshot, fresh) };
      const preceding = { ...current, catalogs: input(texts, oldInputs, precedingSnapshot, fresh) };
      const actual = capture(() => compile(current));
      const legacyActual = actual.project ? { ...actual, project: normalizeLegacyProject(actual.project) } : actual;
      assert.deepEqual(legacyActual, capture(() => before(preceding)));
      assert.deepEqual(actual, capture(() => compileProject(current)));
      checks++;
      return actual;
    };
    verify(); verify(); verify(true);
    texts.fr = '{"page.hello":"Bienvenue {name}","plain":"French","empty":{"nested":{}}}'; verify();
    texts.fr = '{"plain":"French","empty":{},"page":{"hello":"Bienvenue {name}"}}'; verify(); verify(true);
    texts.en = texts.en.replace('Base', 'Changed base'); verify();
    texts.fr = '{"page":{"hello":"{name, select, formal {Bonjour} other {Salut}}"},"plain":"French"}'; verify();
    texts.ja = texts.fr; verify(); delete texts.ja; verify();
    verify(false, { missing: 'error' }); verify();
    const valid = texts.en;
    for (const broken of [
      'null', '[]', 'false', '42', '"text"',
      '{"page":{"hello":"Hi {name}"},"bad":null,"later":[]}',
      '{"page":{"hello":"Hi {name}","bad":false},"later":42}',
      '{"page":{"hello":"Hi {name}"},"page.hello":"Hi {name}"}',
      '{"page.hello":"Hi {name}","page":{"hello":"Different {name}"}}',
      '{"page":{"hello":"Hi {name}","":"Empty"},"later":null}',
      '{"":"Empty","page":{"hello":"Hi {name}"}}',
      '{"page":{"hello":"{broken"},"bad":null}',
      '{"z":"{broken","a":"{also_broken"}',
    ]) {
      texts.en = broken; verify(); verify(true);
      texts.en = valid; verify();
    }
    texts.en = '{"page.hello":"Recovered {name}","plain":"Base","__proto__":"Prototype","2":"Two","10":"Ten"}'; verify();
    texts.fr = '{"plain":"French","page.hello":"Recovered {name}","__proto__":"Proto"}'; verify();
    const result = verify(true);
    result.project.locales.length = 0; result.project.groups['index.js'].length = 0;
    verify();
    texts.en = '{}'; texts.fr = '{}'; verify(); verify(true);
  }
  t.diagnostic(`${checks} owned-snapshot comparisons with cold and preceding compilers`);
});
