import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAst } from 'rolldown/parseAst';
import { Selections } from '../dist/selection.js';
import { compileProject } from '../dist/compiler.js';

const project = { ...compileProject({ baseLocale: 'en', catalogs: { en: { alpha: 'ALPHA', beta: 'BETA' } } }), outDir: '/fixture/src/i18n' };
const paths = { './i18n/index.js': '/fixture/src/i18n/index.js', '$lib/i18n': '/fixture/src/i18n/index.js', 'other-lib': '/fixture/node_modules/other-lib/index.js' };

function probe(staticLocale) {
  const calls = { parsed: 0, resolved: [], warnings: [] };
  const selections = new Selections(() => project, () => staticLocale);
  const run = (code, id = '/fixture/src/main.js') => selections.transform(code, id,
    source => { calls.parsed++; return parseAst(source); },
    async source => { calls.resolved.push(source); return paths[source]; },
    message => calls.warnings.push(message));
  return { run, calls };
}

test('modules without a selector import skip parsing and resolution', async () => {
  const { run, calls } = probe();
  assert.equal(await run('function loadLocale(locale){return locale}export const value=loadLocale("en");'), undefined);
  assert.equal(await run('import {loadLocale} from "other-lib";export const value=loadLocale("en");'), undefined);
  assert.equal(await run('import {formatDate} from "./i18n/index.js";export const value=formatDate(loadLocale);'), undefined);
  assert.deepEqual(calls.resolved, ['other-lib']);
  assert.equal(calls.parsed, 0);
});

test('selector imports still narrow through aliases, multi-line clauses and quoted names', async () => {
  const { run, calls } = probe();
  const multiline = await run('import {\n  loadLocale,\n} from "$lib/i18n";\nconst {messages:m}=await loadLocale("en");\nexport const v=m.alpha();');
  assert.match(multiline.code, /\$nordbeamLocale0\("en"\)/);
  const quoted = await run('import { "loadLocale" as load } from "./i18n/index.js";\nconst {messages:m}=await load("en");\nexport const v=m.beta();');
  assert.match(quoted.code, /\$nordbeamLocale0\("en"\)/);
  const withDefault = await run('import loader, {selectMessages} from "./i18n/index.js";export const v=selectMessages("alpha");export default loader;');
  assert.match(withDefault.code, /selection\//);
  assert.equal(calls.parsed, 3);
});

test('parsing is limited to selector imports that resolve to the generated catalog', async () => {
  const { run, calls } = probe();
  assert.equal(await run('import {selectMessages} from "other-lib";export const v=selectMessages("alpha");'), undefined);
  assert.equal(calls.parsed, 0);
  assert.deepEqual(calls.resolved, ['other-lib']);
});

test('static locale still reports namespace imports of the generated catalog', async () => {
  const { run, calls } = probe('en');
  await run('import * as i18n from "./i18n/index.js";export const loader=i18n;');
  assert.equal(calls.parsed, 1);
  assert.equal(calls.warnings.length, 1);
  assert.match(calls.warnings[0], /namespace import/);
  await run('import * as lib from "other-lib";export const value=lib;');
  assert.equal(calls.parsed, 1);
});
