import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAst } from 'rolldown/parseAst';
import { Selections } from '../dist/selection.js';
import { compileProject } from '../dist/compiler.js';

// @vitejs/plugin-vue is not installed, so these cover the ids and compiled
// code that plugin-vue hands to later transforms.
const project = { ...compileProject({ baseLocale: 'en', catalogs: { en: { alpha: 'ALPHA', beta: 'BETA' } } }), outDir: '/fixture/src/i18n' };
const code = 'import {loadLocale} from "./i18n/index.js";const {messages:m}=await loadLocale("en");export const v=m.alpha();';
const transform = (id, source = code) => new Selections(() => project).transform(source, id, parseAst,
  async () => '/fixture/src/i18n/index.js', () => {});

test('Vue script blocks without a lang suffix are narrowed', async () => {
  for (const id of ['/fixture/src/App.vue?vue&type=script&setup=true', '/fixture/src/App.vue?vue&type=script&lang.js', '/fixture/src/App.vue']) {
    const result = await transform(id);
    assert.ok(result, id);
    assert.match(result.code, /import \$nordbeamLocale0 from "virtual:nordbeam-locale\/selection\//);
  }
});

test('Vue style and template blocks are not selection-transformed', async () => {
  assert.equal(await transform('/fixture/src/App.vue?vue&type=style&index=0&lang.css', '.a{}'), undefined);
});

test('compiled Svelte modules are narrowed under their .svelte id', async () => {
  const result = await transform('/fixture/src/App.svelte');
  assert.match(result.code, /virtual:nordbeam-locale\/selection\//);
});
