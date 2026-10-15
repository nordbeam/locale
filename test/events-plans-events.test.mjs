import assert from 'node:assert/strict';
import test from 'node:test';
import { CompileError } from '../dist/diagnostics.js';
import { diagnosticEvent, diagnosticEventFrom, finalErrorFrom, finalEvent, serializeEvent } from '../dist/ndjson-events.js';

const root = '/work/app';

test('diagnosticEventFrom carries file-relative location, message identity and hint', () => {
  const event = diagnosticEventFrom({
    code: 'EXPECT_ARGUMENT_CLOSING_BRACE',
    message: 'Expected a closing brace.',
    file: '/work/app/src/locales/en.json',
    location: { line: 4, column: 9, offset: 61 },
    line: 1,
    column: 3,
    locale: 'en',
    messageId: 'cart.total',
    hint: 'Close the argument with }.',
  }, { operationId: 'op', severity: 'error', root });
  assert.deepEqual(event, {
    version: 1,
    type: 'diagnostic',
    operationId: 'op',
    severity: 'error',
    message: 'Expected a closing brace.',
    code: 'EXPECT_ARGUMENT_CLOSING_BRACE',
    file: 'src/locales/en.json',
    line: 4,
    column: 9,
    messageId: 'cart.total',
    locale: 'en',
    hint: 'Close the argument with }.',
  });
});

test('a diagnostic without a file reports its ICU message position and keeps the absolute file when no root is known', () => {
  const messageOnly = diagnosticEventFrom({ code: 'EMPTY_ARGUMENT', message: 'An argument has no name.', line: 2, column: 5 }, { operationId: 'op', severity: 'error' });
  assert.equal(messageOnly.line, 2);
  assert.equal(messageOnly.column, 5);
  assert.equal(messageOnly.file, undefined);
  assert.equal(messageOnly.path, undefined);

  const noRoot = diagnosticEventFrom({ code: 'X', message: 'x', file: '/work/app/en.json' }, { operationId: 'op' });
  assert.equal(noRoot.file, '/work/app/en.json');
  assert.equal(noRoot.severity, 'info');
});

test('a file outside the known root keeps its path rather than a misleading relative one', () => {
  const event = diagnosticEventFrom({ code: 'X', message: 'x', file: '/elsewhere/en.json' }, { operationId: 'op', root });
  assert.equal(event.file, '/elsewhere/en.json');
});

test('a file-based diagnostic without a location does not borrow the message position', () => {
  const event = diagnosticEventFrom({ code: 'X', message: 'x', file: '/work/app/en.json', line: 3, column: 2 }, { operationId: 'op', root });
  assert.equal(event.line, undefined);
  assert.equal(event.column, undefined);
});

test('diagnosticEvent accepts the new location fields and rejects invalid positions', () => {
  const event = diagnosticEvent({ operationId: 'op', message: 'm', file: 'a.json', line: 1, column: 1, messageId: 'id', locale: 'fr', hint: 'h' });
  assert.equal(event.file, 'a.json');
  assert.equal(event.line, 1);
  assert.throws(() => diagnosticEvent({ operationId: 'op', message: 'm', line: 0 }), TypeError);
  assert.throws(() => diagnosticEvent({ operationId: 'op', message: 'm', column: 1.5 }), TypeError);
});

test('existing diagnostic fields keep their names when serialized', () => {
  const line = serializeEvent(diagnosticEventFrom({ code: 'C', message: 'm', file: '/work/app/a.json' }, { operationId: 'op', root }));
  const parsed = JSON.parse(line);
  assert.deepEqual(Object.keys(parsed), Object.keys(parsed).slice().sort());
  // With a root, the project-relative file replaces the absolute path.
  assert.equal(parsed.path, undefined);
  assert.equal(parsed.file, 'a.json');
});

test('a final failure from a CompileError keeps the first diagnostic code', () => {
  const error = new CompileError([
    { code: 'INVALID_NUMBER_SKELETON', message: 'bad skeleton', locale: 'en' },
    { code: 'EMPTY_ARGUMENT', message: 'second' },
  ]);
  assert.deepEqual(finalErrorFrom(error, 'CLI_ERROR'), { code: 'INVALID_NUMBER_SKELETON', message: error.message });
  const event = finalEvent({ operationId: 'op', status: 'failed', error });
  assert.deepEqual(event.error, { code: 'INVALID_NUMBER_SKELETON', message: error.message });
});

test('finalErrorFrom falls back to the supplied code for other errors', () => {
  assert.deepEqual(finalErrorFrom(new Error('boom'), 'CLI_ERROR'), { code: 'CLI_ERROR', message: 'boom' });
  assert.deepEqual(finalErrorFrom('plain', undefined), { message: 'plain' });
  assert.deepEqual(finalErrorFrom(new CompileError([]), 'CLI_ERROR'), { code: 'CLI_ERROR', message: '' });
});

test('an explicit final error code is kept for non-compile errors', () => {
  const event = finalEvent({ operationId: 'op', status: 'failed', error: { code: 'STALE_PLAN', message: 'changed' } });
  assert.deepEqual(event.error, { code: 'STALE_PLAN', message: 'changed' });
});
