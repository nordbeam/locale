import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { IntlMessageFormat } from 'intl-messageformat';
import { compileProject, compileSelection, createCompiler, CompileError } from '../dist/compiler.js';
import { compiled } from './helpers.mjs';

const locales = ['en', 'fr', 'ar', 'pl', 'ru', 'cy', 'ja'];
const catalog = {
  plain: 'Save changes',
  empty: '',
  interpolation: 'Hello {name}!',
  numericFirst: '{a}{b} total',
  quoted: "'{name}' '{'hello'}' don''t '#': {name}",
  select: '{gender, select, female {She} male {He} other {They}} liked {name}.',
  cardinal: '{count, plural, =0 {none} =2 {exactly two} zero {zero #} one {one #} two {two #} few {few #} many {many #} other {other #}}',
  ordinal: '{count, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}',
  offset: '{count, plural, offset:1 =0 {nobody} =1 {alone} one {one guest: #} other {guests: #}}',
  nested: '{count, plural, one {outer # {inner, plural, one {inner #} other {inner #}} outer #} other {{gender, select, female {her #} other {their #}} {inner, plural, offset:1 one {inner #} other {inner #}} outer #}}',
  decimal: '{amount, number}',
  integer: '{amount, number, integer}',
  percent: '{amount, number, percent}',
  currency: '{amount, number, currency}',
  custom: '{amount, number, money}',
  skeleton: '{amount, number, ::currency/EUR .00}',
  scaled: '{amount, number, ::scale/100 percent}',
  date: '{when, date}',
  shortDate: '{when, date, short}',
  longDate: '{when, date, full}',
  time: '{when, time}',
  longTime: '{when, time, long}',
  skeletonDate: '{when, date, ::yyyyMMdd}',
  skeletonTime: '{when, time, ::HHmmss}',
  customDate: '{when, date, monthOnly}',
};
const formats = {
  number: { currency: { currency: 'USD' }, money: { style: 'currency', currency: 'JPY' } },
  date: { monthOnly: { month: 'long' } },
};

test('ICU output agrees with FormatJS across plural categories, offsets, quoting, and formats', async t => {
  const project = await compiled(t, { baseLocale: 'en', catalogs: Object.fromEntries(locales.map(locale => [locale, catalog])), formats, timeZone: 'UTC' });
  let comparisons = 0;
  for (const locale of locales) {
    const { default: messages } = await project.load(`locales/${locale}.js`);
    const selectionSource = compileSelection(project, 'index.js', locale, Object.keys(catalog));
    const { default: selected } = await import('data:text/javascript;base64,' + Buffer.from(selectionSource).toString('base64'));
    const reference = Object.fromEntries(Object.entries(catalog).map(([key, source]) => [key, new IntlMessageFormat(source, locale, formats, {
      formatters: {
        getNumberFormat: (l, opts) => new Intl.NumberFormat(l, opts),
        getPluralRules: (l, opts) => new Intl.PluralRules(l, opts),
        getDateTimeFormat: (l, opts) => new Intl.DateTimeFormat(l, { ...opts, timeZone: 'UTC' }),
      },
    })]));
    for (const count of [-101, -21, -2, -1.5, -1, -0, 0, 0.5, 1, 1.2, 2, 3, 4, 5, 6, 10, 11, 21, 22, 100, 101, 1000, 1e6, NaN, Infinity]) {
      for (const gender of ['female', 'male', 'other', 'unknown']) {
        const p = { count, inner: 3, gender, name: 'عائشة 👩🏽‍💻 e\u0301 <>&', a: 12, b: 34, amount: -12345.678, when: new Date('2026-01-02T13:04:05Z') };
        for (const [key, fn] of Object.entries(messages)) {
          assert.equal(fn(p), reference[key].format(p), `${locale}/${key} count=${count} gender=${gender}`);
          assert.equal(selected[key](p), reference[key].format(p), `selection ${locale}/${key} count=${count} gender=${gender}`);
          comparisons++;
        }
      }
    }
  }
  t.diagnostic(`${comparisons * 2} differential comparisons (full and selected output)`);
});

test('boolean ICU selects preserve FormatJS behavior in plain, folded, and rich output', async t => {
  const booleanCatalog = {
    plain: '{isVideo, select, true {Video} false {Still} other {Unknown}}',
    folded: '{isVideo, select, true {Video} false {Still} other {Unknown}} asset',
    rich: '{isVideo, select, true {<b>Video</b>} false {<b>Still</b>} other {Unknown}}',
  };
  for (const development of [false, true]) {
    const project = await compiled(t, { baseLocale: 'en', development, catalogs: { en: booleanCatalog } });
    const { default: messages } = await project.load('locales/en.js');
    const selectionSource = compileSelection(project, 'index.js', 'en', Object.keys(booleanCatalog));
    const { default: selected } = await import('data:text/javascript;base64,' + Buffer.from(selectionSource).toString('base64'));
    const slot = children => ({ bold: children });
    const values = [true, false, 'true', 'false', 'other'];
    const references = Object.fromEntries(Object.entries(booleanCatalog).map(([id, source]) => [id, new IntlMessageFormat(source, 'en')]));
    for (const isVideo of values) {
      const args = { isVideo, b: slot };
      for (const id of Object.keys(booleanCatalog)) {
        let expected = references[id].format(args);
        if (id === 'rich' && !Array.isArray(expected)) expected = [expected];
        assert.deepEqual(messages[id](args), expected, `${development}:full:${id}:${isVideo}`);
        assert.deepEqual(selected[id](args), expected, `${development}:selected:${id}:${isVideo}`);
      }
    }
    assert.match(project.files['messages.d.ts'], /"isVideo": "false" \| "true" \| \(string & \{\}\) \| boolean/);
  }
});

test('generated code preserves arbitrary keys and text without prototype or promise collisions', async t => {
  const weird = JSON.parse('{"__proto__":"Prototype text","constructor":"Constructor text","then":"Then text","default":"Default text","messages":"Messages text"}');
  const source = '` ${globalThis.__nordbeamI18nInjection = 1} </script> \\ " \n \u2028';
  weird['quote";globalThis.__nordbeamI18nInjection=1;//'] = source.replace('{', "'{").replace('}', "}'").replace('</script>', "'</script>'");
  weird['nested.key'] = 'Nested';
  const project = await compiled(t, { baseLocale: 'en', catalogs: { en: weird, index: weird } });
  const loader = await project.load('index.js');
  const { messages } = await loader.loadLocale('en');
  const selectedSource = compileSelection(project, 'index.js', 'en', Object.keys(weird));
  const { default: selected } = await import('data:text/javascript;base64,' + Buffer.from(selectedSource).toString('base64'));
  assert.equal(Object.getPrototypeOf(messages), null);
  for (const [key, text] of Object.entries(weird)) {
    const expected = key.startsWith('quote') ? source : text;
    assert.equal(messages[key](), expected);
    assert.equal(selected[key](), expected);
  }
  assert.equal(globalThis.__nordbeamI18nInjection, undefined);
  assert.equal((await loader.loadLocale('index')).messages.then(), 'Then text');
  await assert.rejects(loader.loadLocale('__proto__'), /Unsupported locale/);
  await assert.rejects(loader.loadLocale('toString'), /Unsupported locale/);
  const module = await project.load('locales/en.js');
  assert.equal(module.then, undefined);
  assert.equal(module.messages(), 'Messages text');
});

test('loader-only JavaScript opts out of checkJs while declarations remain checked', async t => {
  const project = await compiled(t, {
    artifacts: 'loader-typed',
    shareLiterals: true,
    baseLocale: 'en',
    catalogs: {
      en: { shared: 'Same', greeting: 'Hello {name}', items: '{count, plural, one {one item} other {# items}}' },
      fr: { shared: 'Same', greeting: 'Bonjour {name}', items: '{count, plural, one {un article} other {# articles}}' },
    },
  });
  for (const [file, source] of Object.entries(project.files)) {
    if (file.endsWith('.js')) {
      assert.match(source, /^\/\/ @ts-nocheck\n\/\/ Generated by Nordbeam Locale\./, file);
    } else if (file.endsWith('.d.ts')) {
      assert.doesNotMatch(source, /@ts-nocheck/, file);
    }
  }
  const check = spawnSync(resolve('node_modules/.bin/tsc'), [
    '--ignoreConfig', '--noEmit', '--allowJs', '--checkJs', '--strict', '--skipLibCheck',
    '--module', 'nodenext', '--target', 'es2022', join(project.dir, 'index.js'),
  ], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr || check.stdout);
});

test('fallback retains the base locale formatter and scopes contain only selected IDs', async t => {
  const project = await compiled(t, {
    baseLocale: 'en',
    catalogs: { en: { hello: 'Hello {name}', checkout: { total: 'Total {amount, number}' }, admin: 'Secret admin text' }, fr: { hello: 'Salut {name}' } },
    scopes: { checkout: ['checkout.*', 'hello'] },
  });
  const { loadLocale } = await project.load('scopes/checkout/index.js');
  const [en, fr] = await Promise.all([loadLocale('en'), loadLocale('fr')]);
  assert.equal(en.messages.hello({ name: 'Ada' }), 'Hello Ada');
  assert.equal(fr.messages.hello({ name: 'Ada' }), 'Salut Ada');
  assert.equal(fr.messages['checkout.total']({ amount: 1234.5 }), 'Total 1,234.5');
  assert.equal(fr.messages.admin, undefined);
  assert.equal(project.warnings.length, 2);
  assert.doesNotMatch(project.files['scopes/checkout/locales/en.js'], /Secret admin/);
});

test('development errors name the message and argument; production omits validation', async t => {
  const options = { baseLocale: 'en', catalogs: { en: { hello: 'Hello {name}', items: '{count, plural, one {item} other {items}}' } } };
  const project = await compiled(t, { ...options, development: true });
  const { default: m } = await project.load('locales/en.js');
  assert.throws(() => m.hello(), /en:hello: expected message arguments/);
  assert.throws(() => m.hello({}), /argument "name"/);
  assert.throws(() => m.items({ count: '1' }), /must be number/);
  assert.throws(() => m.hello(Object.create({ name: 'inherited' })), /argument "name"/);
  assert.doesNotMatch(compileProject(options).files['locales/en.js'], /hasOwn|TypeError/);
});

test('invalid catalogs fail with actionable diagnostics', () => {
  const base = { baseLocale: 'en', catalogs: { en: { greeting: 'Hello {name}' } } };
  const cases = [
    [{ baseLocale: 'en', catalogs: {} }, 'BASE_LOCALE_MISSING'],
    [{ baseLocale: 'en_us', catalogs: { en_us: {} } }, 'INVALID_LOCALE'],
    [{ ...base, catalogs: { en: { a: { b: 'one' }, 'a.b': 'two' } } }, 'DUPLICATE_KEY'],
    [{ ...base, catalogs: { en: { a: ['bad'] } } }, 'INVALID_CATALOG'],
    [{ ...base, catalogs: { en: { a: '{count, plural, one {one}}' } } }, 'INVALID_ICU'],
    [{ ...base, catalogs: { en: { a: 'Hello <b>{name}</i>' } } }, 'INVALID_ICU'],
    [{ ...base, catalogs: { ...base.catalogs, fr: { greeting: 'Hello {other}' } } }, 'UNKNOWN_ARGUMENT'],
    [{ ...base, catalogs: { ...base.catalogs, fr: { extra: 'Hello' } } }, 'UNKNOWN_MESSAGE'],
    [{ ...base, catalogs: { ...base.catalogs, fr: {} }, missing: 'error' }, 'MISSING_MESSAGE'],
    [{ ...base, catalogs: { en: { a: '{n, number} {n, select, x {X} other {Y}}' } } }, 'ARGUMENT_TYPE_CONFLICT'],
    [{ ...base, catalogs: { en: { a: '{n, number, madeUp}' } } }, 'UNKNOWN_FORMAT'],
    [{ ...base, catalogs: { en: { a: '{n, number, currency}' } } }, 'INVALID_FORMAT'],
    [{ ...base, scopes: { shop: ['does.not.exist.*'] } }, 'EMPTY_SCOPE_PATTERN'],
    [{ ...base, scopes: { '../unsafe': ['greeting'] } }, 'INVALID_SCOPE'],
  ];
  for (const [options, code] of cases) assert.throws(() => compileProject(options), error => error instanceof CompileError && error.diagnostics[0].code === code, code);
  assert.throws(() => compileProject({ ...base, catalogs: { en: { bad: 'Hello\n{count, plural, one {x}}' } } }), error => error.diagnostics[0].line === 2 && error.message.includes('^'));
});

test('flattening is deterministic and translations can omit base arguments', () => {
  const first = compileProject({ baseLocale: 'en', catalogs: { en: { z: 'Last', a: 'Hello {name}' }, fr: { a: 'Bonjour', z: 'Fin' } } });
  const second = compileProject({ baseLocale: 'en', catalogs: { fr: { z: 'Fin', a: 'Bonjour' }, en: { a: 'Hello {name}', z: 'Last' } } });
  assert.deepEqual(first.files, second.files);
  assert.match(first.files['messages.d.ts'], /readonly "name": string \| number/);
});

test('runtime artifact mode preserves JavaScript and omits declarations', () => {
  const options = { baseLocale: 'en', catalogs: { en: { hello: 'Hello {name}', items: '{count, plural, one {one} other {# items}}' }, fr: { hello: 'Bonjour {name}', items: '{count, plural, one {un} other {# articles}}' } } };
  const typed = compileProject(options);
  const runtime = compileProject({ ...options, artifacts: 'runtime' });
  assert.ok(Object.keys(typed.files).some(file => file.endsWith('.d.ts')));
  assert.equal(Object.keys(runtime.files).some(file => file.endsWith('.d.ts') || file.endsWith('.d.ts.map')), false);
  for (const [file, source] of Object.entries(runtime.files)) assert.equal(source, typed.files[file], file);
  assert.deepEqual(runtime.locales, typed.locales);
  assert.deepEqual(runtime.groups, typed.groups);
  const loader = compileProject({ ...options, artifacts: 'loader' });
  assert.equal(Object.keys(loader.files).some(file => file.startsWith('locales/') || file.endsWith('.d.ts')), false);
  assert.ok(Object.keys(loader.files).some(file => file.startsWith('internal/locales/')));
  assert.ok(loader.files['index.js']);
  const loaderTyped = compileProject({ ...options, artifacts: 'loader-typed' });
  assert.equal(Object.keys(loaderTyped.files).some(file => file.startsWith('locales/')), false);
  assert.ok(loaderTyped.files['messages.d.ts']);
  assert.ok(loaderTyped.files['index.d.ts']);
  assert.match(loaderTyped.files['index.d.ts'], /typeof import\("\.\/messages\.js"\)\.default/);
  assert.ok(Object.keys(loaderTyped.files).some(file => file.startsWith('internal/locales/')));
  assert.throws(() => compileProject({ ...options, artifacts: 'invalid' }), /artifacts must be/);
});

test('loader-only incremental output does not poison a later public artifact mode', () => {
  const options = { baseLocale: 'en', catalogs: { en: { hello: 'Hello' } } };
  const compile = createCompiler();
  const loader = compile({ ...options, artifacts: 'loader' });
  assert.equal(loader.files['locales/en.js'], undefined);
  const typed = compile(options);
  assert.match(typed.files['locales/en.js'], /export default messages/);
  assert.ok(typed.files['locales/en.js'].length > 0);
  const runtime = compile({ ...options, artifacts: 'runtime' });
  assert.match(runtime.files['locales/en.js'], /export default messages/);
});

test('full-catalog modules serialize literals compactly and preserve callable messages', async t => {
  const project = await compiled(t, { baseLocale: 'en', catalogs: { en: {
    plain: 'A static sentence', nested: { label: 'Nested label' }, greeting: 'Hello {name}',
  } } });
  const source = project.files['internal/locales/en.js'];
  assert.match(source, /const \$literals=/);
  assert.doesNotMatch(source, /\$literal\(/);
  assert.match(source, /plain:"A static sentence"/);
  const { messages } = await project.load('index.js').then(module => module.loadLocale('en'));
  assert.equal(messages.plain(), 'A static sentence');
  assert.equal(messages.nested.label(), 'Nested label');
  assert.equal(messages.greeting({ name: 'Ada' }), 'Hello Ada');
});

test('cold loader full catalogs share literals while preserving locale-owned ICU and nested access', async t => {
  const catalogs = {
    en: { plain: 'Same', nested: { same: 'Nested', changed: 'Base' }, count: '{count, plural, one {one} other {#}}', number: '{value, number}', rich: 'Read <link>docs</link>' },
    fr: { plain: 'Same', nested: { same: 'Nested', changed: 'Traduit' }, count: '{count, plural, one {un} other {#}}', number: '{value, number}', rich: 'Lire <link>docs</link>' },
  };
  const project = await compiled(t, { baseLocale: 'en', artifacts: 'loader', shareLiterals: true, includeSources: 'all', catalogs });
  assert.match(project.files['internal/locales/fr.js'], /import sharedMessages/);
  const loader = await project.load('index.js');
  const en = await loader.loadLocale('en');
  const fr = await loader.loadLocale('fr');
  assert.equal(fr.messages.plain(), 'Same');
  assert.equal(fr.messages.nested.same(), 'Nested');
  assert.equal(fr.messages.nested.changed(), 'Traduit');
  assert.equal(en.messages.nested.changed(), 'Base');
  assert.equal(fr.messages.count({ count: 2 }), '2');
  assert.equal(fr.messages.number({ value: 1234.5 }), new Intl.NumberFormat('fr').format(1234.5));
  assert.deepEqual(fr.messages.rich({ link: value => value }), ['Lire ', ['docs']]);
  assert.deepEqual({ ...fr.sources }, {
    plain: 'Same', 'nested.same': 'Nested', 'nested.changed': 'Traduit',
    count: '{count, plural, one {un} other {#}}', number: '{value, number}', rich: 'Lire <link>docs</link>',
  });
  assert.equal(Object.getPrototypeOf(fr.messages), null);
  const loaderTyped = compileProject({ baseLocale: 'en', artifacts: 'loader-typed', catalogs });
  assert.doesNotMatch(loaderTyped.files['internal/locales/fr.js'], /import sharedMessages/);
  const loaderTypedShared = compileProject({ baseLocale: 'en', artifacts: 'loader-typed', shareLiterals: true, catalogs });
  assert.match(loaderTypedShared.files['internal/locales/fr.js'], /import sharedMessages/);
  assert.ok(loaderTypedShared.files['messages.d.ts']);
  const richShared = await compiled(t, { baseLocale: 'en', artifacts: 'loader', shareLiterals: true, includeSources: 'rich', catalogs: {
    en: { plain: 'Same', rich: 'Read <link>docs</link>' },
    fr: { plain: 'Same', rich: 'Lire <link>docs</link>' },
  } });
  assert.match(richShared.files['internal/locales/fr.js'], /import sharedMessages/);
  assert.match(richShared.files['internal/locales/fr.js'], /sharedSources/);
  assert.match(richShared.files['internal/shared.js'], /export const sources=\{__proto__:null\}/);
  const richLoaded = await richShared.load('index.js').then(module => module.loadLocale('fr'));
  assert.deepEqual({ ...richLoaded.sources }, { rich: 'Lire <link>docs</link>' });
  const noRich = await compiled(t, { baseLocale: 'en', artifacts: 'loader', includeSources: 'rich', catalogs: {
    en: { plain: 'Same' }, fr: { plain: 'Same' },
  } });
  const noRichLoaded = await noRich.load('index.js').then(module => module.loadLocale('fr'));
  assert.deepEqual({ ...noRichLoaded.sources }, {});
  const defaultLoader = compileProject({ baseLocale: 'en', artifacts: 'loader', catalogs });
  assert.equal(defaultLoader.files['internal/shared.js'], undefined);
  const noOverlap = compileProject({ baseLocale: 'en', artifacts: 'loader', shareLiterals: true, catalogs: {
    en: { plain: 'English' }, fr: { plain: 'Français' },
  } });
  assert.equal(noOverlap.files['internal/shared.js'], undefined);
  assert.doesNotMatch(noOverlap.files['internal/locales/fr.js'], /sharedMessages/);
});

test('loaded catalogs can retain rich ICU source without duplicating plain messages', async t => {
  const options = { baseLocale: 'en', catalogs: { en: {
    plain: 'Plain', rich: 'Read <link>{count, plural, one {one item} other {# items}}</link>',
  } } };
  const richProject = await compiled(t, { ...options, includeSources: 'rich' });
  const rich = await richProject.load('index.js').then(module => module.loadLocale('en'));
  assert.deepEqual({ ...rich.sources }, { rich: options.catalogs.en.rich });
  assert.equal(rich.messages.plain(), 'Plain');
  assert.deepEqual(rich.messages.rich({ count: 2, link: value => value }), ['Read ', ['2 items']]);
  const allProject = await compiled(t, { ...options, includeSources: 'all' });
  const all = await allProject.load('index.js').then(module => module.loadLocale('en'));
  assert.deepEqual({ ...all.sources }, options.catalogs.en);
  const exactProject = await compiled(t, { ...options, includeSources: ['plain'] });
  const exact = await exactProject.load('index.js').then(module => module.loadLocale('en'));
  assert.deepEqual({ ...exact.sources }, { plain: 'Plain' });
  assert.throws(() => compileProject({ ...options, includeSources: ['missing'] }), /does not exist in the base catalog/);
  assert.throws(() => compileProject({ ...options, includeSources: 'invalid' }), /includeSources must be/);
});

test('standalone message selection returns only requested keys and reuses loaded functions', async t => {
  const project = await compiled(t, { baseLocale: 'en', catalogs: {
    en: JSON.parse('{"hello":"Hello {name}","unused":"Unused","then":"Then","__proto__":"Safe","product":"Product","product.price":"Price {amount}","__proto__.child":"Safe child"}'),
    fr: JSON.parse('{"hello":"Bonjour {name}","unused":"Inutilisé","then":"Alors","__proto__":"Sûr","product":"Produit","product.price":"Prix {amount}","__proto__.child":"Enfant sûr"}'),
  } });
  const { selectMessages } = await project.load('index.js');
  const load = selectMessages('hello', 'then', '__proto__', 'hello');
  const en = await load('en'), fr = await load('fr');
  assert.deepEqual(Object.keys(en.messages), ['hello', 'then', '__proto__']);
  assert.equal(Object.getPrototypeOf(en.messages), null);
  assert.equal(fr.messages.hello({ name: 'Ada' }), 'Bonjour Ada');
  assert.equal(fr.messages.then(), 'Alors');
  const nested = await selectMessages('product.price')('fr');
  assert.equal(nested.messages.product.price({ amount: 20 }), 'Prix 20');
  assert.equal(nested.messages['product.price'], nested.messages.product.price);
  assert.deepEqual(Object.keys(nested.messages), ['product.price']);
  const full = await project.load('locales/fr.js');
  assert.equal(full.default.product.price({ amount: 30 }), 'Prix 30');
  assert.equal(full.default.product(), 'Produit');
  assert.equal(full.default.__proto__.child(), 'Enfant sûr');
  assert.equal(Object.getPrototypeOf(full.default), null);
  assert.equal(en.messages, (await load('en')).messages);
  await assert.rejects(load('unknown'), /Unsupported locale/);
  await assert.rejects(selectMessages('missing')('en'), /Unknown message/);
  assert.throws(() => selectMessages(), /requires message IDs/);
});
