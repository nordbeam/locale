import test from 'node:test';
import assert from 'node:assert/strict';
import { compiled } from './helpers.mjs';

const when = new Date(Date.UTC(2020, 0, 1, 0, 0));
const time = async (t, catalogs, development) => {
  const { load } = await compiled(t, { baseLocale: 'en', timeZone: 'UTC', development, catalogs });
  const read = async locale => (await load(`locales/${locale}.js`)).default.t({ d: when });
  return { en: await read('en'), pl: await read('pl'), de: await read('de') };
};

for (const development of [false, true]) {
  test(`hour cycle follows each locale when sources match (development: ${development})`, async t => {
    const output = await time(t, {
      en: { t: '{d, time, ::jm}' },
      pl: { t: '{d, time, ::jm}' },
      de: { t: '{d, time, ::jm}' },
    }, development);
    assert.equal(output.en, '12:00 AM');
    assert.equal(output.pl, '00:00');
    assert.equal(output.de, '00:00');
  });

  test(`hour cycle follows each locale when other messages differ (development: ${development})`, async t => {
    const output = await time(t, {
      en: { x: 'Hello', t: '{d, time, ::jm}' },
      pl: { x: 'Cześć', t: '{d, time, ::jm}' },
      de: { x: 'Hallo', t: '{d, time, ::jm}' },
    }, development);
    assert.equal(output.en, '12:00 AM');
    assert.equal(output.pl, '00:00');
    assert.equal(output.de, '00:00');
  });
}
