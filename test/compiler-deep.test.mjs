import test from 'node:test';
import assert from 'node:assert/strict';
import { compileProject, CompileError } from '../dist/compiler.js';

const nestedSelect = depth => {
  let source = 'x';
  for (let i = 0; i < depth; i++) source = `{g, select, a {${source}} other {y}}`;
  return source;
};
const nestedTags = depth => {
  let source = 'x';
  for (let i = 0; i < depth; i++) source = `<b>${source}</b>`;
  return source;
};
const tooDeep = (options, id) => error => error instanceof CompileError
  && error.diagnostics.length === 1
  && error.diagnostics[0].code === 'MESSAGE_TOO_DEEP'
  && error.diagnostics[0].messageId === id
  && error.diagnostics[0].locale === 'en'
  && /flatten nested select\/plural branches/i.test(error.diagnostics[0].hint ?? '');

for (const development of [false, true]) {
  test(`deeply nested select reports MESSAGE_TOO_DEEP (development: ${development})`, () => {
    assert.throws(() => compileProject({ baseLocale: 'en', development, catalogs: { en: { deep: nestedSelect(1500) } } }),
      tooDeep(undefined, 'deep'));
  });

  test(`deeply nested tags report MESSAGE_TOO_DEEP instead of a raw RangeError (development: ${development})`, () => {
    assert.throws(() => compileProject({ baseLocale: 'en', development, catalogs: { en: { deep: nestedTags(5000) } } }),
      tooDeep(undefined, 'deep'));
  });
}

test('moderately nested select still compiles', () => {
  assert.doesNotThrow(() => compileProject({ baseLocale: 'en', catalogs: { en: { deep: nestedSelect(50) } } }));
});
