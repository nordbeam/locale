import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NextRequest } from 'next/server.js';
import { checkProject, compileProject, createCompiler, CompileError } from '../dist/compiler.js';
import { validateConfig } from '../dist/config.js';
import { mergePo, parsePo, serializePo } from '../dist/po.js';
import { exportPo, importPo } from '../dist/translations.js';
import { createNextMiddleware } from '../packages/locale/dist/next-middleware.js';
import { defineRouting } from '../packages/locale/dist/next-routing.js';
import { acceptLanguageLocale, alternateLinkHeader } from '../packages/locale/dist/locale-request.js';
import { scanContext } from '../dist/text-scan.js';
import { compiled, temporary } from './helpers.mjs';

// `se` is the project's code for Swedish; to Intl it is Northern Sami (plurals one/two/other).
const catalogs = {
  en: { items: '{count, plural, one {# item} other {# items}}', when: '{d, date, medium}', price: 'Price: {amount, number}' },
  se: { items: '{count, plural, one {# sak} two {# saker (två)} other {# saker}}', when: '{d, date, medium}', price: 'Pris: {amount, number}' },
};
const january = new Date(Date.UTC(2026, 0, 5, 12));

test('intlLocales formats a locale code as another language and keeps the code everywhere else', async t => {
  const plain = await compiled(t, { baseLocale: 'en', catalogs, timeZone: 'UTC' });
  const sami = (await plain.load('locales/se.js')).default;
  assert.equal(sami.items({ count: 2 }), '2 saker (två)');
  assert.equal(sami.when({ d: january }), new Intl.DateTimeFormat('se', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(january));
  assert.equal((await plain.load('index.js')).intlLocales, undefined);

  const mapped = await compiled(t, { baseLocale: 'en', catalogs, timeZone: 'UTC', intlLocales: { se: 'sv' } });
  const swedish = (await mapped.load('locales/se.js')).default;
  assert.equal(swedish.items({ count: 1 }), '1 sak');
  assert.equal(swedish.items({ count: 2 }), '2 saker', 'Swedish has no two category');
  assert.equal(swedish.when({ d: january }), new Intl.DateTimeFormat('sv', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(january));
  assert.equal(swedish.price({ amount: 1234.5 }), `Pris: ${new Intl.NumberFormat('sv').format(1234.5)}`);
  assert.doesNotMatch(mapped.files['internal/locales/se.js'], /Intl\.\w+\("se"/);
  assert.deepEqual(Object.keys(mapped.files).filter(file => file.includes('locales/')).sort(), Object.keys(plain.files).filter(file => file.includes('locales/')).sort());

  const index = await mapped.load('index.js');
  assert.deepEqual(index.locales, ['en', 'se']);
  assert.deepEqual({ ...index.intlLocales }, { en: 'en', se: 'sv' });
  assert.equal(Object.isFrozen(index.intlLocales), true);
  assert.match(mapped.files['index.d.ts'], /export declare const intlLocales: \{ readonly "en": "en"; readonly "se": "sv"; \};/);
  assert.equal((await index.loadLocale('se')).locale, 'se');
});

test('a project without intlLocales generates the same output as before', () => {
  const plain = compileProject({ baseLocale: 'en', catalogs }).files;
  for (const [name, content] of Object.entries(plain)) assert.doesNotMatch(content, /intlLocales/, name);
  // The base locale mapped to itself changes only the loader's added export.
  const identity = compileProject({ baseLocale: 'en', catalogs, intlLocales: { en: 'en' } }).files;
  for (const name of Object.keys(plain)) {
    if (name === 'index.js' || name === 'index.d.ts') assert.notEqual(identity[name], plain[name], name);
    else assert.equal(identity[name], plain[name], name);
  }
});

test('plural category checks use the mapped tag', () => {
  const se = { ...catalogs.se, items: '{count, plural, one {# sak} other {# saker}}' };
  const unmapped = checkProject({ baseLocale: 'en', catalogs: { en: catalogs.en, se } });
  assert.deepEqual(unmapped.warnings.map(warning => [warning.code, warning.locale]), [['MISSING_PLURAL_CATEGORY', 'se']]);
  assert.match(unmapped.warnings[0].message, /^se plural "count" has no two branch/);
  const mapped = checkProject({ baseLocale: 'en', catalogs: { en: catalogs.en, se }, intlLocales: { se: 'sv' } });
  assert.deepEqual(mapped.warnings, []);
  assert.equal(mapped.ok, true);
  // A Polish catalog under another code gets Polish categories, and the warning names the code.
  const polish = checkProject({ baseLocale: 'en', catalogs: { en: catalogs.en, pq: { ...catalogs.en } }, intlLocales: { pq: 'pl' } });
  assert.deepEqual(polish.warnings.map(warning => [warning.code, warning.locale, warning.message.split(' ')[0]]), [['MISSING_PLURAL_CATEGORY', 'pq', 'pq']]);
  assert.match(polish.warnings[0].message, /few, many/);
});

test('intlLocales entries must name a catalog and a canonical tag', () => {
  const check = intlLocales => checkProject({ baseLocale: 'en', catalogs, intlLocales }).errors.map(({ code, message, locale }) => ({ code, message, locale }));
  assert.deepEqual(check({ sw: 'sv' }), [{ code: 'UNKNOWN_INTL_LOCALE', message: 'intlLocales maps "sw", which has no catalog.', locale: undefined }]);
  assert.deepEqual(check({ se: 'SV' }), [{ code: 'INVALID_INTL_LOCALE', message: 'intlLocales maps "se" to "SV"; use the canonical tag "sv".', locale: undefined }]);
  assert.deepEqual(check({ se: 'sv_SE' }), [{ code: 'INVALID_INTL_LOCALE', message: 'intlLocales maps "se" to "sv_SE", which is not a BCP 47 locale.', locale: undefined }]);
  assert.deepEqual(check({ se: 'sv-SE' }), []);
  assert.throws(() => compileProject({ baseLocale: 'en', catalogs, intlLocales: { se: '' } }),
    error => error instanceof CompileError && error.diagnostics.map(d => d.code).join() === 'INVALID_INTL_LOCALE');
  assert.throws(() => compileProject({ baseLocale: 'en', catalogs, intlLocales: { fr: 'fr' } }),
    error => error instanceof CompileError && error.diagnostics.map(d => d.code).join() === 'UNKNOWN_INTL_LOCALE');
  assert.throws(() => validateConfig({ intlLocales: ['sv'] }), /intlLocales must be an object of locale codes to BCP 47 tags/);
  assert.throws(() => validateConfig({ intlLocales: { se: 1 } }), /intlLocales\.se must be a nonempty BCP 47 tag/);
  validateConfig({ intlLocales: { se: 'sv' } });
});

test('a watch-session compiler regenerates every formatter when intlLocales changes', () => {
  const compile = createCompiler();
  const before = compile({ baseLocale: 'en', catalogs, intlLocales: { se: 'sv' } });
  assert.match(before.files['internal/locales/se.js'], /Intl\.PluralRules\("sv"/);
  const after = compile({ baseLocale: 'en', catalogs });
  assert.match(after.files['internal/locales/se.js'], /Intl\.PluralRules\("se"/);
  assert.deepEqual(after.files, compileProject({ baseLocale: 'en', catalogs }).files);
  const again = compile({ baseLocale: 'en', catalogs, intlLocales: { se: 'nb' } });
  assert.deepEqual(again.files, compileProject({ baseLocale: 'en', catalogs, intlLocales: { se: 'nb' } }).files);
});

test('PO files name the mapped language and keep the locale code', async t => {
  const pure = serializePo({ baseLocale: 'en', locale: 'se', catalogs, intlLocales: { se: 'sv' } });
  const headers = parsePo(pure.po).headers;
  assert.equal(headers.get('language'), 'sv');
  assert.equal(headers.get('x-nordbeam-locale'), 'se');
  assert.equal(headers.get('x-source-language'), 'en');
  assert.equal(mergePo({ baseLocale: 'en', locale: 'se', catalogs, intlLocales: { se: 'sv' }, po: pure.po }).unchanged, 3);
  assert.doesNotMatch(serializePo({ baseLocale: 'en', locale: 'se', catalogs }).po, /X-Nordbeam-Locale:/);
  // A tool that only knows the tag may drop the code header; Language alone still matches.
  assert.equal(mergePo({ baseLocale: 'en', locale: 'se', catalogs, intlLocales: { se: 'sv' }, po: pure.po.replace('"X-Nordbeam-Locale: se\\n"\n', '') }).unchanged, 3);
  assert.throws(() => mergePo({ baseLocale: 'en', locale: 'se', catalogs, po: pure.po }), /PO Language is "sv"; expected "se"/);
  assert.throws(() => mergePo({ baseLocale: 'en', locale: 'se', catalogs, intlLocales: { se: 'sv' }, po: pure.po.replace('X-Nordbeam-Locale: se', 'X-Nordbeam-Locale: no') }), /PO X-Nordbeam-Locale is "no"; expected "se"/);

  const root = await temporary(t);
  await mkdir(join(root, 'messages'));
  for (const [locale, catalog] of Object.entries(catalogs)) await writeFile(join(root, 'messages', `${locale}.json`), JSON.stringify(catalog));
  const options = { root, baseLocale: 'en', locale: 'se', intlLocales: { se: 'sv' } };
  const exported = await exportPo(options);
  assert.equal(exported.po, pure.po);
  await writeFile(join(root, 'se.po'), exported.po);
  assert.equal((await importPo({ ...options, from: 'se.po', dryRun: true })).unchanged, 3);
});

test('routing negotiates, links and labels a mapped locale by its tag', () => {
  const routing = defineRouting({ locales: ['en', 'se'], defaultLocale: 'en', localePrefix: 'always', intlLocales: { en: 'en', se: 'sv' } });
  assert.equal(acceptLanguageLocale('sv-SE,sv;q=0.9', routing), 'se');
  assert.equal(acceptLanguageLocale('sv', routing), 'se');
  // Northern Sami is not what this project's se means.
  assert.equal(acceptLanguageLocale('se', routing), undefined);
  const unmapped = defineRouting({ locales: ['en', 'se'], defaultLocale: 'en', localePrefix: 'always' });
  assert.equal(acceptLanguageLocale('sv-SE', unmapped), undefined);
  assert.equal(acceptLanguageLocale('se', unmapped), 'se');

  const links = alternateLinkHeader({ domain: undefined, internal: '/about', search: '', url: 'http://localhost/se/about', protocol: 'http:' }, routing);
  assert.match(links, /<http:\/\/localhost\/se\/about>; rel="alternate"; hreflang="sv"/);
  assert.doesNotMatch(links, /hreflang="se"/);

  const middleware = createNextMiddleware(routing);
  const response = middleware(new NextRequest('http://localhost/', { headers: { 'accept-language': 'sv-SE' } }));
  assert.equal(response.headers.get('location'), 'http://localhost/se');

  assert.throws(() => defineRouting({ locales: ['en', 'se'], defaultLocale: 'en', intlLocales: { se: 'sv_SE' } }), /maps locale 'se' to 'sv_SE', which is not a canonical BCP 47 tag/);
});

test('the hardcoded scan names a mapped locale by its language', () => {
  const names = scanContext([], {}, ['en', 'se'], 'en', { se: 'sv' }).localeNames.get('se');
  for (const name of ['se', 'sv', 'swedish', 'svenska']) assert.ok(names.includes(name), name);
  assert.ok(!scanContext([], {}, ['en', 'se'], 'en').localeNames.get('se').includes('swedish'));
});
