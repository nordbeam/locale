import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogSchema, configSchema } from '../dist/schema.js';
import { validateConfig } from '../dist/config.js';
import { writeEditorSchemas } from '../dist/cli-tools.js';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('catalog and config schemas are deterministic and editor-friendly', () => {
  const schema = catalogSchema({
    checkout: { pay: 'Pay {amount, number}', title: 'Checkout' }, unused: 'Unused',
  }, 'en');
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.$id, 'https://nordbeam.com/schemas/catalog-en.json');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties), ['checkout', 'unused']);
  assert.equal(schema.properties.checkout.properties.pay.type, 'string');
  assert.equal(schema.properties.checkout.properties.pay.default, 'Pay {amount, number}');
  assert.deepEqual(schema.properties.checkout.properties.pay['x-nordbeam'], {
    id: 'checkout.pay', source: 'Pay {amount, number}', arguments: { amount: { kind: 'number' } },
  });
  assert.deepEqual(catalogSchema({ b: 'B', a: { z: 'Z' } }, 'en').properties, {
    a: { type: 'object', additionalProperties: false, properties: { z: {
      type: 'string', description: 'ICU message "a.z".', default: 'Z', 'x-nordbeam': { id: 'a.z', source: 'Z' },
    } } },
    b: { type: 'string', description: 'ICU message "b".', default: 'B', 'x-nordbeam': { id: 'b', source: 'B' } },
  });
});

test('config validation catches unknown and malformed options while allowing editor schema metadata', () => {
  assert.doesNotThrow(() => validateConfig({
    $schema: './src/i18n/config.schema.json', baseLocale: 'en', catalogs: 'messages', outDir: 'src/i18n',
    missing: 'fallback', development: true, scopes: { checkout: ['checkout.*'], site: { modules: ['src/routes/*.tsx'], exclude: ['src/routeTree.gen.ts'], messages: ['legal.*'] } },
    formats: { number: { money: { style: 'currency', currency: 'EUR' } } },
    cache: { maxMessageCacheBytes: 0 }, persistentCache: false, artifacts: 'loader-typed', includeSources: ['checkout.pay'], shareLiterals: true,
  }, 'config.json'));
  assert.deepEqual(configSchema.properties.artifacts.enum, ['typed', 'runtime', 'loader', 'loader-typed']);
  assert.throws(() => validateConfig({ basLocale: 'en' }, 'config.json'), /unknown option.*basLocale/);
  assert.throws(() => validateConfig({ development: 'yes' }, 'config.json'), /development must be a boolean/);
  assert.throws(() => validateConfig({ shareLiterals: 'yes' }, 'config.json'), /shareLiterals must be a boolean/);
  assert.throws(() => validateConfig({ scopes: { checkout: [] } }, 'config.json'), /scopes\.checkout/);
  assert.throws(() => validateConfig({ scopes: { site: { modules: [] } } }, 'config.json'), /scopes\.site\.modules/);
  assert.throws(() => validateConfig({ scopes: { site: { modules: ['src/a.ts'], files: [] } } }, 'config.json'), /scopes\.site has unknown option "files"/);
  assert.throws(() => validateConfig({ cache: { maxMessageCacheBytes: -1 } }, 'config.json'), /maxMessageCacheBytes/);
});

test('editor schemas can be refreshed locally from the base catalog', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nordbeam-schema-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'messages'));
  await writeFile(join(root, 'messages/en.json'), JSON.stringify({ checkout: { pay: 'Pay {amount}' } }));
  const result = await writeEditorSchemas({ root, baseLocale: 'en', catalogs: 'messages' });
  assert.equal(result.messageCount, 1);
  assert.equal(JSON.parse(await readFile(join(root, '.nordbeam/catalog.schema.json'), 'utf8')).properties.checkout.properties.pay['x-nordbeam'].id, 'checkout.pay');
  assert.equal(JSON.parse(await readFile(join(root, '.nordbeam/config.schema.json'), 'utf8')).additionalProperties, false);
});
