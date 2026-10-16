import test from 'node:test';
import assert from 'node:assert/strict';
import { checkProject, compareContract, compileProject, describeCatalog, describeMessageContract, locateDiagnostics, updateCatalogText } from '../dist/compiler.js';
import { configSchema } from '../dist/schema.js';
import { resolveKeyPolicy, validateConfig } from '../dist/config.js';
import { mergePo, serializePo } from '../dist/translations.js';

test('describeCatalog returns stable per-message contracts and hashes', () => {
  const catalogs = {
    en: {
      greeting: 'Hello {name}',
      count: '{n, plural, one {# item} other {# items}}',
      choice: '{kind, select, short {Short} other {Long}}',
      rich: '<strong>{name}</strong>',
    },
    fr: { greeting: 'Bonjour {name}' },
  };
  const result = describeCatalog({ baseLocale: 'en', catalogs });
  assert.deepEqual(result.locales, ['en', 'fr']);
  assert.equal(result.messages.length, 5);
  assert.equal(result.contracts.greeting.arguments.name.kind, 'value');
  assert.deepEqual(result.contracts.count.branches[0].choices, ['one', 'other']);
  assert.deepEqual(result.contracts.choice.arguments.kind.choices, ['short']);
  assert.deepEqual(result.contracts.rich.slots, ['strong']);
  assert.match(result.contracts.greeting.hash, /^fnv1a64-[0-9a-f]{16}$/);
  assert.ok(Object.isFrozen(result.messages[0]));
  assert.ok(Object.isFrozen(result.contracts.greeting));
  const reordered = describeCatalog({ baseLocale: 'en', catalogs: { fr: catalogs.fr, en: catalogs.en } });
  assert.equal(reordered.hash, result.hash);
  assert.equal(reordered.contracts.count.hash, result.contracts.count.hash);
});

test('compareContract reports missing arguments, branches and slot mismatches', () => {
  const missing = compareContract('{n, plural, one {# item} other {# items}}', '{n, plural, other {# items}}', { id: 'count' });
  assert.ok(missing.some(diagnostic => diagnostic.code === 'MISSING_PLURAL_BRANCH' && diagnostic.branch === 'one'));
  const slots = compareContract('<strong>{name}</strong>', '{name}', { id: 'rich' });
  assert.ok(slots.some(diagnostic => diagnostic.code === 'DROPPED_RICH_TAG' && diagnostic.severity === 'warning' && diagnostic.tags.includes('strong')));
  const mismatch = compareContract('<strong>text</strong>', '{strong}', { id: 'rich' });
  assert.ok(mismatch.some(diagnostic => diagnostic.code === 'SLOT_MISMATCH'));
  const extra = compareContract('{name}', '{name} {count}', { id: 'greeting' });
  assert.ok(extra.some(diagnostic => diagnostic.code === 'UNKNOWN_ARGUMENT' && diagnostic.argument === 'count'));
});

test('compareContract accepts parsed contracts in the positional overload', () => {
  const source = describeMessageContract('{name}', 'greeting');
  const translation = describeMessageContract('Bonjour {name}', 'greeting');
  assert.deepEqual(compareContract(source, translation), []);
  assert.deepEqual(compareContract({ source, translation }), []);
});

test('locateDiagnostics maps in-memory JSON source locations', () => {
  const text = '{\n  "nested": {\n    "greeting": "Bonjour {name}"\n  }\n}\n';
  const [diagnostic] = locateDiagnostics([{
    code: 'INVALID_ICU', locale: 'fr', messageId: 'nested.greeting', source: 'Bonjour {name}', offset: 8,
  }], new Map([['fr', { file: 'messages/fr.json', text }]]));
  assert.equal(diagnostic.file, 'messages/fr.json');
  assert.equal(diagnostic.location.line, 3);
  assert.equal(diagnostic.location.column, 26);
  assert.match(diagnostic.frame, /3 \|/);
});

test('updateCatalogText changes only selected JSON values and preserves layout', () => {
  const text = '{\r\n\t"greeting": "Hello",\r\n\t"nested": { "value": "Keep" }\r\n}\r\n';
  const updated = updateCatalogText(text, new Map([['greeting', 'Bonjour'], ['nested.value', 'Changed']]));
  assert.equal(updated, '{\r\n\t"greeting": "Bonjour",\r\n\t"nested": { "value": "Changed" }\r\n}\r\n');
  assert.equal(updateCatalogText(text, { greeting: 'Hello' }), text);
  assert.throws(() => updateCatalogText(text, { missing: 'Nope' }), /UNKNOWN_MESSAGE/);
});

test('pure PO transport round-trips catalogs without filesystem access', () => {
  const options = { baseLocale: 'en', locale: 'fr', catalogs: { en: { greeting: 'Hello {name}', keep: 'Keep' }, fr: { greeting: 'Bonjour {name}', keep: 'Garder' } } };
  const exported = serializePo(options);
  assert.equal(exported.messageCount, 2);
  assert.equal(exported.translatedCount, 2);
  const changed = exported.po.replace('Bonjour {name}', 'Salut {name}');
  const merged = mergePo({ ...options, po: changed });
  assert.equal(merged.catalog.greeting, 'Salut {name}');
  assert.deepEqual(options.catalogs.fr, { greeting: 'Bonjour {name}', keep: 'Garder' });
  assert.deepEqual(mergePo({ ...options, po: exported.po }).added, []);
});

test('pure PO merge rejects cyclic in-memory catalogs without overflowing the stack', () => {
  const cyclic = Object.create(null);
  cyclic.self = cyclic;
  const po = serializePo({ baseLocale: 'en', locale: 'fr', catalogs: { en: { greeting: 'Hello' }, fr: {} } }).po;
  assert.throws(
    () => mergePo({ baseLocale: 'en', locale: 'fr', catalogs: { en: { greeting: 'Hello' }, fr: cyclic }, po }),
    error => error?.diagnostics?.[0]?.code === 'INVALID_CATALOG',
  );
});

test('lock and ignore key policy validates patterns and resolves decisions', () => {
  validateConfig({ baseLocale: 'en', lockedKeys: ['checkout.*'], ignoredKeys: ['metadata'] });
  assert.equal(configSchema.properties.lockedKeys.type, 'array');
  assert.equal(configSchema.properties.lockedKeys.items.pattern, '^(?:[^*]+|[^*]+\\.\\*)$');
  assert.deepEqual(resolveKeyPolicy('checkout.total', { lockedKeys: ['checkout.*'] }), { id: 'checkout.total', decision: 'locked', pattern: 'checkout.*' });
  assert.equal(resolveKeyPolicy('metadata', { ignoredKeys: ['metadata'] }).decision, 'ignored');
  assert.equal(resolveKeyPolicy('other', { lockedKeys: ['checkout.*'], ignoredKeys: ['metadata'] }).decision, 'translate');
  assert.throws(() => resolveKeyPolicy('checkout.total', { lockedKeys: ['checkout.*'], ignoredKeys: ['checkout.total'] }), /overlap/);
  assert.throws(() => validateConfig({ lockedKeys: ['checkout*'] }), /lockedKeys/);
  assert.throws(() => validateConfig({ lockedKeys: ['checkout.*'], ignoredKeys: ['checkout.total'] }), /overlap/);
});

test('direct compiler entry points reject malformed and ambiguous key policies', () => {
  const options = { baseLocale: 'en', catalogs: { en: { greeting: 'Hello' } } };
  assert.equal(checkProject({ ...options, lockedKeys: [] }).ok, true);
  assert.throws(() => checkProject({ ...options, lockedKeys: ['greeting*'] }), /compiler options: lockedKeys/);
  assert.throws(() => compileProject({ ...options, lockedKeys: ['checkout.*'], ignoredKeys: ['checkout.total'] }), /overlap/);
});
