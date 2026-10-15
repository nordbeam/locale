import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import MessageFormat from '@messageformat/core';
import compileModule from '@messageformat/core/compile-module.js';
import { compileProject, createCompiler } from '../dist/compiler.js';
import { compiled } from './helpers.mjs';

function catalog(size, locale = 'en') {
  return Object.fromEntries(Array.from({ length: size }, (_, index) => [
    `message${index}`,
    `${locale} message ${index} {name}`,
  ]));
}

test('full loader catalogs inline expressions while public locale modules stay compatible', async t => {
  const project = await compiled(t, {
    baseLocale: 'en',
    catalogs: {
      en: { greeting: 'Hello {name}', total: '{count, plural, one {# item} other {# items}}', then: 'Then' },
      fr: { greeting: 'Bonjour {name}', total: '{count, plural, one {# article} other {# articles}}', then: 'Alors' },
    },
  });
  const publicMessages = (await project.load('locales/fr.js')).default;
  const fullMessages = (await project.load('internal/locales/fr.js')).default;
  assert.deepEqual(Object.keys(fullMessages), Object.keys(publicMessages));
  assert.equal(fullMessages.greeting({ name: 'Ada' }), 'Bonjour Ada');
  assert.equal(fullMessages.total({ count: 2 }), '2 articles');
  assert.equal(fullMessages.then(), 'Alors');

  const index = await project.load('index.js');
  const loaded = await index.loadLocale('fr');
  assert.equal(loaded.messages, fullMessages);
  assert.equal(loaded.messages.greeting({ name: 'Ada' }), 'Bonjour Ada');
  assert.equal(publicMessages.greeting({ name: 'Ada' }), 'Bonjour Ada');
});

test('full catalog gzip size has a regression guard at 2,000 messages', () => {
  const project = compileProject({ baseLocale: 'en', catalogs: { en: catalog(2000) } });
  const publicBytes = gzipSync(project.files['locales/en.js']).length;
  const fullBytes = gzipSync(project.files['internal/locales/en.js']).length;
  const controlBytes = gzipSync(compileModule(new MessageFormat('en', { strictPluralKeys: false }), catalog(2000)), { level: 9 }).length;
  assert.ok(fullBytes <= publicBytes * 0.6, `full catalog grew: ${fullBytes} B vs public ${publicBytes} B gzip`);
  assert.ok(fullBytes <= controlBytes * 1.1, `full catalog exceeded MessageFormat control: ${fullBytes} B vs ${controlBytes} B gzip`);
  assert.ok(fullBytes < 11_000, `full catalog exceeded 11 KB gzip: ${fullBytes} B`);
});

test('incremental full catalogs resolve formatter references and match cold output', () => {
  const options = {
    baseLocale: 'en',
    catalogs: {
      en: { count: '{n, plural, one {# item} other {# items}}', date: '{when, date, short}', greeting: 'Hello {name}' },
      fr: { count: '{n, plural, one {# article} other {# articles}}', date: '{when, date, short}', greeting: 'Bonjour {name}' },
    },
    timeZone: 'UTC',
  };
  const compile = createCompiler();
  const first = compile(options);
  options.catalogs.en.greeting = 'Hi {name}';
  const incremental = compile(options);
  const cold = compileProject(options);
  assert.deepEqual(incremental.files, cold.files);
  for (const file of Object.keys(incremental.files).filter(name => name.includes('/internal/'))) {
    assert.doesNotMatch(incremental.files[file], /\u0000/);
  }
  assert.notEqual(first.files['internal/locales/en.js'], incremental.files['internal/locales/en.js']);
});
