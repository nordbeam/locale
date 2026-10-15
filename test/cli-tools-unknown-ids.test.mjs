import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { doctor } from '../dist/cli-tools.js';
import { temporary } from './helpers.mjs';

async function project(t, source) {
  const root = await temporary(t);
  await mkdir(join(root, 'messages')); await mkdir(join(root, 'src'));
  await writeFile(join(root, 'messages/en.json'), JSON.stringify({ hello: 'Hello', checkout: { pay: 'Pay', total: 'Total' } }, null, 2) + '\n');
  await writeFile(join(root, 'messages/fr.json'), JSON.stringify({ hello: 'Salut', checkout: { pay: 'Payer', total: 'Total' } }, null, 2) + '\n');
  await writeFile(join(root, 'src/app.ts'), source);
  return root;
}

const unknownOf = result => result.errors.filter(error => error.code === 'UNKNOWN_MESSAGE_ID');

test('doctor reports an unknown bracket-literal message ID with location and suggestion', async t => {
  const root = await project(t, 'import m from "./i18n/messages.js";\nm["checkout.totl"]();\n');
  const result = await doctor({ root, baseLocale: 'en', catalogs: 'messages', sourceDir: 'src' });
  assert.equal(result.ok, false);
  const [error] = unknownOf(result);
  assert.equal(result.errors.length, 1);
  assert.equal(error.messageId, 'checkout.totl');
  assert.equal(error.file, join(root, 'src/app.ts'));
  assert.deepEqual(error.location, { line: 2, column: 1, offset: 36 });
  assert.equal(error.hint, 'Did you mean "checkout.total"?');
});

test('doctor reports an unknown nested dotted message ID', async t => {
  const root = await project(t, 'm.checkout.totl();\nm.hello();\n');
  const result = await doctor({ root, baseLocale: 'en', catalogs: 'messages', sourceDir: 'src' });
  const [error] = unknownOf(result);
  assert.equal(unknownOf(result).length, 1);
  assert.equal(error.messageId, 'checkout.totl');
  assert.equal(error.location.line, 1);
  assert.equal(error.location.column, 1);
  assert.equal(result.ok, false);
});

test('doctor flags unknown IDs on an explicitly imported messages binding', async t => {
  const root = await project(t, 'import messages from "./i18n/messages.js";\nmessages.hello(); messages.helo();\n');
  const result = await doctor({ root, baseLocale: 'en', catalogs: 'messages', sourceDir: 'src' });
  const [error] = unknownOf(result);
  assert.equal(error.messageId, 'helo');
  assert.equal(error.hint, 'Did you mean "hello"?');
});

test('a regular expression is not code: its m flag is not the messages object, and its quotes open no string', async t => {
  const root = await project(t, [
    'const a = /^export\\s+default\\b/m.test(source);',
    "const b = text.replace(/['\"]/g, '') && m.checkout.totl();",
    'const c = x => /[/]m/m.exec(x);',
    'const half = total / m.hello() / 2;',
    '<p>{m.hello()}</p><b>{m.helo()}</b>',
  ].join('\n'));
  const result = await doctor({ root, baseLocale: 'en', catalogs: 'messages', sourceDir: 'src' });
  assert.deepEqual(unknownOf(result).map(error => [error.messageId, error.location.line]), [['checkout.totl', 2], ['helo', 5]]);
});

test('doctor does not flag correct IDs, namespaces, dynamic keys or unknown objects', async t => {
  const root = await project(t, [
    'm.hello(); m.checkout.pay(); m["checkout.total"](); m.checkout["pay"]();',
    'm.checkout();',
    'const key = "checkout.pay"; m[key](); m[`checkout.${key}`](); m[`typo.${key}`]();',
    'const m = { checkout: { totl: () => 1 } }; m.checkout.totl();',
    'const api = { checkout: { totl() {} } }; api.checkout.totl(); api["checkout.totl"]();',
    '// m.checkout.totl() is only a comment\n',
  ].join('\n'));
  const result = await doctor({ root, baseLocale: 'en', catalogs: 'messages', sourceDir: 'src' });
  assert.deepEqual(unknownOf(result), []);
  assert.equal(result.ok, true);
});

test('doctor does not flag a file whose m is imported from another module', async t => {
  const root = await project(t, 'import { m } from "./ui.js";\nm.checkout.totl();\n');
  const result = await doctor({ root, baseLocale: 'en', catalogs: 'messages', sourceDir: 'src' });
  assert.deepEqual(unknownOf(result), []);
});
