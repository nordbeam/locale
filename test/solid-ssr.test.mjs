import test from 'node:test';
import assert from 'node:assert/strict';
import { createComponent } from 'solid-js';
import { renderToString } from 'solid-js/web';
import { createSolidI18n } from '../packages/locale/dist/solid.js';
import { compiled } from './helpers.mjs';

// Server rendering uses Solid's server build, the default `node` condition, so
// this file must not run under `--conditions=browser`.
const serverCondition = !process.execArgv.includes('--conditions=browser') && !process.env.NODE_OPTIONS?.includes('--conditions=browser');
const serverTest = (name, fn) => test(name, { skip: serverCondition ? false : 'run without --conditions=browser' }, fn);

async function fixture(t) {
  const project = await compiled(t, {
    baseLocale: 'en',
    catalogs: {
      en: { greeting: 'Hello {name}', items: '{count, plural, one {# item} other {# items}}', price: 'Price {amount}' },
      fr: { greeting: 'Bonjour {name}', items: '{count, plural, one {# article} other {# articles}}', price: 'Prix {amount}' },
    },
  });
  const { loadLocale, selectMessages } = await project.load('index.js');
  return { loadLocale, loadPrice: selectMessages('price'), en: await loadLocale('en'), fr: await loadLocale('fr') };
}

serverTest('SSR renders the per-request instance and two instances do not leak into each other', async t => {
  const { loadLocale, en, fr } = await fixture(t);
  const render = initial => {
    const i18n = createSolidI18n({ initial, loadLocale });
    function Child() { return i18n.useI18n().messages().greeting({ name: 'Ada' }); }
    return renderToString(() => createComponent(i18n.Provider, { get children() { return createComponent(Child, {}); } }));
  };
  const [english, french] = [render(en), render(fr)];
  assert.equal(english, 'Hello Ada');
  assert.equal(french, 'Bonjour Ada');
  assert.equal(render(en), 'Hello Ada');
});

serverTest('SSR hooks outside a Provider throw a clear error', async t => {
  const { loadLocale, en } = await fixture(t);
  const i18n = createSolidI18n({ initial: en, loadLocale });
  function Orphan() { return i18n.useI18n().messages().greeting({ name: 'Ada' }); }
  assert.throws(() => renderToString(() => createComponent(Orphan, {})), /matching i18n\.Provider/);
});
