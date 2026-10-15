import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generate } from '../dist/project.js';
import { temporary } from './helpers.mjs';
import { startLsp } from './lsp-client.mjs';

test('language server hover shows each message base-locale source, escaped and truncated', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'messages'));
  const catalog = { greeting: 'Hello {name}!', 'checkout.total': 'Total {count, number}', tricky: 'End */ then @param {name}', long: 'word '.repeat(80) };
  await writeFile(join(root, 'messages/en.json'), JSON.stringify(catalog));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'tsconfig.json'), '{"compilerOptions":{"target":"ES2022","module":"NodeNext","strict":true,"types":[]},"include":["main.ts"]}');
  await generate({ root, baseLocale: 'en' });
  const text = "import {loadLocale} from './src/i18n/index.js';\nconst {messages:m}=await loadLocale('en');\nm.greeting({name:'Ada'});\nm['checkout.total']({count:2});\nm.tricky({name:'x'});\nm.long();\n";
  const file = join(root, 'main.ts');
  await writeFile(file, text);
  const uri = pathToFileURL(file).href;
  const lsp = await startLsp(root);
  try {
    lsp.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'typescript', version: 1, text } });
    const hover = async (line, character) => (await lsp.request('textDocument/hover', { textDocument: { uri }, position: { line, character } })).contents.value;
    assert.ok((await hover(2, 3)).includes('Hello {name}! — en'));
    assert.ok((await hover(3, 3)).includes('Total {count, number} — en'));
    // `*/` cannot end the comment, and a word-initial `@` must not start a JSDoc tag.
    assert.ok((await hover(4, 3)).includes('End *\\/ then ＠param {name} — en'));
    // Long source is clipped to 200 characters, including the ellipsis.
    const long = await hover(5, 3);
    assert.ok(long.endsWith(' — en') && long.includes('…'), long);
    const clipped = long.slice(long.lastIndexOf('=> string') + '=> string'.length, -' — en'.length);
    assert.equal([...clipped].length, 200);
  } finally { await lsp.close(); }
});
