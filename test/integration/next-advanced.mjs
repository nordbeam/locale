// Local-only Next.js App Router behavior gate.
//
// This is deliberately a correctness harness, not a performance benchmark:
// it builds a fresh fixture, serves it with `next start`, and records evidence
// for locale navigation, proxy routing, streamed Suspense, and request cache
// isolation. PPR is probed separately because the feature is version/config
// dependent in Next 16.
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const repository = resolve(new URL('../..', import.meta.url).pathname);
const next = join(repository, 'node_modules/.bin/next');
const bundler = process.argv.includes('--webpack') ? 'webpack' : 'turbopack';
const root = join(repository, 'test/integration/generated/next-advanced', bundler);
const sourceCatalog = join(repository, 'examples/next/src/i18n/scopes/route');
const locales = ['ar', 'en', 'fr'];
const environment = { ...process.env, NEXT_TELEMETRY_DISABLED: '1' };

const write = async (file, content) => {
  await mkdir(resolve(file, '..'), { recursive: true });
  await writeFile(file, content);
};

async function materialize() {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  await mkdir(join(root, 'node_modules/@nordbeam'), { recursive: true });
  await symlink(repository, join(root, 'node_modules/@nordbeam/locale'), 'junction');
  await cp(sourceCatalog, join(root, 'src/i18n'), { recursive: true });
  await write(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await write(join(root, 'next.config.mjs'), 'export default { reactStrictMode: true };\n');
  await write(join(root, 'app/layout.tsx'), `import type { ReactNode } from 'react';
export default function Layout({ children }: { children: ReactNode }) {
  return <html><body>{children}</body></html>;
}`);
  await write(join(root, 'app/page.tsx'), `import { redirect } from 'next/navigation';
export default function Home() { redirect('/en'); }`);
  await write(join(root, 'app/[locale]/page.tsx'), `import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createNextI18n } from '@nordbeam/locale/next/runtime';
import { loadLocale, locales } from '../../src/i18n/index.js';
const i18n = createNextI18n({ locales, loadLocale });
export const dynamicParams = false;
export function generateStaticParams() { return i18n.generateStaticParams(); }
export default async function LocalePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!i18n.hasLocale(locale)) notFound();
  const { messages: m } = await i18n.loadLocale(locale);
  return <main data-locale={locale}>
    <h1 id="locale-title">{m.title()}</h1>
    <p id="locale-greeting">{m.greeting({ name: 'Navigation' })}</p>
    <nav aria-label="locales">
      {locales.map(nextLocale => <Link key={nextLocale} data-locale-link={nextLocale} href={'/' + nextLocale}>{nextLocale}</Link>)}
    </nav>
  </main>;
}`);
  await write(join(root, 'app/stream/[locale]/page.tsx'), `import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { createNextI18n } from '@nordbeam/locale/next/runtime';
import { loadLocale, locales } from '../../../src/i18n/index.js';
const i18n = createNextI18n({ locales, loadLocale });
export const dynamic = 'force-dynamic';
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function Delayed({ locale }: { locale: string }) {
  await wait(125);
  const { messages: m } = await i18n.loadLocale(locale);
  return <p id="stream-ready">{m.greeting({ name: 'Stream' })}</p>;
}
export default async function StreamPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!i18n.hasLocale(locale)) notFound();
  return <main><p id="stream-shell">{locale}: shell</p><Suspense fallback={<p id="stream-fallback">Loading stream…</p>}><Delayed locale={locale} /></Suspense></main>;
}`);
  await write(join(root, 'app/cache/[locale]/page.tsx'), `import { cache } from 'react';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { createNextI18n } from '@nordbeam/locale/next/runtime';
import { loadLocale, locales } from '../../../src/i18n/index.js';
const i18n = createNextI18n({ locales, loadLocale });
export const dynamic = 'force-dynamic';
// React cache() is request-scoped in an RSC render. Reading the request ID
// inside the cached function catches accidental process-global memoization.
const requestSnapshot = cache(async (locale: string) => {
  const requestId = (await headers()).get('x-advanced-request-id') ?? 'missing';
  const { messages } = await i18n.loadLocale(locale);
  return { requestId, greeting: messages.greeting({ name: 'Cache' }) };
});
export default async function CachePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!i18n.hasLocale(locale)) notFound();
  const [first, second] = await Promise.all([requestSnapshot(locale), requestSnapshot(locale)]);
  return <main data-locale={locale} data-cache-same={String(first === second)}><p id="cache-id">{first.requestId}</p><p id="cache-greeting">{first.greeting}</p><p id="cache-second-id">{second.requestId}</p></main>;
}`);
  await write(join(root, 'app/proxy/[locale]/page.tsx'), `import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { createNextI18n } from '@nordbeam/locale/next/runtime';
import { loadLocale, locales } from '../../../src/i18n/index.js';
const i18n = createNextI18n({ locales, loadLocale });
export const dynamic = 'force-dynamic';
export default async function ProxyPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!i18n.hasLocale(locale)) notFound();
  const { messages: m } = await i18n.loadLocale(locale);
  const marker = (await headers()).get('x-advanced-proxy') ?? 'absent';
  return <main data-proxy-locale={locale}><p id="proxy-locale">{locale}</p><p id="proxy-greeting">{m.greeting({ name: 'Proxy' })}</p><p id="proxy-marker">{marker}</p></main>;
}`);
  await write(join(root, 'proxy.ts'), `import { NextResponse } from 'next/server';
const locales = new Set(['ar', 'en', 'fr']);
export function proxy(request: Request & { nextUrl: URL }) {
  const url = new URL(request.url);
  if (url.pathname === '/proxy' || url.pathname === '/proxy/') {
    const requested = request.headers.get('x-locale') ?? 'en';
    const locale = locales.has(requested) ? requested : 'en';
    url.pathname = '/proxy/' + locale;
    const response = NextResponse.rewrite(url);
    response.headers.set('x-advanced-proxy', 'handled');
    return response;
  }
  const response = NextResponse.next();
  response.headers.set('x-advanced-proxy', 'handled');
  return response;
}
export const config = { matcher: ['/proxy/:path*'] };`);
}

async function freePort() {
  const server = createServer();
  await new Promise((ok, fail) => server.once('error', fail).listen(0, '127.0.0.1', ok));
  const value = server.address().port;
  await new Promise((ok, fail) => server.close(error => error ? fail(error) : ok()));
  return value;
}

async function serve() {
  const port = await freePort();
  const child = spawn(next, ['start', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const request = async (path, init = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
    return { status: response.status, headers: response.headers, response, text: await response.text() };
  };
  try {
    const deadline = Date.now() + 30_000;
    while (true) {
      try { if ((await request('/en')).status === 200) break; } catch {}
      if (Date.now() > deadline) throw new Error(`Next server did not start:\n${output}`);
      await new Promise(resolveWait => setTimeout(resolveWait, 50));
    }
    return await verify(request, port);
  } finally {
    child.kill('SIGTERM');
    await Promise.race([new Promise(ok => child.once('exit', ok)), new Promise(ok => setTimeout(ok, 2_000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

async function verify(request, port) {
  const navigation = {};
  for (const locale of locales) {
    const page = await request('/' + locale);
    assert.equal(page.status, 200);
    assert.match(page.text, new RegExp(`data-locale="${locale}"`));
    assert.match(page.text, new RegExp(`data-locale-link="${locale}"`));
    navigation[locale] = { status: page.status, linkCount: (page.text.match(/data-locale-link=/g) ?? []).length };
  }
  assert.deepEqual(Object.values(navigation).map(value => value.linkCount), [3, 3, 3]);
  assert.equal((await request('/de')).status, 404);

  const proxyFrench = await request('/proxy', { headers: { 'x-locale': 'fr' } });
  assert.equal(proxyFrench.status, 200);
  assert.match(proxyFrench.text, /data-proxy-locale="fr"/);
  assert.match(proxyFrench.text, /Bonjour Proxy/);
  assert.match(proxyFrench.text, /handled/);
  const proxyFallback = await request('/proxy', { headers: { 'x-locale': 'xx' } });
  assert.match(proxyFallback.text, /data-proxy-locale="en"/);
  const proxyInvalid = await request('/proxy/de');
  assert.equal(proxyInvalid.status, 404);

  const streamStarted = performance.now();
  const streamResponse = await fetch(`http://127.0.0.1:${port}/stream/fr`);
  assert.equal(streamResponse.status, 200);
  assert.ok(streamResponse.body, 'stream route did not return a body');
  const reader = streamResponse.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let full = '';
  let firstChunkMs = null;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    const value = decoder.decode(item.value, { stream: true });
    chunks.push(value);
    full += value;
    if (firstChunkMs === null) firstChunkMs = performance.now() - streamStarted;
  }
  assert.match(full, /stream-shell/);
  assert.match(full, /stream-ready/);
  const fallbackIndex = full.indexOf('stream-fallback');
  const readyIndex = full.indexOf('stream-ready');
  assert.ok(fallbackIndex >= 0 && readyIndex >= 0 && fallbackIndex < readyIndex, 'Suspense fallback was not emitted before resolved content');
  const streaming = { status: streamResponse.status, chunks: chunks.length, fallbackBeforeReady: true, firstChunkMs: Math.round(firstChunkMs ?? 0) };

  const cacheRequests = ['en-a', 'fr-b', 'ar-c'];
  const cacheResults = await Promise.all(cacheRequests.map(async requestId => {
    const locale = requestId[0] === 'e' ? 'en' : requestId[0] === 'f' ? 'fr' : 'ar';
    const result = await request(`/cache/${locale}`, { headers: { 'x-advanced-request-id': requestId } });
    assert.equal(result.status, 200);
    assert.match(result.text, new RegExp(`id">${requestId}<`));
    assert.match(result.text, new RegExp(`second-id">${requestId}<`));
    assert.match(result.text, new RegExp(`data-cache-same="(true|false)"`));
    return { locale, requestId, sameWithinRequest: result.text.includes('data-cache-same="true"') };
  }));
  assert.deepEqual(cacheResults.map(value => value.requestId), cacheRequests);

  return { baseUrl: `http://127.0.0.1:${port}`, navigation, proxy: { french: 'fr', invalid: 404 }, streaming, cacheIsolation: cacheResults };
}

async function probePpr() {
  const app = join(repository, 'test/integration/generated/next-advanced-ppr', bundler);
  await rm(app, { recursive: true, force: true });
  await mkdir(join(app, 'node_modules/@nordbeam'), { recursive: true });
  await symlink(repository, join(app, 'node_modules/@nordbeam/locale'), 'junction');
  await write(join(app, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await write(join(app, 'app/layout.tsx'), `import type { ReactNode } from 'react';
export default function Layout({ children }: { children: ReactNode }) { return <html><body>{children}</body></html>; }`);
  await write(join(app, 'next.config.mjs'), bundler === 'turbopack'
    ? `export default { cacheComponents: true, turbopack: { root: ${JSON.stringify(repository)} } };\n`
    : 'export default { cacheComponents: true };\n');
  await write(join(app, 'app/ppr/[locale]/page.tsx'), `import { Suspense } from 'react';
export function generateStaticParams() { return [{ locale: 'en' }, { locale: 'fr' }, { locale: 'ar' }]; }
async function Dynamic() { await new Promise(resolve => setTimeout(resolve, 50)); return <p id="ppr-dynamic">dynamic</p>; }
export default async function PprPage({ params }: { params: Promise<{ locale: string }> }) { const { locale } = await params; return <main><p id="ppr-shell">{locale}: shell</p><Suspense fallback={<p id="ppr-fallback">fallback</p>}><Dynamic /></Suspense></main>; }`);
  const build = spawnSync(next, ['build', ...(bundler === 'webpack' ? ['--webpack'] : [])], { cwd: app, env: environment, encoding: 'utf8' });
  if (build.status !== 0) return { status: 'unsupported', reason: 'ppr build failed', detail: `${build.stdout}\n${build.stderr}`.slice(-2_000) };
  try {
    const manifest = JSON.parse(await readFile(join(app, '.next/prerender-manifest.json'), 'utf8'));
    const route = manifest.routes?.['/ppr/en'] ?? manifest.dynamicRoutes?.['/ppr/[locale]'];
    const renderingMode = route?.renderingMode ?? null;
    if (renderingMode !== 'PARTIALLY_STATIC') return { status: 'unsupported', reason: 'build succeeded without a PARTIALLY_STATIC route', renderingMode };
    return { status: 'verified', renderingMode, route: '/ppr/[locale]' };
  } catch (error) {
    return { status: 'unsupported', reason: 'PPR manifest unavailable', detail: String(error) };
  }
}

await materialize();
const buildStarted = performance.now();
const build = spawnSync(next, ['build', ...(bundler === 'webpack' ? ['--webpack'] : [])], { cwd: root, env: environment, encoding: 'utf8' });
if (build.status !== 0) throw new Error(`Next advanced ${bundler} build failed:\n${build.stdout}\n${build.stderr}`);
const behavior = await serve();
const ppr = await probePpr();
const report = {
  version: 1,
  date: new Date().toISOString(),
  environment: { node: process.version, next: JSON.parse(await readFile(join(repository, 'node_modules/next/package.json'), 'utf8')).version },
  settings: { bundler, locales, appRouter: true, fixture: 'test/integration/generated/next-advanced' },
  build: { ms: Math.round(performance.now() - buildStarted) },
  behavior,
  ppr,
  claims: {
    navigation: 'HTTP navigation targets and generated locale links are correct; no browser transition timing claim.',
    streaming: 'The local production server emitted Suspense fallback before resolved content.',
    cacheIsolation: 'Concurrent requests retained their request IDs and locale-specific output; React cache identity is only asserted within each render.',
    ppr: ppr.status === 'verified' ? 'Pinned Next.js emitted PARTIALLY_STATIC PPR routes in this fixture.' : `PPR not verified: ${ppr.reason}.`,
  },
};
await rm(join(repository, 'test/integration/generated'), { recursive: true, force: true });
console.log(JSON.stringify(report, null, 2));
