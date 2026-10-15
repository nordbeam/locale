import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createNavigation, createNextNavigation } from '../dist/next-navigation.js';
import { NextNavigationClientLink } from '../dist/next-navigation-client.js';
import { compileProject } from '../dist/compiler.js';
import { compiled } from './helpers.mjs';

test('Next navigation factory exposes the next-intl-compatible primitives', () => {
  const navigation = createNavigation({ locales: ['en', 'fr'], defaultLocale: 'en', localePrefix: 'as-needed' });
  assert.equal(createNavigation, createNextNavigation);
  assert.equal(typeof navigation.Link, 'function');
  assert.equal(typeof navigation.useRouter, 'function');
  assert.equal(typeof navigation.usePathname, 'function');
  assert.equal(typeof navigation.redirect, 'function');
});

test('generated catalog maps use a named Messages type', () => {
  const project = compileProject({ baseLocale: 'en', catalogs: { en: { greeting: 'Hello', 'account.name': 'Ada' } } });
  const declarations = project.files['messages.d.ts'];
  assert.match(declarations, /export type Messages=\$FlatMessages&/);
  assert.match(declarations, /declare const messages: Messages;/);
  assert.doesNotMatch(declarations, /\$Namespace/);
});

test('unknown message diagnostics name Messages without dumping catalog internals', async t => {
  const project = await compiled(t, { baseLocale: 'en', catalogs: { en: { greeting: 'Hello', 'account.name': 'Ada' } } });
  await writeFile(resolve(project.dir, 'consumer.ts'), 'import messages from "./messages.js"; messages.missing();\n');
  const result = spawnSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'),
    '--noEmit', '--strict', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'consumer.ts'], {
    cwd: project.dir, encoding: 'utf8',
  });
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0);
  assert.match(output, /Property 'missing' does not exist on type 'Messages'/);
  assert.doesNotMatch(output, /\$Namespace|readonly "greeting"/);
});

const routings = {
  always: { locales: ['en', 'fr'], defaultLocale: 'en', localePrefix: 'always' },
  'as-needed': { locales: ['en', 'fr'], defaultLocale: 'en', localePrefix: 'as-needed' },
  never: { locales: ['en', 'fr'], defaultLocale: 'en', localePrefix: 'never' },
};

function redirectTarget(navigation, href, locale) {
  try { navigation.redirect(href, locale); } catch (error) { return error.digest.split(';')[2]; }
  assert.fail('redirect did not throw');
}

test('Link is callable outside a render and hands routing to the client component', async () => {
  const routing = routings['as-needed'];
  const { Link } = createNavigation(routing);
  const element = Link({ href: '/about', locale: 'fr' });
  assert.equal(element.type, NextNavigationClientLink);
  assert.equal(element.props.routing, routing);
  assert.equal(element.props.locale, 'fr');
  assert.match(await readFile(resolve('dist/next-navigation-client.js'), 'utf8'), /^'use client';/);
});

test('redirect localizes route hrefs according to each prefix mode', () => {
  const cases = [
    ['/about', 'fr', { always: '/fr/about', 'as-needed': '/fr/about', never: '/about' }],
    ['/about', 'en', { always: '/en/about', 'as-needed': '/about', never: '/about' }],
    ['/about', false, { always: '/about', 'as-needed': '/about', never: '/about' }],
    ['/fr/about', 'en', { always: '/en/about', 'as-needed': '/about', never: '/about' }],
    ['/fr/about', 'fr', { always: '/fr/about', 'as-needed': '/fr/about', never: '/about' }],
    ['/', 'fr', { always: '/fr', 'as-needed': '/fr', never: '/' }],
    ['/', 'en', { always: '/en', 'as-needed': '/', never: '/' }],
    ['/about?x=1#h', 'fr', { always: '/fr/about?x=1#h', 'as-needed': '/fr/about?x=1#h', never: '/about?x=1#h' }],
    [{ pathname: '/a', query: { q: undefined, r: null, s: '1' } }, 'fr', { always: '/fr/a?s=1', 'as-needed': '/fr/a?s=1', never: '/a?s=1' }],
    [{ pathname: '/a', query: { q: undefined } }, 'en', { always: '/en/a', 'as-needed': '/a', never: '/a' }],
  ];
  for (const [mode, routing] of Object.entries(routings)) {
    const navigation = createNavigation(routing);
    for (const [href, locale, expected] of cases) {
      assert.equal(redirectTarget(navigation, href, locale), expected[mode], `${mode} ${JSON.stringify(href)} ${locale}`);
    }
  }
});

test('redirect leaves relative, hash-only, query-only and external hrefs untouched in every prefix mode', () => {
  const cases = ['#top', '?page=2', 'about', 'https://evil.com/x?y=1', '//cdn.example.com/a', 'mailto:team@example.com'];
  for (const routing of Object.values(routings)) {
    const navigation = createNavigation(routing);
    for (const href of cases) {
      assert.equal(redirectTarget(navigation, href, 'fr'), href, `${routing.localePrefix} ${href}`);
    }
    assert.equal(redirectTarget(navigation, new URL('https://evil.com/x?y=1'), 'fr'), 'https://evil.com/x?y=1');
  }
});

test('redirect requires a locale for root-relative paths without a locale prefix', () => {
  const navigation = createNavigation(routings['as-needed']);
  assert.throws(() => navigation.redirect('/dashboard'), { name: 'TypeError', message: /needs a locale/ });
  assert.throws(() => navigation.redirect({ pathname: '/dashboard' }, {}), { name: 'TypeError', message: /needs a locale/ });
  assert.equal(redirectTarget(navigation, '/fr/dashboard', undefined), '/fr/dashboard');
  assert.equal(redirectTarget(navigation, '/dashboard', { locale: 'fr' }), '/fr/dashboard');
  assert.equal(redirectTarget(navigation, 'https://evil.com/x', undefined), 'https://evil.com/x');
});
