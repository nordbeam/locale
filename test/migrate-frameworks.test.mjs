import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyFrameworkMigration, applyFrameworkProject, planFrameworkMigration, planFrameworkProject } from '@nordbeam/locale-migrate/frameworks';
import { temporary } from './helpers.mjs';

test('Vue I18n rewrites static setup calls and removes only dead bindings/imports', () => {
  const source = `import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
const { t } = useI18n();
const title = t('checkout.title');
const count = computed(() => title);
`;
  const plan = planFrameworkMigration(source, { framework: 'vue-i18n' });
  assert.match(plan.code, /m\.checkout\.title\(\)/);
  assert.doesNotMatch(plan.code, /from 'vue-i18n'/);
  assert.match(plan.code, /from 'vue'/);
  assert.equal(plan.callsRewritten, 1);
  assert.equal(plan.bindingsRemoved, 1);
  assert.equal(plan.importsRemoved, 1);
  assert.equal(applyFrameworkMigration(source, plan).code, plan.code);
  assert.equal(applyFrameworkMigration(plan).applied, true);
});

test('Svelte import cleanup preserves unrelated stores and reports template boundaries', () => {
  const source = `import { _, t, locale } from 'svelte-i18n';
import { onMount } from 'svelte';
const title = $_('home.title');
locale.set('fr');
<h1>{$t('home.heading')}</h1>`;
  const plan = planFrameworkMigration(source, { framework: 'svelte-i18n' });
  assert.match(plan.code, /m\.home\.title\(\)/);
  assert.match(plan.code, /<h1>\{m\.home\.heading\(\)\}<\/h1>/);
  assert.match(plan.code, /from 'svelte-i18n'/);
  assert.match(plan.code, /locale/);
  assert.ok(plan.skips.some(skip => skip.code === 'SVELTE_I18N_SETUP'));
});

test('Angular services are rewritten but DI/provider/bootstrap integration is never changed', () => {
  const source = `import { inject } from '@angular/core';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
const service = inject(TranslocoService);
const text = service.translate('account.title', { name });
export const providers = [provideTransloco({ config: { defaultLang: 'en' } })];
`;
  const plan = planFrameworkMigration(source, { framework: 'transloco' });
  assert.match(plan.code, /m\.account\.title\(\{ name \}\)/);
  assert.doesNotMatch(plan.code, /inject\(TranslocoService\)/);
  assert.match(plan.code, /provideTransloco/);
  assert.ok(plan.skips.some(skip => skip.code === 'TRANSLOCO_PROVIDER' && skip.kind === 'provider'));
  assert.doesNotMatch(plan.code, /react|useTranslation|createContext/i);
});

test('ngx-translate keeps constructor/pipe boundaries and removes a dead inject binding', () => {
  const source = `import { inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
const service = inject(TranslateService);
const title = service.instant('account.save');
{{ 'account.cancel' | translate }}
`;
  const plan = planFrameworkMigration(source, { framework: 'ngx-translate' });
  assert.match(plan.code, /m\.account\.save\(\)/);
  assert.doesNotMatch(plan.code, /inject\(TranslateService\)/);
  assert.doesNotMatch(plan.code, /from '@ngx-translate\/core'/);
  assert.ok(plan.skips.some(skip => skip.code === 'NGX_TRANSLATE_TEMPLATE'));
});

test('typesafe-i18n conversion never injects React and reports adapter loading', () => {
  const source = `import { useI18nContext } from 'typesafe-i18n';
const { LL } = useI18nContext();
const price = LL.product.price({ amount });
const i18n = i18nObject('en', dictionary);
loadedLocales.en = dictionary;
`;
  const plan = planFrameworkMigration(source, { framework: 'typesafe-i18n' });
  assert.match(plan.code, /m\.product\.price\(\{ amount \}\)/);
  assert.doesNotMatch(plan.code, /from 'react'|useState|createContext|useTranslation/);
  assert.ok(plan.skips.some(skip => skip.code === 'TYPESAFE_I18N_ADAPTER'));
  assert.ok(plan.skips.some(skip => skip.code === 'TYPESAFE_I18N_LOADER'));
});

test('plans are source-bound and dynamic calls remain explicit skips', () => {
  const source = `import { useI18n } from 'vue-i18n';
const { t } = useI18n();
t(messageKey);
`;
  const plan = planFrameworkMigration(source, { framework: 'vue-i18n' });
  assert.equal(plan.callsRewritten, 0);
  assert.ok(plan.codemodSkips.some(skip => skip.reason === 'message key is dynamic'));
  assert.throws(() => applyFrameworkMigration(`${source}// changed`, plan), /does not match/);
});

test('multiple legacy imports are cleaned from descending offsets', () => {
  const source = `import { _, t } from 'svelte-i18n';
import { locale } from 'svelte-i18n';
const title = $_('home.title');
locale.set('fr');
`;
  const plan = planFrameworkMigration(source, { framework: 'svelte-i18n' });
  assert.equal(plan.importsRemoved, 2);
  assert.match(plan.code, /import \{ locale \} from 'svelte-i18n'/);
  assert.doesNotMatch(plan.code, /import \{ _, t \}/);
});

test('Vue and typesafe context fields are preserved when the binding has other responsibilities', () => {
  const vue = planFrameworkMigration(`import { useI18n } from 'vue-i18n';\nconst { t, locale } = useI18n();\nconst title = t('title');\nconsole.log(locale.value);\n`, { framework: 'vue-i18n' });
  assert.match(vue.code, /const \{ t, locale \} = useI18n\(\)/);
  const safe = planFrameworkMigration(`import { useI18nContext } from 'typesafe-i18n';\nconst { LL, locale } = useI18nContext();\nconst title = LL.title();\nconsole.log(locale);\n`, { framework: 'typesafe-i18n' });
  assert.match(safe.code, /const \{ LL, locale \} = useI18nContext\(\)/);
});

test('project apply stages changed files and leaves the plan/report intact', async t => {
  const root = await temporary(t), sourceDir = join(root, 'src'), file = join(sourceDir, 'page.ts'), second = join(sourceDir, 'other.ts');
  await mkdir(sourceDir);
  const firstSource = `import { useI18n } from 'vue-i18n';\nconst { t } = useI18n();\nexport const title = t('title');\n`;
  const secondSource = `import { useI18n } from 'vue-i18n';\nconst { t } = useI18n();\nexport const title = t('other');\n`;
  await writeFile(file, firstSource);
  await writeFile(second, secondSource);
  const plan = await planFrameworkProject({ root, framework: 'vue-i18n' });
  assert.equal(plan.files.length, 2);
  await writeFile(second, '// edited while the plan was open\n');
  await assert.rejects(applyFrameworkProject(plan), /stale/);
  assert.match(await readFile(file, 'utf8'), /t\('title'\)/);
  await writeFile(second, secondSource);
  await applyFrameworkProject(plan);
  assert.match(await readFile(file, 'utf8'), /m\.title\(\)/);
});
