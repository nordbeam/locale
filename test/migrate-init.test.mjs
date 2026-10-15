import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { temporary } from './helpers.mjs';

const cli = (root, ...args) => spawnSync(process.execPath, [resolve('dist/cli.js'), ...args], { cwd: root, encoding: 'utf8' });
const ok = result => assert.equal(result.status, 0, result.stdout + result.stderr);
const exists = file => access(file).then(() => true, () => false);

test('init --framework scaffolds import sibling files without a stale .js extension', async t => {
  for (const framework of ['next', 'vite-react']) {
    const root = await temporary(t);
    const result = cli(root, 'init', '--framework', framework);
    ok(result);
    const created = [...result.stdout.matchAll(/^Created (.+\.tsx?)$/gm)].map(match => resolve(root, match[1]));
    assert.ok(created.length >= 2, `${framework} should create TypeScript scaffolds`);
    for (const file of created) {
      const source = await readFile(file, 'utf8');
      for (const [, specifier] of source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"](\.\.?\/[^'"]+)['"]/g)) {
        const target = resolve(dirname(file), specifier);
        const found = await Promise.all([target, `${target}.ts`, `${target}.tsx`].map(exists));
        assert.ok(found.some(Boolean), `${framework}: ${relative(root, file)} imports ${specifier}, which does not resolve`);
      }
    }
  }
});

test('init --framework next scaffolds the README routing module and request proxy without replacing app files', async t => {
  const root = await temporary(t);
  ok(cli(root, 'init', '--framework', 'next'));
  const proxy = await readFile(join(root, 'proxy.ts'), 'utf8');
  assert.match(proxy, /import \{ routing \} from '\.\/src\/i18n\/routing';/);
  assert.match(proxy, /export default createNextMiddleware\(routing\);/);
  assert.ok(proxy.includes(String.raw`matcher: ['/((?!api|_next|_vercel|.*\\..*).*)']`), proxy);
  const routing = await readFile(join(root, 'src/i18n/routing.ts'), 'utf8');
  assert.match(routing, /export const routing = defineRouting\(\{/);
  assert.match(routing, /defaultLocale: baseLocale/);

  await writeFile(join(root, 'proxy.ts'), '// app-owned request boundary\n');
  const again = cli(root, 'init', '--framework', 'next');
  ok(again);
  assert.match(again.stdout, /Preserved proxy\.ts/);
  assert.equal(await readFile(join(root, 'proxy.ts'), 'utf8'), '// app-owned request boundary\n');
});

test('init names the Next request file by Next major version and preserves an existing middleware', async t => {
  const legacy = await temporary(t);
  await writeFile(join(legacy, 'package.json'), JSON.stringify({ dependencies: { next: '^15.5.0' } }) + '\n');
  ok(cli(legacy, 'init', '--framework', 'next'));
  assert.match(await readFile(join(legacy, 'middleware.ts'), 'utf8'), /createNextMiddleware\(routing\)/);
  assert.equal(await exists(join(legacy, 'proxy.ts')), false);

  const installed = await temporary(t);
  await writeFile(join(installed, 'package.json'), JSON.stringify({ dependencies: { next: '^15.5.0' } }) + '\n');
  await mkdir(join(installed, 'node_modules/next'), { recursive: true });
  await writeFile(join(installed, 'node_modules/next/package.json'), JSON.stringify({ version: '16.1.0' }) + '\n');
  ok(cli(installed, 'init', '--framework', 'next'));
  assert.ok(await exists(join(installed, 'proxy.ts')));
  assert.equal(await exists(join(installed, 'middleware.ts')), false);

  const existing = await temporary(t);
  await writeFile(join(existing, 'middleware.ts'), '// app-owned\n');
  const result = cli(existing, 'init', '--framework', 'next');
  ok(result);
  assert.match(result.stdout, /Preserved middleware\.ts/);
  assert.equal(await exists(join(existing, 'proxy.ts')), false);
  assert.equal(await readFile(join(existing, 'middleware.ts'), 'utf8'), '// app-owned\n');
});

test('init --framework next writes the request file beside src/app, where Next loads it', async t => {
  const srcLayout = await temporary(t);
  await mkdir(join(srcLayout, 'src/app'), { recursive: true });
  const result = cli(srcLayout, 'init', '--framework', 'next');
  ok(result);
  const proxy = await readFile(join(srcLayout, 'src/proxy.ts'), 'utf8');
  assert.match(proxy, /import \{ routing \} from '\.\/i18n\/routing';/);
  assert.equal(await exists(join(srcLayout, 'proxy.ts')), false);
  assert.match(result.stdout, /request boundary: src\/proxy\.ts/);

  await writeFile(join(srcLayout, 'src/proxy.ts'), '// app-owned\n');
  const again = cli(srcLayout, 'init', '--framework', 'next');
  ok(again);
  assert.match(again.stdout, /Preserved src\/proxy\.ts/);
  assert.equal(await readFile(join(srcLayout, 'src/proxy.ts'), 'utf8'), '// app-owned\n');

  const legacy = await temporary(t);
  await mkdir(join(legacy, 'src/pages'), { recursive: true });
  await writeFile(join(legacy, 'package.json'), JSON.stringify({ dependencies: { next: '^15.5.0' } }) + '\n');
  ok(cli(legacy, 'init', '--framework', 'next'));
  assert.ok(await exists(join(legacy, 'src/middleware.ts')));

  // Next prefers a root app/ over src/app, so the request file stays at the root there.
  const rootApp = await temporary(t);
  await mkdir(join(rootApp, 'app'), { recursive: true });
  await mkdir(join(rootApp, 'src/app'), { recursive: true });
  ok(cli(rootApp, 'init', '--framework', 'next'));
  assert.match(await readFile(join(rootApp, 'proxy.ts'), 'utf8'), /from '\.\/src\/i18n\/routing'/);
});

test('package.json script edits keep the original indentation, line endings and minified layout', async t => {
  const tabbed = await temporary(t);
  await writeFile(join(tabbed, 'package.json'), '{\n\t"name": "app",\n\t"scripts": {\n\t\t"build": "vite build"\n\t}\n}\n');
  ok(cli(tabbed, 'init'));
  const tabText = await readFile(join(tabbed, 'package.json'), 'utf8');
  assert.match(tabText, /^\{\n\t"name": "app",\n/);
  assert.match(tabText, /\n\t\t"i18n": "nordbeam-locale"/);
  assert.ok(tabText.endsWith('}\n'));

  const crlf = await temporary(t);
  await writeFile(join(crlf, 'package.json'), '{\r\n    "name": "app"\r\n}\r\n');
  ok(cli(crlf, 'init'));
  const crlfText = await readFile(join(crlf, 'package.json'), 'utf8');
  assert.match(crlfText, /^\{\r\n {4}"name": "app",\r\n/);
  assert.ok(crlfText.endsWith('}\r\n'));

  const minified = await temporary(t);
  await writeFile(join(minified, 'package.json'), '{"name":"app","scripts":{"build":"vite build"}}');
  ok(cli(minified, 'init'));
  const minText = await readFile(join(minified, 'package.json'), 'utf8');
  assert.equal(minText.includes('\n'), false);
  assert.equal(JSON.parse(minText).scripts.prepare, undefined);
  assert.equal(JSON.parse(minText).scripts.prebuild, 'nordbeam-locale');
});
