import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mcpTools, serveMcp } from '../dist/mcp.js';
import { temporary } from './helpers.mjs';

async function project(t, files = {}) {
  const root = await temporary(t);
  await mkdir(join(root, 'messages'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  const defaults = {
    'messages/en.json': { hello: 'Hello {name}', bye: 'Bye' },
    'messages/fr.json': { hello: 'Bonjour {name}', bye: 'Au revoir' },
    'src/app.ts': "import messages from './i18n/messages.js';\nmessages['hello']({ name: 'Ada' });\nmessages['bye']();\n",
  };
  for (const [file, content] of Object.entries({ ...defaults, ...files })) {
    await writeFile(join(root, file), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return root;
}

function connect(t, options) {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = [];
  const waiters = [];
  let buffer = '';
  output.on('data', chunk => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (waiters.length) waiters.shift()(message);
      else messages.push(message);
    }
  });
  const served = serveMcp({ ...options, input, output });
  t.after(() => input.end());
  const next = () => messages.length ? Promise.resolve(messages.shift()) : new Promise(resolve => waiters.push(resolve));
  let id = 0;
  return {
    served,
    notify: message => input.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`),
    async request(method, params) {
      const requestId = ++id;
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
      const response = await next();
      assert.equal(response.id, requestId);
      return response;
    },
    async tool(name, args = {}) {
      const response = await this.request('tools/call', { name, arguments: args });
      assert.equal(response.error, undefined, JSON.stringify(response.error));
      return response.result;
    },
    raw(line) {
      input.write(`${line}\n`);
      return next();
    },
    end: () => input.end(),
  };
}

test('initialize echoes a supported protocol version and falls back for unknown ones', async t => {
  const root = await project(t);
  const client = connect(t, { root });
  const echoed = await client.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.equal(echoed.result.protocolVersion, '2025-03-26');
  assert.deepEqual(echoed.result.capabilities, { tools: { listChanged: false } });
  assert.equal(echoed.result.serverInfo.name, 'nordbeam-locale');
  assert.match(echoed.result.serverInfo.version, /^\d+\.\d+\.\d+/);
  assert.match(echoed.result.instructions, /check/);
  const fallback = await client.request('initialize', { protocolVersion: '1999-01-01' });
  assert.equal(fallback.result.protocolVersion, '2025-06-18');
});

test('notifications get no response and ping answers an empty result', async t => {
  const root = await project(t);
  const client = connect(t, { root });
  client.notify({ method: 'notifications/initialized' });
  client.notify({ method: 'notifications/unknown' });
  const pong = await client.request('ping');
  assert.deepEqual(pong.result, {});
});

test('tools/list describes every tool with an object input schema and annotations', async t => {
  const root = await project(t);
  const client = connect(t, { root });
  const listed = await client.request('tools/list');
  const names = listed.result.tools.map(tool => tool.name);
  assert.deepEqual(names, ['check', 'generate', 'inspect_project', 'inspect_message', 'explain_code', 'rename_message', 'find_unused']);
  for (const tool of listed.result.tools) {
    assert.equal(tool.inputSchema.type, 'object', tool.name);
    assert.equal(tool.outputSchema.type, 'object', tool.name);
    assert.equal(typeof tool.title, 'string');
    assert.equal(tool.annotations.openWorldHint, false);
    assert.equal(typeof tool.annotations.readOnlyHint, 'boolean');
  }
  assert.equal(listed.result.tools.find(tool => tool.name === 'check').annotations.readOnlyHint, true);
  assert.equal(listed.result.tools.find(tool => tool.name === 'rename_message').annotations.readOnlyHint, false);
  assert.equal(mcpTools.length, names.length);
});

test('check reports an ICU error as a result with its code, location and fix', async t => {
  const root = await project(t, { 'messages/en.json': { hello: 'Hello {name', bye: 'Bye' } });
  const client = connect(t, { root });
  const result = await client.tool('check');
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.ok, false);
  assert.equal(result.structuredContent.errorCount, 1);
  const [error] = result.structuredContent.errors;
  assert.equal(error.code, 'INVALID_ICU');
  assert.equal(error.file, 'messages/en.json');
  assert.equal(error.locale, 'en');
  assert.equal(typeof error.fix, 'string');
  assert.equal(error.docs, 'docs/reference/errors.md#invalid_icu');
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
});

test('check passes a valid project and limits diagnostics', async t => {
  const root = await project(t);
  const client = connect(t, { root });
  const result = await client.tool('check', { limit: 1 });
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.errorCount, 0);
});

test('inspect_project summarizes locales and freshness with a compact result', async t => {
  const root = await project(t);
  const client = connect(t, { root });
  const { structuredContent: summary } = await client.tool('inspect_project');
  assert.equal(summary.ok, true);
  assert.equal(summary.config, 'nordbeam-locale.config.json');
  assert.equal(summary.messageCount, 4);
  assert.deepEqual(summary.locales, ['en', 'fr']);
  assert.equal(summary.freshness.status, 'missing');
  assert.equal(summary.catalogs.find(item => item.locale === 'fr').missingCount, 0);
});

test('generate writes output and reports project-relative changed paths', async t => {
  const root = await project(t);
  const client = connect(t, { root });
  const { structuredContent: result } = await client.tool('generate');
  assert.ok(result.count > 0);
  assert.equal(result.changed.length, result.count);
  for (const file of result.changed) {
    assert.equal(file.startsWith('/'), false, file);
    assert.equal(file.includes('\\'), false, file);
  }
  assert.ok(result.changed.some(file => file.startsWith('src/i18n/')));
});

test('inspect_message describes one message across catalogs', async t => {
  const root = await project(t);
  const client = connect(t, { root });
  const { structuredContent: message } = await client.tool('inspect_message', { id: 'hello' });
  assert.equal(message.id, 'hello');
  assert.deepEqual(message.present, ['en', 'fr']);
  assert.deepEqual(message.missing, []);
  assert.deepEqual(message.arguments.map(argument => argument.name), ['name']);
  assert.equal(message.locales.find(item => item.locale === 'en').source, 'Hello {name}');
  assert.equal(message.locales.find(item => item.locale === 'en').file, 'messages/en.json');
});

test('inspect_message on an unknown ID is an isError result with UNKNOWN_MESSAGE_ID', async t => {
  const root = await project(t);
  const client = connect(t, { root });
  const result = await client.tool('inspect_message', { id: 'missing.id' });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, 'UNKNOWN_MESSAGE_ID');
  assert.equal(typeof result.structuredContent.fix, 'string');
  assert.equal(result.structuredContent.docs, 'docs/reference/errors.md#unknown_message_id');
});

test('explain_code explains a known code case-insensitively and lists matches for an unknown one', async t => {
  const root = await project(t);
  const client = connect(t, { root });
  const known = await client.tool('explain_code', { code: 'invalid_icu' });
  assert.equal(known.isError, undefined);
  assert.equal(known.structuredContent.code, 'INVALID_ICU');
  assert.equal(known.structuredContent.severity, 'error');
  assert.match(known.structuredContent.explanation, /ICU/);
  assert.equal(typeof known.structuredContent.fix, 'string');
  const unknown = await client.tool('explain_code', { code: 'INVALID_IC' });
  assert.equal(unknown.isError, true);
  assert.equal(unknown.structuredContent.code, 'USAGE');
  assert.ok(unknown.structuredContent.suggestions.includes('INVALID_ICU'));
  assert.ok(unknown.structuredContent.suggestions.length <= 5);
});

test('rename_message updates every catalog and regenerates output', async t => {
  const root = await project(t);
  const client = connect(t, { root });
  const { structuredContent: result } = await client.tool('rename_message', { from: 'hello', to: 'greeting' });
  assert.equal(result.stale, false);
  assert.equal(result.regenerated, true);
  assert.deepEqual(result.locales.sort(), ['en', 'fr']);
  const en = JSON.parse(await readFile(join(root, 'messages/en.json'), 'utf8'));
  const fr = JSON.parse(await readFile(join(root, 'messages/fr.json'), 'utf8'));
  assert.equal(en.greeting, 'Hello {name}');
  assert.equal(fr.greeting, 'Bonjour {name}');
  assert.equal('hello' in en, false);
  assert.match(await readFile(join(root, 'src/app.ts'), 'utf8'), /messages\['greeting'\]/);
  const generated = await readFile(join(root, 'src/i18n/messages.d.ts'), 'utf8');
  assert.match(generated, /greeting/);
  assert.doesNotMatch(generated, /"hello"/);
});

test('rename_message without regenerate marks output stale and reports the next command', async t => {
  const root = await project(t);
  const client = connect(t, { root });
  const { structuredContent: result } = await client.tool('rename_message', { from: 'bye', to: 'farewell', regenerate: false });
  assert.equal(result.regenerated, false);
  assert.equal(result.stale, true);
  assert.equal(result.next, 'nordbeam-locale generate');
});

test('rename_message to an existing ID is an isError result', async t => {
  const root = await project(t);
  const client = connect(t, { root });
  const result = await client.tool('rename_message', { from: 'hello', to: 'bye' });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, 'MESSAGE_ALREADY_EXISTS');
});

test('find_unused lists unreferenced IDs and unknown source references', async t => {
  const root = await project(t, { 'src/app.ts': "import messages from './i18n/messages.js';\nmessages['hello']({ name: 'Ada' });\nmessages['gone']({ name: 'Ada' });\n" });
  const client = connect(t, { root });
  const { structuredContent: result } = await client.tool('find_unused');
  assert.deepEqual(result.unused, ['bye']);
  assert.equal(result.unusedCount, 1);
  assert.equal(result.unknownReferenceCount, 1);
  assert.equal(result.unknownReferences[0].code, 'UNKNOWN_MESSAGE_ID');
  assert.equal(result.unknownReferences[0].file, 'src/app.ts');
});

test('a bad line gets a parse error with a null id and the server keeps going', async t => {
  const root = await project(t);
  const client = connect(t, { root });
  const parse = await client.raw('{"jsonrpc":"2.0",');
  assert.equal(parse.id, null);
  assert.equal(parse.error.code, -32700);
  const pong = await client.request('ping');
  assert.deepEqual(pong.result, {});
});

test('protocol problems are JSON-RPC errors: unknown method, unknown tool and invalid arguments', async t => {
  const root = await project(t);
  const client = connect(t, { root });
  const unknownMethod = await client.request('resources/list');
  assert.equal(unknownMethod.error.code, -32601);
  const unknownTool = await client.request('tools/call', { name: 'nope', arguments: {} });
  assert.equal(unknownTool.error.code, -32602);
  const missingId = await client.request('tools/call', { name: 'inspect_message', arguments: {} });
  assert.equal(missingId.error.code, -32602);
  assert.match(missingId.error.message, /id is required/);
  const extra = await client.request('tools/call', { name: 'check', arguments: { nope: true } });
  assert.equal(extra.error.code, -32602);
  const badType = await client.request('tools/call', { name: 'check', arguments: { limit: 'ten' } });
  assert.equal(badType.error.code, -32602);
});

test('an invalid request object gets -32600', async t => {
  const root = await project(t);
  const client = connect(t, { root });
  const response = await client.raw('{"id":3,"method":"ping"}');
  assert.equal(response.error.code, -32600);
  assert.equal(response.id, 3);
});

test('an invalid config file is an isError result with INVALID_CONFIG', async t => {
  const root = await project(t, { 'nordbeam-locale.config.json': '{' });
  const client = connect(t, { root });
  const result = await client.tool('check');
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, 'INVALID_CONFIG');
});

test('config edits are picked up on the next call without restarting', async t => {
  const root = await project(t);
  const client = connect(t, { root });
  const before = await client.tool('inspect_project');
  assert.equal(before.structuredContent.baseLocale, 'en');
  await writeFile(join(root, 'nordbeam-locale.config.json'), JSON.stringify({ baseLocale: 'fr' }));
  const after = await client.tool('inspect_project');
  assert.equal(after.structuredContent.baseLocale, 'fr');
});
