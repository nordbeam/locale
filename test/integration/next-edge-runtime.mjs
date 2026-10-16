import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { cpus } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { gzipSync } from 'node:zlib';
import { EdgeVM } from '@edge-runtime/vm';

const repository = resolve(new URL('../..', import.meta.url).pathname);
const application = join(repository, 'examples/next');
const next = join(repository, 'node_modules/.bin/next');
const require = createRequire(import.meta.url);
const rounds = Number(process.env.NEXT_EDGE_ROUNDS ?? 1);
const environment = { ...process.env, NEXT_TELEMETRY_DISABLED: '1' };
const forbiddenUserImports = [
  'node:fs',
  'node:path',
  'node:module',
  'node:child_process',
  'node:net',
  'node:os',
  'node:crypto',
  'node:buffer',
  'node:util',
  'node:async_hooks',
  'next/navigation',
  'next/headers',
];

if (!Number.isInteger(rounds) || rounds < 1) throw new Error('Invalid NEXT_EDGE_ROUNDS');

async function buildNext(bundler) {
  const samples = [];
  for (let round = 0; round < rounds; round++) {
    const started = performance.now();
    const args = ['build', application];
    if (bundler === 'webpack') args.push('--webpack');
    const result = spawnSync(next, args, {
      cwd: repository,
      env: environment,
      encoding: 'utf8',
    });
    samples.push(performance.now() - started);
    if (result.status !== 0) {
      throw new Error(`${bundler} Edge build failed:\n${result.stdout}\n${result.stderr}`);
    }
  }
  samples.sort((a, b) => a - b);
  return { samples, median: samples[Math.floor(samples.length / 2)] };
}

async function inspectArtifact(bundler) {
  const functionsManifest = JSON.parse(await readFile(
    join(application, '.next/server/functions-config-manifest.json'),
    'utf8',
  ));
  const topMiddleware = JSON.parse(await readFile(
    join(application, '.next/server/middleware-manifest.json'),
    'utf8',
  ));
  const routeManifestPath = join(
    application,
    '.next/server/app/edge/[locale]/page/middleware-manifest.json',
  );
  const middleware = await readFile(routeManifestPath, 'utf8')
    .then(value => JSON.parse(value), () => topMiddleware);
  const functionManifest = middleware.functions['/edge/[locale]/page'];
  if (!functionManifest) throw new Error(`Missing Edge function manifest for ${bundler}`);
  const routeFiles = functionManifest.files.filter(file => /\.js(?:\.map)?$/.test(file));
  const codeFiles = routeFiles
    .filter(file => file.endsWith('.js'))
    .map(file => join(application, '.next', file));
  const code = await Promise.all(codeFiles.map(file => readFile(file, 'utf8')));
  const entrypoint = join(application, '.next', functionManifest.entrypoint);
  const sourceMap = await stat(`${entrypoint}.map`).then(() => true, () => false);
  const frameworkSpecifiersSeen = forbiddenUserImports.filter(specifier =>
    code.some(source => source.includes(specifier)),
  );
  const bytes = {
    files: codeFiles.length,
    raw: code.reduce((sum, source) => sum + Buffer.byteLength(source), 0),
    gzip: code.reduce((sum, source) => sum + gzipSync(source).length, 0),
  };
  assert.ok(functionsManifest.functions['/edge/[locale]']);
  return {
    route: '/edge/[locale]',
    entry: functionManifest.entrypoint,
    routeFiles,
    sourceMap,
    edgeBundleBytes: bytes,
    forbiddenUserImports,
    frameworkSpecifiersSeen,
    note: 'The complete Next route graph includes framework-owned compatibility shims; only generated user modules are required to be import-free by the isolate gate.',
  };
}

function asIsolateCatalog(source, locale) {
  const body = source.replace('export default messages;',
    `globalThis.__catalogs[${JSON.stringify(locale)}] = messages;`);
  return `(() => { ${body} })();`;
}

async function runIsolate() {
  const read = path => readFile(join(repository, path), 'utf8');
  const runtimeSource = (await read('packages/locale/dist/next-runtime.js')).replace(/\bexport\s+/g, '');
  const scopePath = 'examples/next/src/i18n/scopes/route/index.js';
  let scopeSource = await read(scopePath);
  // The generated scope uses native dynamic import. EdgeVM intentionally has no
  // module loader, so bridge those imports to the generated modules evaluated in
  // this same isolate. The message functions themselves are unmodified.
  scopeSource = scopeSource
    .replace(/\bexport\s+/g, '')
    .replaceAll(
      /\(\)\s*=>\s*import\("\.\/internal\/locales\/(ar|en|fr)\.js"\)/g,
      (_, locale) => `() => Promise.resolve({ default: globalThis.__catalogs[${JSON.stringify(locale)}] })`,
    );
  const localeSources = await Promise.all(['ar', 'en', 'fr'].map(async locale => ({
    locale,
    source: await read(`examples/next/src/i18n/scopes/route/internal/locales/${locale}.js`),
  })));
  const catalogSource = localeSources
    .map(({ locale, source }) => asIsolateCatalog(source, locale))
    .join('\n');
  const generatedSources = [runtimeSource, scopeSource, ...localeSources.map(row => row.source)];
  const forbiddenInGenerated = forbiddenUserImports.filter(specifier =>
    generatedSources.some(source => source.includes(specifier)),
  );
  assert.deepEqual(forbiddenInGenerated, [], `Node/Next import reached generated user code: ${forbiddenInGenerated}`);

  const isolateScript = `
    globalThis.__catalogs = Object.create(null);
    ${catalogSource}
    ${scopeSource}
    ${runtimeSource}
    const i18n = createNextI18n({ locales, loadLocale });
    addEventListener('fetch', event => {
      const parts = new URL(event.request.url).pathname.split('/').filter(Boolean);
      const locale = parts[0] === 'edge' ? parts[1] : undefined;
      if (!i18n.hasLocale(locale)) {
        event.respondWith(new Response('Not Found', { status: 404 }));
        return;
      }
      event.respondWith(i18n.loadLocale(locale).then(({ messages }) => new Response(
        JSON.stringify({
          locale,
          title: messages.title(),
          greeting: messages.greeting({ name: 'Edge' }),
          items: messages.items({ count: 2 }),
          rich: messages.richNote({ strong: children => ['<strong>', ...children, '</strong>'] }),
        }),
        { headers: { 'content-type': 'application/json' } },
      )));
    });
  `;
  const vm = new EdgeVM();
  const started = performance.now();
  vm.evaluate(isolateScript);
  const bootstrapMs = performance.now() - started;
  assert.equal(vm.evaluate('typeof process'), 'undefined');
  assert.equal(vm.evaluate('typeof require'), 'undefined');

  const expected = {
    en: { title: 'Next.js support', greeting: 'Hello Edge!', items: '2 items', rich: ['Rendered on the ', ['<strong>', 'server', '</strong>'], '.'] },
    fr: { title: 'Prise en charge de Next.js', greeting: 'Bonjour Edge !', items: '2 articles', rich: ['Rendu sur le ', ['<strong>', 'serveur', '</strong>'], '.'] },
    ar: { title: 'دعم Next.js', greeting: 'مرحبًا Edge!', items: 'عنصران', rich: ['يُعرض على ', ['<strong>', 'الخادم', '</strong>'], '.'] },
  };
  const checks = {};
  for (const locale of Object.keys(expected)) {
    const response = await vm.dispatchFetch(`https://edge.test/edge/${locale}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, { locale, ...expected[locale] });
    checks[locale] = { status: response.status, exactBody: true };
  }
  const invalid = await vm.dispatchFetch('https://edge.test/edge/xx');
  assert.equal(invalid.status, 404);
  checks.invalid = { status: invalid.status };

  // Exercise concurrent requests in one long-lived isolate. This catches
  // accidental mutable locale state while keeping all request calls in EdgeVM.
  const concurrent = await Promise.all(
    Array.from({ length: 24 }, (_, index) => {
      const locale = ['en', 'fr', 'ar'][index % 3];
      return vm.dispatchFetch(`https://edge.test/edge/${locale}`)
        .then(async response => ({ locale, status: response.status, body: await response.json() }));
    }),
  );
  for (const row of concurrent) {
    assert.equal(row.status, 200);
    assert.deepEqual(row.body, { locale: row.locale, ...expected[row.locale] });
  }
  return {
    runtime: '@edge-runtime/vm',
    edgeRuntime: vm.evaluate('EdgeRuntime'),
    bootstrapMs,
    checks,
    concurrentRequests: concurrent.length,
    forbiddenInGenerated,
    generatedFiles: ['packages/locale/dist/next-runtime.js', scopePath, ...localeSources.map(({ locale }) => `examples/next/src/i18n/scopes/route/internal/locales/${locale}.js`)],
  };
}

const rows = [];
for (const bundler of ['turbopack', 'webpack']) {
  const build = await buildNext(bundler);
  const artifact = await inspectArtifact(bundler);
  rows.push({ bundler, build, artifact });
}
const isolate = await runIsolate();
const packageJson = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'));
const versions = {
  node: process.version,
  next: require('next/package.json').version,
  react: require('react/package.json').version,
  nordbeamI18n: packageJson.version,
  edgeRuntimeVm: require('@edge-runtime/vm/package.json').version,
};
const report = {
  status: 'passed',
  date: new Date().toISOString(),
  libraryUnderTest: '@nordbeam/locale',
  environment: { ...versions, cpu: cpus()[0].model },
  method: 'Production Next build and emitted Edge graph inspection for both bundlers, followed by execution of the generated @nordbeam/locale runtime/scope/catalog code in @edge-runtime/vm with a Web Fetch handler. The Next graph is not invoked inside EdgeVM because Next emits a framework-owned wrapper with private server shims; the isolate gate therefore proves the generated @nordbeam/locale route kernel, not full provider deployment or full Next rendering.',
  settings: { rounds, application: 'examples/next', route: '/edge/[locale]', bundlers: ['turbopack', 'webpack'], isolate: '@edge-runtime/vm' },
  rows,
  isolate,
  limits: [
    'EdgeVM is a Vercel Edge Runtime-compatible Web API context backed by Node vm; it is not a deployed provider sandbox.',
    'Next framework internals are build-inspected but not executed as a complete App Router render inside EdgeVM.',
    'A passing gate does not certify limits, bindings, or behavior of Vercel, Cloudflare, or another deployment provider.',
  ],
  officialSources: [
    'https://edge-runtime.vercel.app/packages/vm',
    'https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config',
    'https://nextjs.org/docs/14/app/building-your-application/rendering/edge-and-nodejs-runtimes',
  ],
};
console.log(JSON.stringify(report, null, 2));
