import test from 'node:test';
import assert from 'node:assert/strict';
import { compiled } from './helpers.mjs';

const catalogs = { en: { greeting: 'Updated {when, date}' }, de: { greeting: 'Aktualisiert {when, date}' } };

test('development output names the message and argument for an invalid Date', async t => {
  const { load } = await compiled(t, { baseLocale: 'en', development: true, catalogs });
  const { greeting } = (await load('locales/en.js')).default;
  assert.throws(() => greeting({ when: new Date('nope') }), error => error instanceof TypeError
    && error.message === 'en:greeting: argument "when" must be a valid Date');
  assert.throws(() => greeting({ when: NaN }), error => error instanceof TypeError
    && error.message === 'en:greeting: argument "when" must be a valid Date');
  assert.equal(greeting({ when: new Date(Date.UTC(2020, 0, 1)) }).length > 0, true);
});

test('development output keeps the type message for wrong argument types', async t => {
  const { load } = await compiled(t, { baseLocale: 'en', development: true, catalogs });
  const { greeting } = (await load('locales/de.js')).default;
  assert.throws(() => greeting({ when: 'today' }), error => error instanceof TypeError
    && error.message === 'de:greeting: argument "when" must be Date or number');
});

test('production output is unchanged and does not validate Dates', async t => {
  const { files } = await compiled(t, { baseLocale: 'en', development: false, catalogs });
  assert.doesNotMatch(files['locales/en.js'], /valid Date|isFinite/);
});
