import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const repository = resolve(new URL('../..', import.meta.url).pathname);

/** Files below a directory whose text contains the sentinel; portable replacement for `rg -l`. */
async function filesContaining(directory, text) {
  const files = [];
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && (await readFile(join(entry.parentPath, entry.name), 'utf8')).includes(text)) files.push(join(entry.parentPath, entry.name));
  }
  return files;
}
const application = join(repository, 'examples/next');
const next = join(repository, 'node_modules/.bin/next');
const webpack = process.argv.includes('--webpack');
const environment = { ...process.env, NEXT_TELEMETRY_DISABLED: '1' };

const build = spawnSync(next, ['build', application, ...(webpack ? ['--webpack'] : [])], {
  cwd: repository,
  env: environment,
  encoding: 'utf8',
});
if (build.status !== 0) throw new Error(`${build.stdout}\n${build.stderr}`);

const scoped = await readFile(join(application, 'src/i18n/scopes/route/locales/en.js'), 'utf8');
const complete = await readFile(join(application, 'src/i18n/locales/en.js'), 'utf8');
assert.doesNotMatch(scoped, /UNUSED_NEXT_SENTINEL/);
assert.match(complete, /UNUSED_NEXT_SENTINEL/);
assert.deepEqual(await filesContaining(join(application, '.next/static'), 'UNUSED_NEXT_SENTINEL'), [], 'unused catalog text reached a client chunk');

const socket = createServer();
await new Promise((resolveListen, reject) => socket.once('error', reject).listen(0, '127.0.0.1', resolveListen));
const address = socket.address();
if (!address || typeof address === 'string') throw new Error('Could not reserve a Next.js test port');
const port = address.port;
await new Promise((resolveClose, reject) => socket.close(error => error ? reject(error) : resolveClose()));

const child = spawn(next, ['start', application, '-H', '127.0.0.1', '-p', String(port)], {
  cwd: repository,
  env: environment,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { output += chunk; });

async function request(path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: response.status, text: await response.text() };
}

try {
  const deadline = Date.now() + 20_000;
  while (true) {
    try { if ((await request('/static')).status === 200) break; } catch {}
    if (Date.now() > deadline) throw new Error(`Next.js server did not start:\n${output}`);
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }

  const [en, fr, ar, staticPage, invalid, edge, ...dynamic] = await Promise.all([
    request('/en'), request('/fr'), request('/ar'), request('/static'), request('/de'),
    request('/edge/fr'),
    request('/ssr/en'), request('/ssr/fr'), request('/ssr/ar'),
  ]);
  assert.equal(en.status, 200); assert.match(en.text, /<main[^>]*lang="en"[^>]*dir="ltr"/); assert.match(en.text, /Hello Server!/); assert.match(en.text, /<strong>server<\/strong>/); assert.match(en.text, /Hello Client!/); assert.match(en.text, /data-switch-locale="fr"/); assert.match(en.text, /data-client-locale/);
  assert.equal(fr.status, 200); assert.match(fr.text, /Bonjour Server !/); assert.match(fr.text, /Prise en charge de Next\.js/); assert.match(fr.text, /Bonjour Client !/);
  assert.equal(ar.status, 200); assert.match(ar.text, /<main[^>]*lang="ar"[^>]*dir="rtl"/); assert.match(ar.text, /مرحبًا Server!/); assert.match(ar.text, /دعم Next\.js/); assert.match(ar.text, /مرحبًا Client!/);
  assert.equal(staticPage.status, 200); assert.match(staticPage.text, /Hello Static!/);
  assert.equal(invalid.status, 404);
  assert.equal(edge.status, 200); assert.match(edge.text, /Bonjour Edge !/);
  assert.deepEqual(dynamic.map(result => result.status), [200, 200, 200]);
  assert.match(dynamic[0].text, /Hello SSR!/);
  assert.match(dynamic[1].text, /Bonjour SSR !/);
  assert.match(dynamic[2].text, /مرحبًا SSR!/);
  console.log(`Next.js 16 App Router passed with ${webpack ? 'webpack' : 'Turbopack'}: SSG, Node/Edge SSR, RSC rich output, locale-only client boundary, 404 validation, and scoped client bytes.`);
} finally {
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolveExit => child.once('exit', resolveExit)),
    new Promise(resolveTimeout => setTimeout(resolveTimeout, 2_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}
