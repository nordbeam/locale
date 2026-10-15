import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const results = [];
for (const mode of ['development', 'production']) {
  const child = spawn(process.execPath, ['examples/react/server.mjs', ...(mode === 'production' ? ['--production'] : [])], {
    env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise(resolve => child.once('exit', resolve));
  let log = '';
  child.stderr.on('data', data => { log += data; });
  try {
    const origin = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`SSR example did not start: ${log}`)), 15000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`SSR example exited ${code}: ${log}`)); });
      child.stdout.on('data', data => {
        log += data;
        const match = /React SSR example: (http:\/\/127\.0\.0\.1:\d+)/.exec(log);
        if (match) { clearTimeout(timeout); resolve(match[1]); }
      });
    });
    const cases = [ ['en', 'Hello,', 'ltr'], ['fr', 'Bonjour,', 'ltr'], ['ar', 'مرحباً،', 'rtl'] ];
    await Promise.all(Array.from({ length: 18 }, async (_, index) => {
      const [locale, greeting, direction] = cases[index % cases.length];
      const response = await fetch(`${origin}/?lang=${locale}`);
      assert.equal(response.status, 200, log);
      assert.equal(response.headers.get('content-language'), locale);
      const html = await response.text();
      assert.ok(html.includes(`<html lang="${locale}" dir="${direction}">`));
      assert.ok(html.includes(`${greeting} Ada.`), html);
      assert.ok(html.includes('id="rich-note"'), html);
      assert.ok(html.includes('<strong>Ada</strong>'), html);
      assert.ok(html.includes('<a href="#details">'), html);
      assert.ok(html.includes(`{"locale":"${locale}"}`));
      assert.ok(!html.includes('<!--app-html-->'));
      if (index === 0) {
        const script = /<script[^>]+src="([^"]+)"/.exec(html)?.[1];
        assert.ok(script, html);
        const asset = await fetch(new URL(script, origin));
        assert.equal(asset.status, 200);
        assert.match(asset.headers.get('content-type'), /javascript/);
      }
    }));
    const fallback = await fetch(`${origin}/?lang=${encodeURIComponent('</script><script>bad()</script>')}`);
    assert.equal(fallback.headers.get('content-language'), 'en');
    assert.ok(!(await fallback.text()).includes('bad()'));
    assert.equal((await fetch(`${origin}/missing`)).status, 404);
    results.push({ mode, concurrentRequests: 18, locales: ['en', 'fr', 'ar'], status: 'passed' });
  } finally {
    child.kill('SIGTERM');
    const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(kill);
  }
}
const report = { date: new Date().toISOString(), node: process.version, results,
  note: 'Real HTTP servers: request isolation, translated SSR HTML including rich strong/link slots before JS, locale/direction, boot data, script serving and unknown-locale fallback. Hydration and switch races are covered separately by test/react.test.mjs and live Chrome checks.' };
console.log(JSON.stringify(report, null, 2));
