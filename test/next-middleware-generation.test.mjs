import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readdir, unlink, utimes, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { temporary } from './helpers.mjs';

const nextModule = pathToFileURL(resolve('dist/next.js')).href;

// Mirrors the lock and stamp naming in src/next.ts: generation state lives in the
// project cache, never in the committed outDir.
const cacheOf = root => join(root, 'node_modules/.cache/nordbeam-locale');
const nameOf = root => `next-${createHash('sha256').update(resolve(root, 'generated')).digest('hex').slice(0, 16)}`;
const lockOf = root => join(cacheOf(root), `${nameOf(root)}.lock`);
const stampOf = root => join(cacheOf(root), `${nameOf(root)}.stamp`);
const buildFilesIn = async root => (await readdir(join(root, 'generated'))).filter(name => name.startsWith('.nordbeam-build'));

async function fixture(t, greeting = 'Hello {name}') {
  const root = await temporary(t);
  await mkdir(join(root, 'messages'));
  await writeFile(join(root, 'messages/en.json'), JSON.stringify({ greeting }));
  await writeFile(join(root, 'nordbeam-locale.config.json'), JSON.stringify({ baseLocale: 'en', outDir: 'generated' }));
  return root;
}

function runGeneration(root) {
  const script = `
    import { withNordbeamLocale } from ${JSON.stringify(nextModule)};
    await withNordbeamLocale({}, { root: ${JSON.stringify(root)} })('phase-production-build', {});
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
      env: { ...process.env, NODE_ENV: 'production', NORDBEAM_LOCALE_TRACE_GENERATION: '1' },
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => resolve({ code, stderr, events: events(stderr) }));
  });
}

function events(stderr) {
  return stderr.split('\n').flatMap(line => line.match(/next generation (\S+)/)?.[1] ?? []);
}

test('concurrent processes share one generation and the others skip on the stamp', async t => {
  const root = await fixture(t);
  const results = await Promise.all([runGeneration(root), runGeneration(root), runGeneration(root)]);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const all = results.flatMap(result => result.events);
  assert.equal(all.filter(event => event === 'generate').length, 1, all.join(','));
  assert.equal(all.filter(event => event === 'stamp-hit').length, 2, all.join(','));
  await access(stampOf(root));
  assert.deepEqual(await buildFilesIn(root), [], 'outDir must not contain generation lock or stamp files');
  await access(join(root, 'generated/internal/locales/en.js'));
});

test('an unchanged build skips regeneration and a catalog edit regenerates', async t => {
  const root = await fixture(t);
  assert.deepEqual((await runGeneration(root)).events, ['generate']);
  assert.deepEqual((await runGeneration(root)).events, ['stamp-hit']);
  await writeFile(join(root, 'messages/en.json'), JSON.stringify({ greeting: 'Welcome {name}' }));
  assert.deepEqual((await runGeneration(root)).events, ['generate']);
});

test('a lock held by a dead process is recovered', async t => {
  const root = await fixture(t);
  const deadPid = spawnSync(process.execPath, ['--eval', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim();
  await mkdir(cacheOf(root), { recursive: true });
  await writeFile(lockOf(root), JSON.stringify({ pid: Number(deadPid), createdAt: Date.now() }));
  const result = await runGeneration(root);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.events, ['generate']);
  await assert.rejects(access(lockOf(root)));
});

test('a lock older than 60 seconds is recovered even when its pid is alive', async t => {
  const root = await fixture(t);
  await mkdir(cacheOf(root), { recursive: true });
  const lock = lockOf(root);
  await writeFile(lock, JSON.stringify({ pid: process.pid, createdAt: 0 }));
  const old = new Date(Date.now() - 120_000);
  await utimes(lock, old, old);
  const result = await runGeneration(root);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.events, ['generate']);
});

test('a fresh lock held by a live process is waited for, not overwritten', async t => {
  const root = await fixture(t);
  await mkdir(cacheOf(root), { recursive: true });
  const lock = lockOf(root);
  await writeFile(lock, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
  let finished = false;
  const pending = runGeneration(root).then(result => { finished = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(finished, false, 'generation ran while a live process held the lock');
  await access(lock);
  await unlink(lock);
  const result = await pending;
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.events, ['generate']);
  assert.deepEqual(await buildFilesIn(root), [], 'outDir must not contain generation lock or stamp files');
});
