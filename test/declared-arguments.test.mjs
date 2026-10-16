import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkProject, compileProject, createCompiler, CompileError } from '../dist/compiler.js';
import { validateConfig } from '../dist/config.js';
import { compiled } from './helpers.mjs';

// The base text leaves the price out; the Finnish text shows it, and the call passes it in every locale.
const catalogs = {
  en: { pricing: { subtitle: 'Cancel anytime', title: 'Plans' } },
  fi: { pricing: { subtitle: 'Alkaen {price}/kk, peru milloin vain', title: 'Tilaukset' } },
};
const declared = { 'pricing.subtitle': { price: 'value' } };

test('a translation may use an argument the configuration declares for its message', async t => {
  const project = await compiled(t, { baseLocale: 'en', catalogs, arguments: declared, development: true });
  const en = (await project.load('locales/en.js')).default;
  const fi = (await project.load('locales/fi.js')).default;
  assert.equal(fi['pricing.subtitle']({ price: '22 €' }), 'Alkaen 22 €/kk, peru milloin vain');
  assert.equal(en['pricing.subtitle']({ price: '22 €' }), 'Cancel anytime');
  // The argument is part of the contract in every locale, so development output checks it in the base locale too.
  assert.throws(() => en['pricing.subtitle']({}), /price/);
  const types = Object.entries(project.files).filter(([file]) => file.endsWith('.d.ts')).map(([, code]) => code).join('\n');
  assert.match(types, /readonly "price": string \| number/);
  assert.equal(project.warnings.length, 0);
});

test('without the declaration the translation is UNKNOWN_ARGUMENT, and the hint names the config', () => {
  assert.throws(() => compileProject({ baseLocale: 'en', catalogs }), error => {
    assert.ok(error instanceof CompileError);
    const [diagnostic] = error.diagnostics;
    assert.equal(diagnostic.code, 'UNKNOWN_ARGUMENT');
    assert.equal(diagnostic.locale, 'fi');
    assert.match(diagnostic.hint, /"arguments": \{ "pricing\.subtitle": \{ "price": "value" \} \}/);
    return true;
  });
  const checked = checkProject({ baseLocale: 'en', catalogs });
  assert.deepEqual(checked.errors.map(item => item.code), ['UNKNOWN_ARGUMENT']);
  assert.match(checked.errors[0].hint, /declare it in the config/);
  assert.deepEqual(checkProject({ baseLocale: 'en', catalogs, arguments: declared }).errors, []);
});

test('declarations name base messages, take the argument kinds, and merge with the translation\'s use', () => {
  const unknown = checkProject({ baseLocale: 'en', catalogs, arguments: { ...declared, 'pricing.gone': { price: 'value' } } });
  assert.deepEqual(unknown.errors.map(item => [item.code, item.messageId]), [['UNKNOWN_MESSAGE', 'pricing.gone']]);
  assert.throws(() => compileProject({ baseLocale: 'en', catalogs, arguments: { 'pricing.gone': { price: 'value' } } }), error => error.diagnostics[0].code === 'UNKNOWN_MESSAGE');
  assert.throws(() => compileProject({ baseLocale: 'en', catalogs, arguments: { 'pricing.subtitle': { price: 'currency' } } }), error => error.diagnostics[0].code === 'INVALID_DECLARED_ARGUMENT');
  // A number declaration takes a number; a translation that formats it as a number agrees with it.
  const numeric = { ...catalogs, fi: { pricing: { subtitle: 'Alkaen {price, number, ::currency/EUR}/kk', title: 'Tilaukset' } } };
  const project = compileProject({ baseLocale: 'en', catalogs: numeric, arguments: { 'pricing.subtitle': { price: 'number' } } });
  assert.match(Object.values(project.files).join('\n'), /readonly "price": number/);
  // A date declaration conflicts with a translation that formats the argument as a number.
  assert.throws(() => compileProject({ baseLocale: 'en', catalogs: numeric, arguments: { 'pricing.subtitle': { price: 'date' } } }), error => error.diagnostics[0].code === 'ARGUMENT_TYPE_CONFLICT');
});

test('an incremental compiler recompiles contracts when the declarations change', () => {
  const compile = createCompiler();
  assert.throws(() => compile({ baseLocale: 'en', catalogs }), error => error.diagnostics[0].code === 'UNKNOWN_ARGUMENT');
  const first = compile({ baseLocale: 'en', catalogs, arguments: declared });
  assert.match(Object.values(first.files).join('\n'), /"price"/);
  assert.throws(() => compile({ baseLocale: 'en', catalogs }), error => error.diagnostics[0].code === 'UNKNOWN_ARGUMENT');
});

test('the config validates arguments', () => {
  validateConfig({ arguments: declared });
  assert.throws(() => validateConfig({ arguments: { 'pricing.subtitle': { price: 'string' } } }), /arguments\.pricing\.subtitle\.price must be "value", "number" or "date"/);
  assert.throws(() => validateConfig({ arguments: { 'pricing.subtitle': {} } }), /nonempty object/);
  assert.throws(() => validateConfig({ arguments: { 'pricing.subtitle': { 'not a name': 'value' } } }), /not an argument name/);
  assert.throws(() => validateConfig({ arguments: [] }), /arguments must be an object/);
});

test('inspect --id lists a declared argument after the ones the base text uses', async t => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { spawnSync } = await import('node:child_process');
  const { temporary } = await import('./helpers.mjs');
  const root = await temporary(t);
  await mkdir(join(root, 'messages'));
  for (const [locale, catalog] of Object.entries(catalogs)) await writeFile(join(root, `messages/${locale}.json`), JSON.stringify(catalog));
  await writeFile(join(root, 'nordbeam-locale.config.json'), JSON.stringify({ arguments: declared }));
  const cli = new URL('../dist/cli.js', import.meta.url).pathname;
  const result = spawnSync(process.execPath, [cli, 'inspect', '--id', 'pricing.subtitle', '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).arguments, [{ name: 'price', type: 'value', choices: [], declared: true }]);
  assert.equal(spawnSync(process.execPath, [cli, 'check'], { cwd: root, encoding: 'utf8' }).status, 0);
});
