import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./next-middleware-hooks.mjs', import.meta.url));
const { getLocale } = await import('../packages/locale/dist/next-server.js');

const withHeader = value => { globalThis.__nordbeamRequestHeaders = new Headers(value === undefined ? {} : { 'x-nordbeam-locale': value }); };
const routing = { locales: ['en', 'fr-CA'] };

test('getLocale without a locale list accepts only canonical BCP 47 tags', async () => {
  const cases = [
    [undefined, undefined],
    ['', undefined],
    ['fr-CA', 'fr-CA'],
    ['en', 'en'],
    ['../../etc/passwd', undefined],
    ['en_US', undefined],
    ['EN-us', undefined],
    ['zh-hant', undefined],
  ];
  for (const [value, expected] of cases) {
    withHeader(value);
    assert.equal(await getLocale(), expected, `header ${JSON.stringify(value)}`);
  }
});

test('getLocale with a locale list or routing object returns only listed locales', async () => {
  const cases = [
    ['en', 'en'],
    ['fr-CA', 'fr-CA'],
    ['fr', undefined],
    ['../../etc/passwd', undefined],
    [undefined, undefined],
  ];
  for (const [value, expected] of cases) {
    withHeader(value);
    assert.equal(await getLocale(['en', 'fr-CA']), expected, `list, header ${JSON.stringify(value)}`);
    assert.equal(await getLocale(routing), expected, `routing, header ${JSON.stringify(value)}`);
  }
});
