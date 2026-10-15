import test from 'node:test';
import assert from 'node:assert/strict';
import { planReactMigration, applyReactMigration } from '@nordbeam/locale-migrate/react';

test('react-i18next hook becomes one unconditional generated messages hook and dead imports are removed', () => {
  const source = `import { useTranslation, Trans } from 'react-i18next';
import { hydrateRoot } from 'react-dom/client';
hydrateRoot(document.getElementById('root'), <App />);
function App() { const { t } = useTranslation('checkout'); return <p>{t('title')}</p>; }`;
  const plan = planReactMigration(source, { format: 'react-i18next', i18nImport: './app-i18n.js', initialExpression: 'initial' });
  assert.match(plan.code, /import \{ i18n \} from "\.\/app-i18n\.js"/);
  assert.match(plan.code, /const m = i18n\.useMessages\(\);/);
  assert.match(plan.code, /m\.checkout\.title\(\)/);
  assert.match(plan.code, /hydrateRoot\([^,]+, <i18n\.Provider initial=\{initial\}>/);
  assert.doesNotMatch(plan.code, /useTranslation|Trans/);
  assert.equal(plan.wrappedRoots, 1);
  assert.equal(applyReactMigration(plan), plan.code);
});

test('FormatJS, Lingui, and Tolgee hook bindings are migrated conservatively', () => {
  const intl = planReactMigration(`import { useIntl, IntlProvider } from 'react-intl';
const intl = useIntl();
export const title = intl.formatMessage({ id: 'title' });`, { format: 'react-intl' });
  assert.match(intl.code, /const m = i18n\.useMessages\(\);/);
  assert.match(intl.code, /m\.title\(\)/);
  assert.doesNotMatch(intl.code, /useIntl/);

  const lingui = planReactMigration(`import { useLingui } from '@lingui/react';
const { i18n: lingui, _: t } = useLingui();
export const value = t('save', values);`, { format: 'lingui' });
  assert.match(lingui.code, /const m = i18n\.useMessages\(\);/);
  assert.match(lingui.code, /m\.save\(values\)/);
  assert.doesNotMatch(lingui.code, /useLingui/);

  const tolgee = planReactMigration(`import { useTranslate, TolgeeProvider } from '@tolgee/react';
const t = useTranslate();
export const value = t('save', values);`, { format: 'tolgee' });
  assert.match(tolgee.code, /const m = i18n\.useMessages\(\);/);
  assert.match(tolgee.code, /m\.save\(values\)/);
  assert.doesNotMatch(tolgee.code, /useTranslate/);
});

test('conditional hooks and absent initial snapshots are skipped', () => {
  const source = `import { useTranslation } from 'react-i18next';
import { hydrateRoot } from 'react-dom/client';
function App() { if (enabled) { const { t } = useTranslation(); return t('title'); } return null; }
hydrateRoot(root, <App />);`;
  const plan = planReactMigration(source, { format: 'react-i18next' });
  assert.equal(plan.replacements, 0);
  assert.match(plan.code, /useTranslation/);
  assert.ok(plan.skipped.some(item => item.reason.includes('Rules of Hooks')));
  assert.ok(plan.skipped.some(item => item.reason.includes('initial snapshot')));
  assert.doesNotMatch(plan.code, /i18n\.Provider/);
});

test('already wrapped roots are not double wrapped and import paths are calculated', () => {
  const source = `import { createRoot } from 'react-dom/client';
import { useTranslation } from 'react-i18next';
const { t } = useTranslation();
createRoot(document.getElementById('root')).render(<i18n.Provider initial={initial}><App /></i18n.Provider>);`;
  const plan = planReactMigration(source, {
    root: '/project', filename: '/project/src/entry.tsx', i18nModule: '/project/src/i18n/index.ts', format: 'i18next', initial: 'initial',
  });
  assert.equal(plan.wrappedRoots, 0);
  assert.equal((plan.code.match(/<i18n\.Provider\b/g) ?? []).length, 1);
  assert.match(plan.code, /from "\.\/i18n\/index"/);
});

test('Vite client scaffold uses initialLocale and never invents a locale', () => {
  const source = `import { createRoot } from 'react-dom/client';
import { useTranslation } from 'react-i18next';
function App() { const { t } = useTranslation(); return <p>{t('title')}</p>; }
createRoot(root).render(<App />);`;
  const plan = planReactMigration(source, { format: 'react-i18next', framework: 'vite-react', initialLocaleExpression: 'locale' });
  assert.match(plan.code, /<i18n\.Provider initialLocale=\{locale\}>/);
  assert.doesNotMatch(plan.code, /initial=\{/);
  const skipped = planReactMigration(source, { format: 'react-i18next', framework: 'vite-react' });
  assert.equal(skipped.wrappedRoots, 0);
  assert.ok(skipped.skipped.some(item => item.reason.includes('initialLocaleExpression')));
});

test('retained legacy hooks receive one generated binding and plans are idempotent', () => {
  const source = `import { useTranslation } from 'react-i18next';
export function Search({ id }) {
  const { t } = useTranslation();
  return <>{t('title')} {t(id)}</>;
}`;
  const first = planReactMigration(source, { format: 'react-i18next' });
  assert.equal(first.replacements, 1);
  assert.equal((first.code.match(/const m = i18n\.useMessages\(\)/g) ?? []).length, 1);
  assert.equal(planReactMigration(first.code, { format: 'react-i18next' }).changed, false);

  const unsupported = planReactMigration(`import { useLingui } from '@lingui/react/macro';
export function Label() { const { i18n } = useLingui(); return <Trans>Save</Trans>; }`, { format: 'lingui' });
  assert.equal(unsupported.replacements, 0);
  assert.equal(unsupported.changed, false);
  assert.doesNotMatch(unsupported.code, /useMessages/);
});
