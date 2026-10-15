import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { getAgentCapabilities, getAgentGuide } from '../dist/agent.js';

const cli = (root, ...args) => spawnSync(process.execPath, [resolve('dist/cli.js'), ...args], { cwd: root, encoding: 'utf8' });

test('agent capabilities are versioned, complete, and classify mutations', () => {
  const result = getAgentCapabilities();
  assert.equal(result.protocolVersion, 1);
  assert.equal(result.locality, 'local-only');
  assert.deepEqual(new Set(result.commands.map(command => command.name)).size, result.commands.length);
  assert.equal(result.commands.find(command => command.name === 'doctor')?.access, 'read');
  assert.equal(result.commands.find(command => command.name === 'codemod')?.preview, true);
  assert.equal(result.commands.find(command => command.name === 'rename')?.access, 'write');
  assert.ok(result.formats.catalogs.includes('apple-xcstrings'));
  assert.ok(result.formats.sourceCodemods.includes('lingui'));
});

test('zero-config agent discovery works outside a Nordbeam project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nordbeam-agent-'));
  const result = cli(root, 'capabilities', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).protocolVersion, 1);

  const guide = cli(root, 'agent-guide');
  assert.equal(guide.status, 0, guide.stderr);
  assert.equal(guide.stdout, getAgentGuide());
  assert.match(guide.stdout, /doctor --json/);
});

test('JSON agent guide embeds the matching capability contract', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nordbeam-agent-json-'));
  const result = cli(root, 'agent-guide', '--json');
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.protocolVersion, output.capabilities.protocolVersion);
  assert.equal(output.guide, getAgentGuide());
});
