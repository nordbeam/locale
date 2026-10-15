import test from 'node:test';
import assert from 'node:assert/strict';
import { CompileError, compileProject, createCompiler } from '../dist/compiler.js';

test('incremental runtime groups survive no-ops, scopes, fallback, failure, and artifact transitions', () => {
  const catalogs = {
    en: {
      hello: 'Hello {name}',
      checkout: { total: 'Total {amount, number}' },
    },
    fr: {
      hello: 'Bonjour {name}',
      checkout: { total: 'Total {amount, number}' },
    },
  };
  const options = {
    baseLocale: 'en',
    catalogs,
    scopes: { checkout: ['checkout.*', 'hello'] },
  };
  const compiler = createCompiler();

  // Crossing typed/runtime output modes must keep the same ordered IDs and JS.
  const typed = compiler(options);
  const runtime = compiler({ ...options, artifacts: 'runtime' });
  assert.deepEqual(
    Object.fromEntries(Object.entries(runtime.files).filter(([name]) => name.endsWith('.js'))),
    Object.fromEntries(Object.entries(typed.files).filter(([name]) => name.endsWith('.js'))),
  );
  const expectedGroups = {
    'index.js': ['checkout.total', 'hello'],
    'scopes/checkout/index.js': ['checkout.total', 'hello'],
  };
  const copiedGroups = result => Object.fromEntries(Object.entries(result.groups));
  assert.deepEqual(copiedGroups(runtime), expectedGroups);

  // The public result is a defensive copy; mutating it cannot poison a later
  // compiler session or change the private ordered-ID table.
  runtime.groups['index.js'].push('caller mutation');
  runtime.groups['scopes/checkout/index.js'].length = 0;
  const noop = compiler({ ...options, artifacts: 'runtime' });
  assert.deepEqual(copiedGroups(noop), expectedGroups);
  assert.deepEqual(noop.files, runtime.files);

  // Removing or renaming a scope must also remove its private group entry;
  // otherwise a long-lived editor session would retain old scope state.
  options.scopes = { account: ['hello'] };
  const renamedScope = compiler({ ...options, artifacts: 'runtime' });
  assert.deepEqual(copiedGroups(renamedScope), {
    'index.js': ['checkout.total', 'hello'],
    'scopes/account/index.js': ['hello'],
  });
  assert.equal(renamedScope.groups['scopes/checkout/index.js'], undefined);
  options.scopes = { checkout: ['checkout.*', 'hello'] };

  catalogs.fr.hello = 'Salut {name}';
  const textEdit = compiler({ ...options, artifacts: 'runtime' });
  assert.notEqual(textEdit.files['locales/fr.js'], runtime.files['locales/fr.js']);
  assert.deepEqual(copiedGroups(textEdit), expectedGroups);

  // Sparse translations still use the base message and formatting locale.
  delete catalogs.fr.hello;
  const fallback = compiler({ ...options, artifacts: 'runtime' });
  const freshFallback = compileProject({ ...options, artifacts: 'runtime' });
  assert.equal(fallback.files['locales/fr.js'], freshFallback.files['locales/fr.js']);
  assert.equal(fallback.warnings.length, 1);
  assert.deepEqual(copiedGroups(fallback), expectedGroups);

  // A failed attempt must not replace the last committed parsed/schema state.
  catalogs.fr.hello = 'Salut {other}';
  assert.throws(
    () => compiler({ ...options, artifacts: 'runtime' }),
    error => error instanceof CompileError && error.diagnostics.some(diagnostic => diagnostic.code === 'UNKNOWN_ARGUMENT'),
  );
  catalogs.fr.hello = 'Salut {name}';
  const recovered = compiler({ ...options, artifacts: 'runtime' });
  const freshRecovered = compileProject({ ...options, artifacts: 'runtime' });
  assert.equal(recovered.files['locales/fr.js'], freshRecovered.files['locales/fr.js']);
  assert.deepEqual(copiedGroups(recovered), expectedGroups);

  // Runtime to typed transitions continue to produce declarations and retain
  // the same generated JavaScript after the incremental edits above.
  const typedAgain = compiler(options);
  assert.ok(Object.keys(typedAgain.files).some(name => name.endsWith('.d.ts')));
  assert.deepEqual(
    Object.fromEntries(Object.entries(typedAgain.files).filter(([name]) => name.endsWith('.js'))),
    Object.fromEntries(Object.entries(recovered.files).filter(([name]) => name.endsWith('.js'))),
  );
});
