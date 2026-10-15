import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { launchChrome } from './chrome-process.mjs';

const repository = resolve(new URL('../..', import.meta.url).pathname);
const application = join(repository, 'examples/next');
const next = join(repository, 'node_modules/.bin/next');
const environment = { ...process.env, NEXT_TELEMETRY_DISABLED: '1' };

const build = spawnSync(next, ['build', application], {
  cwd: repository,
  env: environment,
  encoding: 'utf8',
});
if (build.status !== 0) throw new Error(`${build.stdout}\n${build.stderr}`);

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

async function waitForServer() {
  const deadline = Date.now() + 20_000;
  while (true) {
    try {
      const response = await request('/en');
      if (response.status === 200) return;
    } catch {}
    if (Date.now() > deadline) throw new Error(`Next.js server did not start:\n${output}`);
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
}

async function runBrowserCheck() {
  await waitForServer();
  const chrome = await launchChrome();
  const browserErrors = [];
  const offConsole = chrome.on('Runtime.consoleAPICalled', params => {
    if (params.type === 'error') browserErrors.push(`console.error: ${(params.args ?? []).map(arg => arg.value ?? arg.description ?? '').filter(Boolean).join(' ')}`);
  });
  const offException = chrome.on('Runtime.exceptionThrown', params => {
    browserErrors.push(`exception: ${params.exceptionDetails?.text ?? 'uncaught exception'}`);
  });
  const offLog = chrome.on('Log.entryAdded', ({ entry }) => {
    if (entry.level === 'error' && entry.source !== 'network') browserErrors.push(`log: ${entry.text}`);
  });
  try {
    await chrome.page('Log.enable');
    await chrome.page('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      window.__nordbeamI18nBrowserErrors = [];
      const stringify = value => { try { return typeof value === 'string' ? value : JSON.stringify(value); } catch { return String(value); } };
      addEventListener('error', event => window.__nordbeamI18nBrowserErrors.push('window.error: ' + (event.message || stringify(event.error))));
      addEventListener('unhandledrejection', event => window.__nordbeamI18nBrowserErrors.push('unhandledrejection: ' + stringify(event.reason)));
      const error = console.error;
      console.error = (...args) => { window.__nordbeamI18nBrowserErrors.push('console.error: ' + args.map(stringify).join(' ')); error.apply(console, args); };
    })();` });

    const snapshot = async () => chrome.evaluate(`(() => {
      const scope = document.querySelector('[data-locale-scope]');
      const client = document.querySelector('section[data-client-locale]');
      return {
        ready: document.readyState,
        scopeLang: scope?.getAttribute('lang') ?? null,
        scopeDir: scope?.getAttribute('dir') ?? null,
        scopeComputedDir: scope ? getComputedStyle(scope).direction : null,
        clientLocale: client?.getAttribute('data-client-locale') ?? null,
        clientLang: client?.getAttribute('lang') ?? null,
        clientDir: client?.getAttribute('dir') ?? null,
        clientComputedDir: client ? getComputedStyle(client).direction : null,
        pending: client?.getAttribute('data-pending') === 'true',
        title: document.querySelector('h1')?.textContent ?? null,
        greeting: document.querySelector('[data-client-greeting]')?.textContent ?? null,
        errors: window.__nordbeamI18nBrowserErrors ?? [],
      };
    })()`);
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
    const navigate = async locale => {
      const loaded = chrome.event('Page.loadEventFired');
      await chrome.page('Page.navigate', { url: `http://127.0.0.1:${port}/${locale}` });
      await loaded;
      return waitFor(state => state.ready !== 'loading' && state.clientLocale === locale && !state.pending, `${locale} hydration`);
    };
    const clickLocale = async locale => {
      const target = await chrome.evaluate(`(() => {
        const button = document.querySelector('button[data-switch-locale="${locale}"]');
        if (!button) return null;
        const rect = button.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`);
      assert.ok(target && Number.isFinite(target.x) && Number.isFinite(target.y), `${locale} switch control is not clickable`);
      await chrome.page('Page.bringToFront');
      await chrome.page('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y });
      await chrome.page('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', buttons: 1, clickCount: 1 });
      await chrome.page('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', buttons: 0, clickCount: 1 });
      return waitFor(state => state.clientLocale === locale && state.clientLang === locale && !state.pending, `${locale} client switch`);
    };

    const arabic = await navigate('ar');
    assert.equal(arabic.scopeLang, 'ar');
    assert.equal(arabic.scopeDir, 'rtl');
    assert.equal(arabic.scopeComputedDir, 'rtl');
    assert.equal(arabic.clientDir, 'rtl');
    assert.equal(arabic.clientComputedDir, 'rtl');
    assert.equal(arabic.title, 'دعم Next.js');
    assert.match(arabic.greeting, /مرحبًا Client/);

    const english = await navigate('en');
    assert.equal(english.scopeLang, 'en');
    assert.equal(english.scopeDir, 'ltr');
    assert.equal(english.scopeComputedDir, 'ltr');
    assert.equal(english.clientDir, 'ltr');
    assert.equal(english.clientComputedDir, 'ltr');
    assert.equal(english.title, 'Next.js support');
    assert.equal(english.greeting, 'Hello Client!');

    const switchedArabic = await clickLocale('ar');
    assert.equal(switchedArabic.scopeDir, 'ltr');
    assert.equal(switchedArabic.scopeComputedDir, 'ltr');
    assert.equal(switchedArabic.clientDir, 'rtl');
    assert.equal(switchedArabic.clientComputedDir, 'rtl');
    assert.equal(switchedArabic.title, 'Next.js support');
    assert.match(switchedArabic.greeting, /مرحبًا Client/);

    const switchedFrench = await clickLocale('fr');
    assert.equal(switchedFrench.scopeLang, 'en');
    assert.equal(switchedFrench.scopeDir, 'ltr');
    assert.equal(switchedFrench.clientLang, 'fr');
    assert.equal(switchedFrench.clientDir, 'ltr');
    assert.equal(switchedFrench.clientComputedDir, 'ltr');
    assert.equal(switchedFrench.greeting, 'Bonjour Client !');

    const pageErrors = [...new Set([...browserErrors, ...arabic.errors, ...english.errors, ...switchedArabic.errors, ...switchedFrench.errors])];
    assert.deepEqual(pageErrors, [], 'RTL browser check reported browser errors');
    return {
      status: 'passed',
      initialArabic: { lang: arabic.scopeLang, dir: arabic.scopeDir, computedDir: arabic.scopeComputedDir, title: arabic.title },
      initialEnglish: { lang: english.scopeLang, dir: english.scopeDir, computedDir: english.scopeComputedDir, title: english.title },
      switches: [
        { lang: switchedArabic.clientLang, dir: switchedArabic.clientDir, computedDir: switchedArabic.clientComputedDir, greeting: switchedArabic.greeting },
        { lang: switchedFrench.clientLang, dir: switchedFrench.clientDir, computedDir: switchedFrench.clientComputedDir, greeting: switchedFrench.greeting },
      ],
      browserErrors: [],
    };
  } finally {
    offConsole();
    offException();
    offLog();
    await chrome.close();
  }
}

let results;
try {
  results = await runBrowserCheck();
} finally {
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolveExit => child.once('exit', resolveExit)),
    new Promise(resolveTimeout => setTimeout(resolveTimeout, 2_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

console.log(JSON.stringify(results));
