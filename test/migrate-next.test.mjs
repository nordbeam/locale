import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  applyNextMigration,
  migrateNextSource,
  migrateNextIntlConfigSource,
  migrateNextIntlNavigationSource,
  migrateNextIntlRoutingSource,
  migrateNextMiddlewareSource,
  planNextMigration,
} from '@nordbeam/locale-migrate/next';
import { temporary } from './helpers.mjs';

test('loads the route locale in a Server Component and cleans next-intl imports', () => {
  const source = `import {getTranslations} from 'next-intl/server';
export default async function Page({params}: {params: Promise<{locale: string}>}) {
  const t = await getTranslations('Home');
  return <h1>{t('title')}</h1>;
}`;
  const result = migrateNextSource(source, {
    root: '/project', file: '/project/app/[locale]/page.tsx', framework: 'next-intl',
  });
  assert.match(result.code, /import \{ i18n \} from ["']\.\.\/\.\.\/src\/i18n\/next\.js/);
  assert.match(result.code, /const \{ locale \} = await params/);
  assert.match(result.code, /await i18n\.loadLocale\(locale\)/);
  assert.match(result.code, /m\.Home\.title\(\)/);
  assert.doesNotMatch(result.code, /getTranslations|useTranslations/);
  assert.doesNotMatch(result.code, /['"]use client['"]/);
});

test('migrates next-intl proxy middleware to the Nordbeam routing helper', () => {
  const result = migrateNextMiddlewareSource(`import createMiddleware from 'next-intl/middleware';
import { routing } from './libs/I18nRouting';
const handleI18nRouting = createMiddleware(routing);`);
  assert.equal(result.replacements, 2);
  assert.match(result.code, /createNextMiddleware/);
  assert.match(result.code, /@nordbeam\/locale\/next\/middleware/);
  assert.doesNotMatch(result.code, /next-intl\/middleware|createMiddleware/);
});

test('uses a props-owned params promise without redeclaring the route locale', () => {
  const source = `import {getTranslations} from 'next-intl/server';
export default async function Layout(props: {params: Promise<{locale: string}>}) {
  const { locale } = await props.params;
  const t = await getTranslations('Home');
  return <h1>{t('title')}</h1>;
}`;
  const result = migrateNextSource(source, {
    root: '/project', file: '/project/app/[locale]/layout.tsx', framework: 'next-intl',
  });
  assert.equal((result.code.match(/const \{ locale \}/g) ?? []).length, 1);
  assert.match(result.code, /await props\.params/);
  assert.match(result.code, /await i18n\.loadLocale\(locale\)/);
});

test('server value uses retain the legacy helper while static calls migrate', () => {
  const source = `import {getTranslations} from 'next-intl/server';
export default async function Page({params}) {
  const t = await getTranslations('A');
  return <><p>{t('title')}</p><Child t={t}/></>;
}`;
  const result = migrateNextSource(source, {
    root: '/project', file: '/project/app/[locale]/page.tsx', framework: 'next-intl',
  });
  assert.equal(result.replacements, 1);
  assert.match(result.code, /m\.A\.title\(\)/);
  assert.match(result.code, /const t = await getTranslations\('A'\)/);
  assert.match(result.code, /<Child t=\{t\}/);
  assert.ok(result.skipped.some(item => /t is used as a value/.test(item.reason)));
});

test('server migration refuses translation helpers outside the default component', () => {
  const source = `import {getTranslations} from 'next-intl/server';
export default async function Page({params}) {
  const t = await getTranslations('A');
  return <p>{t('title')}</p>;
}
export async function Helper({params}) {
  const u = await getTranslations('B');
  return <p>{u('subtitle')}</p>;
}`;
  const result = migrateNextSource(source, {
    root: '/project', file: '/project/app/[locale]/page.tsx', framework: 'next-intl',
  });
  assert.equal(result.code, source);
  assert.equal(result.replacements, 0);
  assert.ok(result.skipped.some(item => item.kind === 'shape' && /cross the default component boundary/.test(item.reason)));
});

test('server migration reuses locale from a multi-field params destructuring', () => {
  const source = `import {getTranslations} from 'next-intl/server';
export default async function Page({params}) {
  const { locale, slug } = await params;
  const t = await getTranslations('A');
  return <p>{t('title')}</p>;
}`;
  const result = migrateNextSource(source, {
    root: '/project', file: '/project/app/[locale]/page.tsx', framework: 'next-intl',
  });
  assert.equal((result.code.match(/const \{ locale/g) ?? []).length, 1);
  assert.match(result.code, /const \{ locale, slug \} = await params/);
  assert.ok(result.code.indexOf('const { locale, slug }') < result.code.indexOf('i18n.loadLocale(locale)'));
  assert.doesNotMatch(result.code, /const \{ locale \} = await params/);
});

test('skips named server translation boundaries instead of binding them in the default component', () => {
  const source = `import {getTranslations} from 'next-intl/server';
export async function generateMetadata(props: {params: Promise<{locale: string}>}) {
  const t = await getTranslations('Meta');
  return {title: t('title')};
}
export default async function Page(props: {params: Promise<{locale: string}>}) {
  return <main />;
}`;
  const result = migrateNextSource(source, {
    root: '/project', file: '/project/app/[locale]/page.tsx', framework: 'next-intl',
  });
  assert.equal(result.code, source);
  assert.equal(result.replacements, 0);
  assert.match(result.skipped[0].reason, /generateMetadata/);
});

test('binds an existing Client Component to the generated hook when its provider is external', () => {
  const source = `'use client';
import {useTranslations} from 'next-intl';
export default function Cart({locale}: {locale: string}) {
  const t = useTranslations('Cart');
  return <p>{t('total', {count: 2})}</p>;
}`;
  const result = migrateNextSource(source, {
    root: '/project', file: '/project/app/cart.tsx', framework: 'next-intl',
  });
  assert.match(result.code, /^'use client';\nimport \{ i18n \} from/);
  assert.match(result.code, /const \{ messages: m \} = i18n\.useI18n\(\)/);
  assert.match(result.code, /m\.Cart\.total\(\{count: 2\}\)/);
  assert.doesNotMatch(result.code, /useTranslations/);
});

test('skips a legacy provider in the same component to prevent hook-before-provider execution', () => {
  const source = `'use client';
import {NextIntlClientProvider, useTranslations} from 'next-intl';
export default function Cart({locale}: {locale: string}) {
  const t = useTranslations('Cart');
  return <NextIntlClientProvider locale={locale}><p>{t('total')}</p></NextIntlClientProvider>;
}`;
  const result = migrateNextSource(source, {
    root: '/project', file: '/project/app/cart.tsx', framework: 'next-intl',
  });
  assert.equal(result.code, source);
  assert.equal(result.replacements, 0);
  assert.equal(result.skipped[0].kind, 'provider');
  assert.match(result.skipped[0].reason, /provider boundary/);
});

test('supports next-i18next/react-i18next and next-international hook bindings', () => {
  const i18next = migrateNextSource(`'use client';
import {useTranslation} from 'react-i18next';
export function Widget(){ const {t} = useTranslation('Shop'); return <p>{t('price')}</p>; }`, {
    root: '/project', file: '/project/app/widget.tsx', framework: 'react-i18next',
  });
  assert.match(i18next.code, /i18n\.useI18n\(\)/);
  assert.match(i18next.code, /m\.Shop\.price\(\)/);
  assert.doesNotMatch(i18next.code, /react-i18next|useTranslation/);

  const international = migrateNextSource(`'use client';
import {useI18n} from 'next-international/client';
export function Banner(){ const t = useI18n(); return <p>{t('banner.title')}</p>; }`, {
    root: '/project', file: '/project/app/banner.tsx', framework: 'next-international',
  });
  assert.match(international.code, /m\.banner\.title\(\)/);
  assert.doesNotMatch(international.code, /from ['"]next-international/);
});

test('adds static locale params without Node imports and keeps Edge-safe output', () => {
  const source = `import {getTranslations} from 'next-intl/server';
export const runtime = 'edge';
export default async function Page({params}) {
  const t = await getTranslations();
  return <p>{t('hello')}</p>;
}`;
  const result = migrateNextSource(source, {
    root: '/project', file: '/project/app/[lang]/page.tsx', framework: 'next-intl',
  });
  assert.match(result.code, /export function generateStaticParams\(\)/);
  assert.match(result.code, /i18n\.generateStaticParams\(["']lang["']\)/);
  assert.doesNotMatch(result.code, /from ['"]node:/);
  assert.doesNotMatch(result.code, /import \{getTranslations\}/);
});

test('skips ambiguous locale and provider ownership explicitly', () => {
  const locale = migrateNextSource(`import {getTranslations} from 'next-intl/server';
export default async function Page({params}) { const t = await getTranslations(); return t('x'); }`, {
    root: '/project', file: '/project/app/[lang]/[section]/page.tsx', framework: 'next-intl',
  });
  assert.equal(locale.code.includes('loadLocale'), false);
  assert.equal(locale.replacements, 0);
  assert.equal(locale.skipped[0].kind, 'locale');

  const provider = migrateNextSource(`'use client'; import {NextIntlClientProvider,useTranslations} from 'next-intl'; export default function Page(){const t=useTranslations();return <NextIntlClientProvider>{t('x')}</NextIntlClientProvider>}`, {
    root: '/project', file: '/project/app/page.tsx', framework: 'next-intl',
  });
  assert.equal(provider.replacements, 0);
  assert.equal(provider.skipped[0].kind, 'provider');
});

test('plans without writing and applies only an unchanged reviewed plan', async t => {
  const root = await temporary(t), app = join(root, 'app'), file = join(app, '[locale]', 'page.tsx');
  await mkdir(join(app, '[locale]'), {recursive: true});
  await writeFile(file, `import {getTranslations} from 'next-intl/server';
export default async function Page({params}) { const t = await getTranslations(); return <p>{t('x')}</p>; }
`);
  const plan = await planNextMigration({root, framework: 'next-intl'});
  assert.equal(plan.dryRun, true);
  assert.equal(plan.changed.length, 1);
  assert.match(await readFile(file, 'utf8'), /getTranslations/);
  const applied = await applyNextMigration(plan);
  assert.equal(applied.dryRun, false);
  assert.match(await readFile(file, 'utf8'), /i18n\.loadLocale/);
});

test('project planning wires migrated Client Components through their nearest locale layout', async t => {
  const root = await temporary(t), route = join(root, 'app', '[locale]');
  await mkdir(route, { recursive: true });
  await writeFile(join(route, 'layout.tsx'), `export default async function Layout({ children, params }) { return <html><body>{children}</body></html>; }\n`);
  await writeFile(join(route, 'widget.tsx'), `'use client';\nimport { useTranslations } from 'next-intl';\nexport function Widget() { const t = useTranslations('Home'); return <p>{t('title')}</p>; }\n`);
  const plan = await planNextMigration({ root, framework: 'next-intl' });
  const layout = plan.changed.find(item => item.file.endsWith('layout.tsx'));
  assert.ok(layout);
  assert.match(layout.after, /NordbeamLocaleProvider locale=\{locale\}/);
  assert.match(layout.after, /const \{ locale \} = await params/);
  assert.match(layout.after, /provider\.js/);
  assert.equal(plan.skipped.some(item => item.kind === 'provider'), false);
});

test('Next migration propagates call diagnostics and strict planning refuses partial files', async t => {
  const source = `'use client';\nimport {useTranslations} from 'next-intl';\nexport function Widget({keyName}) { const t = useTranslations(); return <p>{t(keyName)}</p>; }`;
  const result = migrateNextSource(source, { root: '/project', file: '/project/app/[locale]/widget.tsx', framework: 'next-intl' });
  assert.equal(result.replacements, 0);
  assert.ok(result.skipped.some(item => item.kind === 'call' && /dynamic/.test(item.reason)));

  const root = await temporary(t), route = join(root, 'app', '[locale]');
  await mkdir(route, { recursive: true }); await writeFile(join(route, 'page.tsx'), source);
  await assert.rejects(planNextMigration({ root, framework: 'next-intl', strict: true }), /Strict codemod refused/);
  assert.match(await readFile(join(route, 'page.tsx'), 'utf8'), /t\(keyName\)/);
});

test('Next migration keeps the legacy boundary when unsupported helper members survive', () => {
  const source = `'use client';
import { useTranslations } from 'next-intl';
export function Widget({ keyName }) {
  const t = useTranslations();
  return <p>{t('title')} {t.raw(keyName)}</p>;
}`;
  const result = migrateNextSource(source, { root: '/project', file: '/project/app/[locale]/widget.tsx', framework: 'next-intl' });
  assert.equal(result.replacements, 1);
  assert.match(result.code, /m\.title\(\)/);
  assert.match(result.code, /const \{ messages: m \} = i18n\.useI18n\(\)/);
  assert.match(result.code, /t\.raw\(keyName\)/);
  assert.match(result.code, /useTranslations/);
  assert.ok(result.skipped.some(item => /t\.raw.*not supported/.test(item.reason)));
});

test('Next migration binds m for mixed static/dynamic calls and keeps component-local hooks', () => {
  const mixed = migrateNextSource(`'use client';
import { useTranslations } from 'next-intl';
export default function A() { const t = useTranslations(); return <>{t('title')} {t(key)}</>; }`, {
    root: '/project', file: '/project/app/[locale]/page.tsx', framework: 'next-intl',
  });
  assert.match(mixed.code, /const \{ messages: m \} = i18n\.useI18n\(\)/);
  assert.match(mixed.code, /m\.title\(\)/);
  assert.match(mixed.code, /t\(key\)/);
  assert.match(mixed.code, /useTranslations/);
  assert.ok(mixed.skipped.some(item => /dynamic/.test(item.reason)));

  const components = migrateNextSource(`'use client';
import { useTranslations } from 'next-intl';
export default function A() { const t = useTranslations('a'); return t('title'); }
export function B() { const u = useTranslations('b'); return u('title'); }`, {
    root: '/project', file: '/project/app/[locale]/page.tsx', framework: 'next-intl',
  });
  assert.equal((components.code.match(/const \{ messages: m \} = i18n\.useI18n\(\)/g) ?? []).length, 2);
  assert.match(components.code, /m\.a\.title\(\)/);
  assert.match(components.code, /m\.b\.title\(\)/);

  const adjacent = migrateNextSource(`'use client'; import { useTranslations } from 'next-intl'; export function C(){ const a=useTranslations('a'); const b=useTranslations('b'); return a('x') + b('y'); }`, {
    root: '/project', file: '/project/app/[locale]/adjacent.tsx', framework: 'next-intl',
  });
  assert.doesNotMatch(adjacent.code, /useTranslations/);
  assert.doesNotMatch(adjacent.code, /const [ab]=useTranslations/);
  assert.match(adjacent.code, /m\.a\.x\(\)/);
  assert.match(adjacent.code, /m\.b\.y\(\)/);

  const mixedScopes = migrateNextSource(`'use client';
import { useTranslations } from 'next-intl';
export function AlreadyMigrated() {
  const { messages: m } = i18n.useI18n();
  return m.existing();
}
export function StillLegacy() {
  const t = useTranslations();
  return t('title');
}`, {
    root: '/project', file: '/project/app/[locale]/mixed.tsx', framework: 'next-intl',
  });
  assert.equal((mixedScopes.code.match(/const \{ messages: m \} = i18n\.useI18n\(\)/g) ?? []).length, 2);
  assert.match(mixedScopes.code, /return m\.existing\(\)/);
  assert.match(mixedScopes.code, /return m\.title\(\)/);
  assert.doesNotMatch(mixedScopes.code, /useTranslations/);
});

test('Next migration reports rich helpers and does not duplicate an existing locale binding', () => {
  const rich = migrateNextSource(`import { getTranslations } from 'next-intl/server';
export default async function Page({ params }) { const t = await getTranslations(); return t.rich('title', { strong }); }`, {
    root: '/project', file: '/project/app/[locale]/page.tsx', framework: 'next-intl',
  });
  assert.equal(rich.replacements, 0);
  assert.ok(rich.skipped.some(item => /t\.rich/.test(item.reason)));

  const existing = migrateNextSource(`import { getTranslations } from 'next-intl/server';
export default async function Page({ params }) { const { locale } = params; const t = await getTranslations(); return t('title'); }`, {
    root: '/project', file: '/project/app/[locale]/page.tsx', framework: 'next-intl',
  });
  assert.equal((existing.code.match(/const \{ locale \}/g) ?? []).length, 1);
});

test('Next server migration preserves static object namespaces', () => {
  const source = `import { getTranslations } from 'next-intl/server';
export default async function Page({ params }) {
  const t = await getTranslations({ namespace: 'Shop' });
  return t('title');
}`;
  const result = migrateNextSource(source, { root: '/project', file: '/project/app/[locale]/page.tsx', framework: 'next-intl' });
  assert.equal(result.replacements, 1);
  assert.match(result.code, /m\.Shop\.title\(\)/);
  assert.equal(result.skipped.length, 0);
});

test('Next migration rejects synchronous params boundaries before rewriting', () => {
  const source = `import { getTranslations } from 'next-intl/server';
export default function Page({ params }) {
  const t = getTranslations();
  return t('title');
}`;
  const result = migrateNextSource(source, { root: '/project', file: '/project/app/[locale]/page.tsx', framework: 'next-intl' });
  assert.equal(result.replacements, 0);
  assert.equal(result.code, source);
  assert.ok(result.skipped.some(item => item.kind === 'shape' && /async component/.test(item.reason)));
});

test('migrates next-intl routing, navigation and plugin modules and reports shapes it cannot convert', () => {
  const routing = migrateNextIntlRoutingSource(`import { defineRouting } from 'next-intl/routing';\nexport const routing = defineRouting({ locales: ['en'], defaultLocale: 'en' });\n`);
  assert.equal(routing.replacements, 1);
  assert.match(routing.code, /from '@nordbeam\/locale\/next\/routing'/);
  assert.match(migrateNextIntlRoutingSource(`import { defineRouting, type Routing } from 'next-intl/routing';`).skipped[0].reason, /imports type Routing besides defineRouting/);
  const navigation = migrateNextIntlNavigationSource(`import { createNavigation } from 'next-intl/navigation';\nexport const { Link } = createNavigation(routing);\n`);
  assert.match(navigation.code, /from '@nordbeam\/locale\/next\/navigation'/);
  assert.equal(migrateNextIntlNavigationSource(`import { createSharedPathnamesNavigation } from 'next-intl/navigation';`).replacements, 0);

  const config = migrateNextIntlConfigSource(`import type { NextConfig } from 'next';\nimport createNextIntlPlugin from 'next-intl/plugin';\nconst withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');\nconst config: NextConfig = {};\nexport default withNextIntl(config);\n`);
  assert.equal(config.code, `import type { NextConfig } from 'next';\nimport { withNordbeamLocale } from '@nordbeam/locale/next';\nconst config: NextConfig = {};\nexport default withNordbeamLocale(config);\n`);
  const inline = migrateNextIntlConfigSource(`import createNextIntlPlugin from 'next-intl/plugin';\nexport default createNextIntlPlugin()({ reactStrictMode: true });\n`);
  assert.match(inline.code, /export default withNordbeamLocale\(\{ reactStrictMode: true \}\);/);
  const options = migrateNextIntlConfigSource(`import createNextIntlPlugin from 'next-intl/plugin';\nconst w = createNextIntlPlugin({ experimental: { createMessagesDeclaration: './messages/en.json' } });\nexport default w({});\n`);
  assert.equal(options.replacements, 0);
  assert.match(options.skipped[0].reason, /options other than the request-config path/);
});

test('middleware migration handles renamed factories and refuses inline options', () => {
  const renamed = migrateNextMiddlewareSource(`import createIntlMiddleware from 'next-intl/middleware';\nimport { i18nRouting } from './routing';\nexport default createIntlMiddleware(i18nRouting);\n`);
  assert.match(renamed.code, /export default createNextMiddleware\(i18nRouting\)/);
  const inline = migrateNextMiddlewareSource(`import createMiddleware from 'next-intl/middleware';\nexport default createMiddleware({ locales: ['en'], defaultLocale: 'en' });\n`, 'src/middleware.ts');
  assert.equal(inline.replacements, 0);
  assert.equal(inline.skipped[0].file, 'src/middleware.ts');
});

async function nextIntlProject(t, { middleware = 'middleware.ts', next = '^16.0.0', layout = 'src' } = {}) {
  const root = await temporary(t), at = path => join(root, path), base = layout === 'src' ? 'src/' : '';
  await mkdir(at(`${base}app/[locale]`), { recursive: true });
  await mkdir(at(`${base}i18n`), { recursive: true });
  await writeFile(at('package.json'), JSON.stringify({ dependencies: { next, 'next-intl': '^4.0.0' } }));
  await writeFile(at(`${base}${middleware}`), `import createMiddleware from 'next-intl/middleware';\nimport { routing } from './i18n/routing';\nexport default createMiddleware(routing);\nexport const config = { matcher: ['/', '/(fr|en)/:path*'] };\n`);
  await writeFile(at(`${base}i18n/routing.ts`), `import { defineRouting } from 'next-intl/routing';\nexport const routing = defineRouting({ locales: ['en', 'fr'], defaultLocale: 'en' });\n`);
  await writeFile(at(`${base}i18n/navigation.ts`), `import { createNavigation } from 'next-intl/navigation';\nimport { routing } from './routing';\nexport const { Link } = createNavigation(routing);\n`);
  await writeFile(at(`${base}i18n/request.ts`), `import { getRequestConfig } from 'next-intl/server';\nexport default getRequestConfig(async () => ({ locale: 'en', messages: {} }));\n`);
  await writeFile(at('next.config.ts'), `import createNextIntlPlugin from 'next-intl/plugin';\nconst withNextIntl = createNextIntlPlugin('./${base}i18n/request.ts');\nexport default withNextIntl({});\n`);
  await writeFile(at(`${base}app/[locale]/page.tsx`), `export default function Page() { return null; }\n`);
  return { root, base };
}

test('plans an in-place next-intl proxy, routing, navigation and config rewrite without a second request file', async t => {
  const { root } = await nextIntlProject(t);
  const plan = await planNextMigration({ root, framework: 'next-intl' });
  const files = plan.changed.map(item => item.file.slice(root.length + 1)).sort();
  assert.deepEqual(files, ['next.config.ts', 'src/i18n/navigation.ts', 'src/i18n/routing.ts', 'src/middleware.ts']);
  assert.deepEqual(plan.skipped, []);
  assert.ok(plan.manualActions.some(action => /^Rename src\/middleware\.ts to proxy\.ts/.test(action)));
  assert.ok(plan.manualActions.some(action => /^Delete src\/i18n\/request\.ts/.test(action)));
  await applyNextMigration(plan);
  assert.match(await readFile(join(root, 'src/middleware.ts'), 'utf8'), /createNextMiddleware\(routing\)/);
  assert.match(await readFile(join(root, 'next.config.ts'), 'utf8'), /withNordbeamLocale\(\{\}\)/);
  await assert.rejects(readFile(join(root, 'src/proxy.ts')), { code: 'ENOENT' });
});

test('an existing proxy.ts on Next 16, or any middleware on Next 15, needs no rename action', async t => {
  const proxy = await nextIntlProject(t, { middleware: 'proxy.ts', layout: 'root' });
  const proxyPlan = await planNextMigration({ root: proxy.root, framework: 'next-intl' });
  assert.ok(proxyPlan.changed.some(item => item.file.endsWith('/proxy.ts') && /createNextMiddleware/.test(item.after)));
  assert.equal(proxyPlan.manualActions.some(action => /^Rename/.test(action)), false);
  const legacy = await nextIntlProject(t, { next: '^15.5.0' });
  assert.equal((await planNextMigration({ root: legacy.root, framework: 'next-intl' })).manualActions.some(action => /^Rename/.test(action)), false);
});

test('unconventional next-intl boundary files are skipped and make strict planning refuse', async t => {
  const { root } = await nextIntlProject(t);
  await writeFile(join(root, 'src/middleware.ts'), `import createMiddleware from 'next-intl/middleware';\nexport default createMiddleware({ locales: ['en'], defaultLocale: 'en' });\n`);
  const plan = await planNextMigration({ root, framework: 'next-intl' });
  assert.ok(plan.skipped.some(item => item.file.endsWith('src/middleware.ts') && /routing object/.test(item.reason)));
  assert.equal(plan.changed.some(item => item.file.endsWith('src/middleware.ts')), false);
  await assert.rejects(planNextMigration({ root, framework: 'next-intl', strict: true }), /Strict codemod refused/);
});
