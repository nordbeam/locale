import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generate } from '../dist/project.js';
import { temporary } from './helpers.mjs';

test('large catalogs flatten their aggregate while public message types keep their names and assignability', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'messages'));
  const catalog = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [i % 2 ? `group.m${i}` : `m${i}`, `Message ${i} {count, number}`]));
  await writeFile(join(root, 'messages/en.json'), JSON.stringify(catalog));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await generate({ root, baseLocale: 'en' });
  const declaration = await readFile(join(root, 'src/i18n/messages.d.ts'), 'utf8');
  assert.match(declaration, /^interface \$Flat extends \$T0, \$T1 \{\}$/m);
  assert.match(declaration, /^type \$Messages = \{\[Key in keyof \$Flat\]: \$Flat\[Key\]\};$/m);
  const main = `
import {loadLocale, selectMessages} from './src/i18n/index.js';
import type {Messages, MessageId, SelectedMessages} from './src/i18n/messages.js';
const {messages:m}=await loadLocale('en');
const record: Record<string, unknown> = m;
const functions: Record<string, (...args: any[]) => string> = m;
const id: MessageId = 'm2';
const selected: SelectedMessages<'m2' | 'group.m3'> = (await selectMessages('m2', 'group.m3')('en')).messages;
const all: Messages = m;
selected.m2({count: 1}); selected['group.m3']({count: 2});
m['group.m3']({count: 2}); m.group.m3({count: 2});
// @ts-expect-error unknown message IDs are rejected
m['nope']();
// @ts-expect-error counts are required
m.m2({});
// @ts-expect-error the flattened view stays readonly
m.m2 = () => 'changed';
export { record, functions, id, all };
`;
  await writeFile(join(root, 'main.ts'), main);
  const result = spawnSync(resolve('node_modules/.bin/tsc'), ['--ignoreConfig', '--noEmit', '--strict', '--module', 'NodeNext', '--target', 'ES2022', join(root, 'main.ts')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
