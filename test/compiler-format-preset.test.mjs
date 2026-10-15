import test from 'node:test';
import assert from 'node:assert/strict';
import { compileProject, CompileError } from '../dist/compiler.js';

test('user format reusing a built-in date preset explains the merge', () => {
  assert.throws(() => compileProject({ baseLocale: 'en', formats: { date: { short: { dateStyle: 'short' } } }, catalogs: { en: { when: '{d, date, short}' } } }),
    error => error instanceof CompileError && error.diagnostics.length === 1
      && error.diagnostics[0].code === 'INVALID_FORMAT'
      && error.diagnostics[0].messageId === 'when'
      && /"short".*merges with the built-in short preset/.test(error.diagnostics[0].message)
      && /such as "shortCustom"/.test(error.diagnostics[0].message));
});

test('user format reusing a built-in time preset explains the merge', () => {
  assert.throws(() => compileProject({ baseLocale: 'en', formats: { time: { medium: { timeStyle: 'short' } } }, catalogs: { en: { at: '{t, time, medium}' } } }),
    error => error instanceof CompileError && error.diagnostics[0].code === 'INVALID_FORMAT'
      && /merges with the built-in medium preset/.test(error.diagnostics[0].message));
});

test('a valid user format reusing a built-in name still merges and compiles', () => {
  assert.doesNotThrow(() => compileProject({ baseLocale: 'en', formats: { date: { short: { year: 'numeric' } } }, catalogs: { en: { when: '{d, date, short}' } } }));
});

test('an invalid format with a fresh name keeps the plain diagnostic', () => {
  assert.throws(() => compileProject({ baseLocale: 'en', formats: { date: { mine: { dateStyle: 'short', year: 'numeric' } } }, catalogs: { en: { when: '{d, date, mine}' } } }),
    error => error instanceof CompileError && error.diagnostics[0].code === 'INVALID_FORMAT'
      && !/merges with the built-in/.test(error.diagnostics[0].message));
});
