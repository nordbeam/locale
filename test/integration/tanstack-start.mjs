import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launchChrome } from './chrome-process.mjs';

const repository = resolve(new URL('../..', import.meta.url).pathname);

/** Files below a directory whose text contains the sentinel; portable replacement for `rg -l`. */
async function filesContaining(directory, text) {
  const files = [];
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && (await readFile(join(entry.parentPath, entry.name), 'utf8')).includes(text)) files.push(join(entry.parentPath, entry.name));
  }
  return files;
}
const application = join(repository, 'examples/tanstack-start');
const vite = join(repository, 'node_modules/.bin/vite');
const srvx = join(repository, 'node_modules/.bin/srvx');

const build = spawnSync(vite, ['build', '--config', join(application, 'vite.config.ts')], { cwd: repository, encoding: 'utf8' });
if (build.status !== 0) throw new Error(`${build.stdout}\n${build.stderr}`);

// The generated route tree exists after the build, so this checks the typed routes, root context and rewrite wiring.
const types = spawnSync(process.execPath, [join(repository, 'node_modules/typescript/bin/tsc'), '-p', join(application, 'tsconfig.json')], { cwd: repository, encoding: 'utf8' });
if (types.status !== 0) throw new Error(`${types.stdout}\n${types.stderr}`);

const scoped = await readFile(join(application, 'src/i18n/scopes/route/locales/en.js'), 'utf8');
const complete = await readFile(join(application, 'src/i18n/locales/en.js'), 'utf8');
assert.doesNotMatch(scoped, /UNUSED_TANSTACK_SENTINEL/);
assert.match(complete, /UNUSED_TANSTACK_SENTINEL/);
assert.deepEqual(await filesContaining(join(application, 'dist/client'), 'UNUSED_TANSTACK_SENTINEL'), [], 'unused catalog text reached a client chunk');

const socket = createServer();
await new Promise((resolveListen, reject) => socket.once('error', reject).listen(0, '127.0.0.1', resolveListen));
const address = socket.address();
if (!address || typeof address === 'string') throw new Error('Could not reserve a TanStack Start test port');
const port = address.port;
await new Promise((resolveClose, reject) => socket.close(error => error ? reject(error) : resolveClose()));

// The built server entry is a fetch handler; srvx serves it next to the static client assets.
const child = spawn(srvx, ['--prod', '-s', '../client', '-p', String(port), 'dist/server/server.js'], {
  cwd: application,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { output += chunk; });

const origin = `http://localhost:${port}`;

async function request(path, headers) {
  const response = await fetch(origin + path, { redirect: 'manual', headers });
  return { status: response.status, headers: response.headers, text: await response.text() };
}

const html = text => text.match(/<html[^>]*>/)?.[0] ?? '';
const heading = text => text.match(/<h1>([^<]*)<\/h1>/)?.[1] ?? '';

async function waitForServer() {
  const deadline = Date.now() + 20_000;
  while (true) {
    try { if ((await request('/')).status === 200) return; } catch {}
    if (Date.now() > deadline) throw new Error(`TanStack Start server did not start:\n${output}`);
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
}

function assertServerRendering(results) {
  const [home, fr, ar, about, frAbout, arAbout, post, frPost, unknown] = results;
  assert.equal(home.status, 200);
  assert.equal(html(home.text), '<html lang="en" dir="ltr">');
  assert.equal(heading(home.text), 'TanStack Start support');
  assert.match(home.text, /Hello Client!/);
  // The root route resolved the locale once, so the browser hydrates the same one without a second request.
  assert.match(home.text, /locale:"en"/);
  assert.match(home.headers.get('link'), /<http:\/\/localhost:\d+\/fr>; rel="alternate"; hreflang="fr"/);
  assert.match(home.headers.get('link'), /hreflang="x-default"/);
  assert.match(home.text, /<a data-nav="about" href="\/about">About this app<\/a>/);
  assert.match(home.text, /<a data-switch-locale="fr" href="\/fr"/);
  assert.equal(fr.status, 200);
  assert.equal(html(fr.text), '<html lang="fr" dir="ltr">');
  assert.equal(heading(fr.text), 'Prise en charge de TanStack Start');
  assert.match(fr.text, /Bonjour Client !/);
  // Links keep the page's locale and use its localized pathnames.
  assert.match(fr.text, /<a data-nav="about" href="\/fr\/a-propos">/);
  assert.match(fr.text, /<a data-nav="post" href="\/fr\/blogue\/hello">/);
  assert.equal(ar.status, 200);
  assert.equal(html(ar.text), '<html lang="ar" dir="rtl">');
  assert.equal(heading(ar.text), 'دعم TanStack Start');
  assert.match(ar.text, /مرحبًا Client!/);
  assert.equal(heading(about.text), 'About this app');
  assert.equal(heading(frAbout.text), 'À propos de cette application');
  assert.equal(html(arAbout.text), '<html lang="ar" dir="rtl">');
  assert.equal(heading(arAbout.text), 'حول هذا التطبيق');
  // Server functions called while rendering format in the request's locale.
  assert.equal(heading(post.text), 'Post hello');
  assert.match(post.text, /Server function: Hello Server!/);
  assert.equal(heading(frPost.text), 'Article hello');
  assert.match(frPost.text, /Fonction serveur : Bonjour Server !/);
  assert.equal(unknown.status, 404);
}

async function checkRedirects() {
  const location = response => response.headers.get('location');
  const canonical = await request('/en');
  assert.equal(canonical.status, 307);
  assert.equal(location(canonical), `${origin}/`);
  const wrongPath = await request('/fr/about');
  assert.equal(wrongPath.status, 307);
  assert.equal(location(wrongPath), `${origin}/fr/a-propos`);
  const cookie = await request('/about?x=1', { cookie: 'NEXT_LOCALE=fr' });
  assert.equal(cookie.status, 307);
  assert.equal(location(cookie), `${origin}/fr/a-propos?x=1`);
  const accepted = await request('/blog/hello', { 'accept-language': 'ar-EG,ar;q=0.9' });
  assert.equal(accepted.status, 307);
  assert.equal(location(accepted), `${origin}/ar/blog/hello`);
  const ignored = await request('/favicon.ico', { 'accept-language': 'fr' });
  assert.equal(ignored.status === 307, false, 'asset-like paths must not be redirected');
  const first = await request('/', { 'accept-language': 'en-US' });
  assert.equal(first.headers.get('set-cookie'), null, 'a cookie that matches Accept-Language is not written');
  const prefixed = await request('/fr');
  assert.match(prefixed.headers.get('set-cookie'), /^NEXT_LOCALE=fr; Path=\/; Max-Age=31536000; SameSite=Lax/);
}

async function runBrowserCheck() {
  const chrome = await launchChrome();
  const browserErrors = [];
  const offConsole = chrome.on('Runtime.consoleAPICalled', params => {
    if (params.type === 'error') browserErrors.push(`console.error: ${(params.args ?? []).map(arg => arg.value ?? arg.description ?? '').filter(Boolean).join(' ')}`);
  });
  const offException = chrome.on('Runtime.exceptionThrown', params => {
    browserErrors.push(`exception: ${params.exceptionDetails?.text ?? 'uncaught exception'}`);
  });
  const requests = [];
  const offRequest = chrome.on('Network.requestWillBeSent', params => requests.push(params.request.url));
  try {
    await chrome.page('Log.enable');
    const snapshot = () => chrome.evaluate(`(() => ({
      ready: document.readyState,
      marker: window.__nordbeamNavigationMarker === true,
      path: location.pathname,
      lang: document.documentElement.lang,
      dir: document.documentElement.dir,
      computedDir: getComputedStyle(document.body).direction,
      heading: document.querySelector('h1')?.textContent ?? null,
      page: document.querySelector('[data-page]')?.getAttribute('data-page') ?? null,
      serverFn: document.querySelector('[data-server-fn]')?.textContent ?? null,
      cookie: document.cookie,
      links: Object.fromEntries([...document.querySelectorAll('[data-nav]')].map(link => [link.getAttribute('data-nav'), link.getAttribute('href')])),
    }))()`);
    const waitFor = async (predicate, label, timeout = 15_000) => {
      let last;
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        last = await snapshot();
        if (predicate(last)) return last;
        await new Promise(resolveWait => setTimeout(resolveWait, 20));
      }
      throw new Error(`${label} timed out: ${JSON.stringify(last)}`);
    };
    const open = async path => {
      const loaded = chrome.event('Page.loadEventFired');
      await chrome.page('Page.navigate', { url: origin + path });
      await loaded;
      // Hydration is done once the router can navigate without a document load.
      await waitFor(state => state.ready !== 'loading' && state.heading !== null, `${path} load`);
      await chrome.evaluate('window.__nordbeamNavigationMarker = true');
    };
    const click = async selector => {
      const target = await chrome.evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`);
      assert.ok(target && Number.isFinite(target.x), `${selector} is not clickable`);
      await chrome.page('Page.bringToFront');
      await chrome.page('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y });
      await chrome.page('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', buttons: 1, clickCount: 1 });
      await chrome.page('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', buttons: 0, clickCount: 1 });
    };

    await open('/');
    const english = await snapshot();
    assert.equal(english.lang, 'en');
    assert.equal(english.heading, 'TanStack Start support');
    assert.deepEqual(english.links, { about: '/about', post: '/blog/hello' });

    // Switching loads the catalog, changes the URL, the cookie, lang and dir, and keeps the document (no reload).
    await click('[data-switch-locale="fr"]');
    const french = await waitFor(state => state.path === '/fr' && state.lang === 'fr' && state.heading === 'Prise en charge de TanStack Start', 'switch to fr');
    assert.equal(french.marker, true, 'the locale switch reloaded the document');
    assert.equal(french.dir, 'ltr');
    assert.match(french.cookie, /NEXT_LOCALE=fr/);
    assert.deepEqual(french.links, { about: '/fr/a-propos', post: '/fr/blogue/hello' });

    // Links navigate on the client to the localized pathname.
    await click('[data-nav="about"]');
    const about = await waitFor(state => state.path === '/fr/a-propos' && state.page === 'about', 'fr about');
    assert.equal(about.heading, 'À propos de cette application');
    assert.equal(about.marker, true);

    // Switching on a localized pathname maps the page to the other locale's pathname, in a right-to-left locale.
    await click('[data-switch-locale="ar"]');
    const arabic = await waitFor(state => state.lang === 'ar' && state.page === 'about', 'switch to ar');
    assert.equal(decodeURIComponent(arabic.path), '/ar/حول');
    assert.equal(arabic.dir, 'rtl');
    assert.equal(arabic.computedDir, 'rtl');
    assert.equal(arabic.heading, 'حول هذا التطبيق');
    assert.equal(arabic.marker, true);

    await click('[data-switch-locale="en"]');
    const back = await waitFor(state => state.lang === 'en' && state.page === 'about', 'switch back to en');
    assert.equal(back.path, '/about');
    assert.equal(back.dir, 'ltr');
    assert.equal(back.heading, 'About this app');

    // A server function called by a client-side navigation formats in the page's locale.
    await click('[data-nav="post"]');
    const post = await waitFor(state => state.page === 'post', 'en post');
    assert.equal(post.serverFn, 'Server function: Hello Server!');
    await click('[data-switch-locale="fr"]');
    const frenchPost = await waitFor(state => state.path === '/fr/blogue/hello' && state.page === 'post' && state.heading === 'Article hello' && state.serverFn?.startsWith('Fonction'), 'fr post');
    assert.equal(frenchPost.heading, 'Article hello');
    assert.equal(frenchPost.serverFn, 'Fonction serveur : Bonjour Server !');
    assert.equal(frenchPost.marker, true);

    // The cookie written by the switch decides the locale of the next document request.
    await open('/about');
    const remembered = await snapshot();
    assert.equal(remembered.path, '/fr/a-propos');
    assert.equal(remembered.lang, 'fr');

    // Each catalog is requested at most once per page load, however often the locale changes.
    requests.length = 0;
    await open('/ar');
    await click('[data-switch-locale="fr"]');
    await waitFor(state => state.lang === 'fr', 'fr from ar');
    await click('[data-switch-locale="ar"]');
    await waitFor(state => state.lang === 'ar', 'ar again');
    const catalogs = requests.filter(url => /\/assets\/(en|fr|ar)-[\w-]+\.js$/.test(url));
    const counts = Object.fromEntries(['en', 'fr', 'ar'].map(locale => [locale, catalogs.filter(url => new RegExp(`/assets/${locale}-`).test(url)).length]));

    assert.deepEqual(browserErrors, [], 'browser reported errors');
    return { status: 'passed', catalogRequests: counts, browserErrors: [] };
  } finally {
    offConsole();
    offException();
    offRequest();
    await chrome.close();
  }
}

let results;
try {
  await waitForServer();
  assertServerRendering(await Promise.all([
    request('/'), request('/fr'), request('/ar'), request('/about'), request('/fr/a-propos'), request('/ar/%D8%AD%D9%88%D9%84'),
    request('/blog/hello'), request('/fr/blogue/hello'), request('/de'),
  ]));
  await checkRedirects();
  results = await runBrowserCheck();
  assert.deepEqual(results.catalogRequests, { en: 0, fr: 1, ar: 1 }, 'a catalog was requested more or less than once');
  console.log(`TanStack Start passed: SSR per locale (lang/dir, localized pathnames, server functions), canonical redirects, locale cookie, client switching without reloads, and scoped client bytes. ${JSON.stringify(results)}`);
} finally {
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolveExit => child.once('exit', resolveExit)),
    new Promise(resolveTimeout => setTimeout(resolveTimeout, 2_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}
