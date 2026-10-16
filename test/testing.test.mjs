import test from 'node:test';
import assert from 'node:assert/strict';
import { symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { compileMessages, createMessageTestHelpers, messageIds, withMessages } from '../dist/testing.js';
import { rich } from '../dist/react.js';
import { compiled } from './helpers.mjs';

test('test helpers derive nested keys and render locale matrices', async () => {
  const helpers = createMessageTestHelpers();
  assert.equal(helpers.keyFromSelector(m => m.product.price), 'product.price');
  assert.throws(() => helpers.keyFromSelector(() => undefined), /return one message/);
  const matrix = await helpers.localeMatrix(['en', 'fr'], async locale => ({ messages: { greeting: name => `${locale}:${name}` } }), messages => messages.greeting('Ada'));
  assert.deepEqual(matrix, { en: 'en:Ada', fr: 'fr:Ada' });
});

const catalog = {
  greeting: 'Hello {name}!',
  account: 'Account',
  'account.title': 'Your account',
  'account.items': '{count, plural, one {# item} other {# items}}',
  checkout: { terms: 'Accept the <link>terms</link>', code: 'Your code is {code}.' },
};

test('messageIds renders every message as its ID through the flat and nested views', async t => {
  const project = await compiled(t, { baseLocale: 'en', catalogs: { en: catalog }, development: true });
  const en = (await project.load('locales/en.js')).default;
  const ids = messageIds(en);
  assert.deepEqual(Object.keys(ids).sort(), Object.keys(en).sort());
  assert.equal(ids.greeting({ name: 'Ada' }), 'greeting');
  assert.equal(ids['account.items']({ count: 2 }), 'account.items');
  assert.equal(ids.account.items({ count: 2 }), 'account.items');
  assert.equal(ids.account(), 'account');
  assert.equal(ids.checkout.code({ code: 'X' }), 'checkout.code');
  assert.deepEqual(ids.checkout.terms({ link: children => children }), ['checkout.terms']);
  assert.equal(renderToString(rich(ids.checkout.terms, { link: children => h('a', null, children) })), 'checkout.terms');
  assert.equal(ids.missing, undefined);
  assert.equal(Object.keys(ids).includes('checkout'), false, 'top-level namespaces stay out of Object.keys');
  const withArgs = messageIds(en, { format: (id, args) => args ? `${id}(${Object.keys(args).join(',')})` : id });
  assert.equal(withArgs.greeting({ name: 'Ada' }), 'greeting(name)');
  assert.equal(withArgs.account.title(), 'account.title');
  assert.equal(en.greeting({ name: 'Ada' }), 'Hello Ada!', 'the generated object is unchanged');
});

test('withMessages replaces messages in both views without changing the generated object', async t => {
  const project = await compiled(t, { baseLocale: 'en', catalogs: { en: catalog }, development: true });
  const en = (await project.load('locales/en.js')).default;
  const before = { title: en.account.title, account: en.account };
  const m = withMessages(en, {
    'account.title': 'Profile',
    greeting: ({ name }) => `Hi ${name}`,
    'checkout.terms': 'Terms',
  });
  assert.equal(m['account.title'](), 'Profile');
  assert.equal(m.account.title(), 'Profile');
  assert.equal(m.account(), 'Account');
  assert.equal(m.account.items({ count: 1 }), '1 item');
  assert.equal(m.greeting({ name: 'Ada' }), 'Hi Ada');
  assert.deepEqual(m.checkout.terms({ link: children => children }), ['Terms']);
  assert.equal(m.checkout.code({ code: 'X' }), 'Your code is X.');
  assert.deepEqual(Object.keys(m).sort(), Object.keys(en).sort());
  // The generated object and its functions are untouched.
  assert.equal(en.account.title(), 'Your account');
  assert.equal(en.account.title, before.title);
  assert.equal(en.account, before.account);
  assert.notEqual(m.account, en.account);
  // Overrides compose.
  const again = withMessages(m, { account: 'Profile settings' });
  assert.equal(again.account(), 'Profile settings');
  assert.equal(again.account.title(), 'Profile');
  assert.equal(m.account(), 'Account');
  assert.throws(() => withMessages(en, { 'account.titel': 'x' }), /RangeError|Unknown message: account\.titel/);
  assert.throws(() => withMessages(en, { greeting: 'Hi {name}' }), /compileMessages/);
  assert.throws(() => withMessages(en, { greeting: 3 }), /text or a function/);
});

test('compileMessages renders ICU text with the compiler and feeds withMessages', async t => {
  const project = await compiled(t, { baseLocale: 'en', catalogs: { en: catalog }, development: true });
  const en = (await project.load('locales/en.js')).default;
  const compiled_ = await compileMessages({
    'account.items': '{count, plural, one {# thing} other {# things}}',
    'checkout.terms': 'Read <link>these terms</link>',
    greeting: 'Welcome, {name}',
  });
  assert.equal(compiled_['account.items']({ count: 1200 }), '1,200 things');
  const m = withMessages(en, compiled_);
  assert.equal(m.account.items({ count: 1 }), '1 thing');
  assert.equal(withMessages(en, { account: 'Profile', ...compiled_ }).account.items({ count: 2 }), '2 things', 'compiled messages spread into an override map');
  assert.equal(m.greeting({ name: 'Ada' }), 'Welcome, Ada');
  assert.deepEqual(m.checkout.terms({ link: children => ({ link: children }) }), ['Read ', { link: ['these terms'] }]);
  assert.throws(() => m.greeting({}), /argument "name"/, 'development guards are on by default');
  const polish = await compileMessages({ files: '{n, plural, one {# plik} few {# pliki} many {# plików} other {# pliku}}' }, { locale: 'pl' });
  assert.deepEqual([1, 2, 5, 1.5].map(n => polish.files({ n })), ['1 plik', '2 pliki', '5 plików', '1,5 pliku']);
  const dated = await compileMessages({ when: '{d, date, iso}' }, { formats: { date: { iso: { year: 'numeric', month: '2-digit', day: '2-digit' } } }, timeZone: 'UTC' });
  assert.equal(dated.when({ d: new Date('2026-01-02T23:30:00Z') }), '01/02/2026');
  await assert.rejects(compileMessages({ bad: 'Hello {name' }), /INVALID_ICU|EXPECT_ARGUMENT_CLOSING_BRACE|Hello/);
});

test('testing helper types follow the generated messages', async t => {
  const project = await compiled(t, { baseLocale: 'en', catalogs: { en: catalog } });
  await symlink(resolve('node_modules'), join(project.dir, 'node_modules'), 'dir');
  await writeFile(join(project.dir, 'consumer.ts'), `
import en from './locales/en.js';
import { compileMessages, messageIds, withMessages } from ${JSON.stringify(resolve('dist/testing.js'))};
const ids: typeof en = messageIds(en);
ids.account.title();
const m: typeof en = withMessages(en, { 'account.title': 'Profile', greeting: ({ name }) => 'Hi ' + name });
m.greeting({ name: 'Ada' });
withMessages(en, await compileMessages({ greeting: 'Welcome, {name}' }));
withMessages(en, { 'account.title': 'Profile', ...await compileMessages({ 'account.items': '{count, plural, other {# things}}' }) });
// @ts-expect-error unknown message ID
withMessages(en, { 'account.titel': 'x' });
// @ts-expect-error namespaces are not messages
withMessages(en, { checkout: 'x' });
// @ts-expect-error a replacement takes the message's arguments
withMessages(en, { greeting: ({ nam }: { nam: string }) => nam });
// @ts-expect-error a replacement returns what the message returns
withMessages(en, { greeting: () => 3 });
`);
  const result = spawnSync(resolve('node_modules/.bin/tsc'), ['--ignoreConfig', '--noEmit', '--strict', '--skipLibCheck', '--module', 'nodenext', '--target', 'es2022', join(project.dir, 'consumer.ts')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
