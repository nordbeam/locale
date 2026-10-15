import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { temporary } from './helpers.mjs';

const cli = (root, ...args) => spawnSync(process.execPath, [resolve('dist/cli.js'), ...args], { cwd: root, encoding: 'utf8' });

test('migrate-project --write leaves generated output that verify accepts without another generate', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'src/locales'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'app', private: true, type: 'module', dependencies: { vite: '^8', react: '^19', i18next: '^25', 'react-i18next': '^16' } }));
  await writeFile(join(root, 'src/locales/en.json'), JSON.stringify({ welcome: 'Welcome, {{name}}!' }));
  await writeFile(join(root, 'src/locales/fr.json'), JSON.stringify({ welcome: 'Bienvenue, {{name}} !' }));
  await writeFile(join(root, 'src/App.tsx'), "import { useTranslation } from 'react-i18next';\nexport function App() {\n  const { t } = useTranslation();\n  return <h1>{t('welcome', { name: 'Ada' })}</h1>;\n}\n");
  const migrate = cli(root, 'migrate-project', '--from', 'src/locales', '--format', 'react-i18next', '--framework', 'vite-react', '--source-dir', 'src', '--write', '--json');
  assert.equal(migrate.status, 0, migrate.stdout + migrate.stderr);
  const verify = cli(root, 'verify', '--json');
  assert.equal(verify.status, 0, verify.stdout + verify.stderr);
  assert.equal(JSON.parse(verify.stdout).freshness.status, 'fresh');
});
