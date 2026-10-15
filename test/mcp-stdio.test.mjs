import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { temporary } from './helpers.mjs';

test('the mcp binary speaks JSON lines on stdout only and exits cleanly when stdin closes', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'messages'), { recursive: true });
  await writeFile(join(root, 'messages/en.json'), JSON.stringify({ hello: 'Hello' }));
  const bin = resolve(import.meta.dirname, '../dist/mcp-bin.js');
  const child = spawn(process.execPath, [bin, '--root', root], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
  child.stdin.end();
  const { code, signal } = await exited;
  assert.equal(code, 0, stderr);
  assert.equal(signal, null);
  assert.equal(stderr, '');
  const lines = stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  const [init, list] = lines.map(line => JSON.parse(line));
  assert.equal(init.id, 1);
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(list.id, 2);
  assert.ok(list.result.tools.some(tool => tool.name === 'check'));
});

test('the mcp binary reports bad flags on stderr and exits 1', async () => {
  const bin = resolve(import.meta.dirname, '../dist/mcp-bin.js');
  const child = spawn(process.execPath, [bin, '--nope'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise(resolve => child.on('exit', resolve));
  child.stdin.end();
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /nordbeam-locale-mcp:/);
});

test('nordbeam-locale mcp serves the same tools from the main CLI, with clean stdout', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'messages'), { recursive: true });
  await writeFile(join(root, 'messages/en.json'), JSON.stringify({ hello: 'Hello {name}' }));
  await writeFile(join(root, 'nordbeam-locale.config.json'), JSON.stringify({ baseLocale: 'en', catalogs: 'messages', outDir: 'generated' }));
  const cli = resolve(import.meta.dirname, '../dist/cli.js');
  const child = spawn(process.execPath, [cli, 'mcp'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: '' } });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => child.on('exit', resolve));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'inspect_message', arguments: { id: 'hello' } } })}\n`);
  child.stdin.end();
  assert.equal(await exited, 0, stderr);
  assert.equal(stderr, '');
  const [init, call] = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(init.result.serverInfo.name, 'nordbeam-locale');
  assert.deepEqual(call.result.structuredContent.arguments.map(item => item.name), ['name']);
});
