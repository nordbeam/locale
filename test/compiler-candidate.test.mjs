import test from 'node:test';
import assert from 'node:assert/strict';
import { compileProject, createCompiler } from '../dist/compiler.js';

function fixture() {
  const en = {}, fr = {};
  for (let i = 0; i < 600; i++) {
    const id = `m${String(i).padStart(4, '0')}`;
    en[id] = i === 0 ? 'Base {name}' : `Message ${id}`;
    fr[id] = i === 0 ? 'French {name}' : `Français ${id}`;
  }
  return { baseLocale: 'en', catalogs: { en, fr }, scopes: { small: ['m0000', 'm0001', 'm0512'] } };
}

test('localized contract edits reuse unaffected declaration groups and preserve cold output', () => {
  const options = fixture();
  const incremental = createCompiler();
  const first = incremental(options);
  const coldFirst = compileProject(options);
  assert.deepEqual(first, coldFirst);
  assert.ok(Object.entries(first.files).filter(([name]) => name.endsWith('.d.ts')).every(([, source]) => !source.includes(' as "')));

  options.catalogs.en.m0512 = 'Base {name, number}';
  const second = incremental(options);
  const coldSecond = compileProject(options);
  assert.deepEqual(second, coldSecond);
  assert.ok(Object.entries(second.files).filter(([name]) => name.endsWith('.d.ts')).every(([, source]) => !source.includes(' as "')));
  assert.equal(second.files['types/0.d.ts'], first.files['types/0.d.ts']);
  assert.equal(second.files['types/1.d.ts'], first.files['types/1.d.ts']);
  assert.notEqual(second.files['types/2.d.ts'], first.files['types/2.d.ts']);
  assert.equal(second.files['messages.d.ts'], first.files['messages.d.ts']);
  assert.match(second.files['types/2.d.ts'], /readonly "name": number/);

  options.catalogs.en.m0001 = 'Base {count, number}';
  const third = incremental(options);
  const coldThird = compileProject(options);
  assert.deepEqual(third, coldThird);
  assert.ok(Object.entries(third.files).filter(([name]) => name.endsWith('.d.ts')).every(([, source]) => !source.includes(' as "')));
  assert.notEqual(third.files['types/0.d.ts'], second.files['types/0.d.ts']);
  assert.equal(third.files['types/1.d.ts'], second.files['types/1.d.ts']);
  assert.equal(third.files['types/2.d.ts'], second.files['types/2.d.ts']);
  assert.equal(third.files['messages.d.ts'], second.files['messages.d.ts']);
  assert.match(third.files['types/0.d.ts'], /readonly "count": number/);

  // The scope is intentionally one declaration file, so its contract edit is
  // visible there even while unrelated root groups remain byte-identical.
  assert.notEqual(second.files['scopes/small/messages.d.ts'], first.files['scopes/small/messages.d.ts']);
  assert.notEqual(third.files['scopes/small/messages.d.ts'], second.files['scopes/small/messages.d.ts']);
});

test('failed localized edits retain the prior group cache and diagnostics', () => {
  const options = fixture();
  const incremental = createCompiler();
  const before = incremental(options);
  options.catalogs.en.m0512 = 'Broken {name';
  assert.throws(() => incremental(options), /INVALID_ICU/);
  options.catalogs.en.m0512 = 'Base {name, number}';
  const after = incremental(options);
  assert.equal(after.files['types/0.d.ts'], before.files['types/0.d.ts']);
  assert.equal(after.files['types/1.d.ts'], before.files['types/1.d.ts']);
  assert.notEqual(after.files['types/2.d.ts'], before.files['types/2.d.ts']);
  assert.deepEqual(after, compileProject(options));
});
