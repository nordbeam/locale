import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NORDBEAM_EVENT_PROTOCOL,
  changeEvent,
  createEvent,
  createNdjsonWriter,
  diagnosticEvent,
  finalEvent,
  progressEvent,
  serializeEvent,
  stringifyDeterministically,
  versionEvent,
} from '../dist/ndjson-events.js';

test('constructors produce version-one protocol events', () => {
  assert.deepEqual(versionEvent(), {
    version: 1,
    type: 'version',
    protocol: NORDBEAM_EVENT_PROTOCOL,
    events: ['progress', 'diagnostic', 'change', 'final'],
  });
  assert.equal(progressEvent({ operationId: 'op', completed: 1 }).version, 1);
  assert.equal(diagnosticEvent({ operationId: 'op', message: 'catalog skipped' }).severity, 'info');
  assert.equal(changeEvent({ operationId: 'op', action: 'update', key: 'home.title' }).type, 'change');
  assert.equal(finalEvent({ operationId: 'op', status: 'succeeded' }).status, 'succeeded');
});

test('createEvent maps a callback discriminator to the matching constructor', () => {
  assert.equal(createEvent('progress', { operationId: 'op', completed: 0 }).type, 'progress');
  assert.equal(createEvent('version').type, 'version');
});

test('serialization recursively sorts keys and escapes record newlines', () => {
  const one = stringifyDeterministically({ z: 1, nested: { b: 2, a: 1 }, a: 'x' });
  const two = stringifyDeterministically({ a: 'x', nested: { a: 1, b: 2 }, z: 1 });
  assert.equal(one, two);
  const line = serializeEvent(diagnosticEvent({ operationId: 'op', message: 'line one\nline two' }));
  assert.equal(line.split('\n').length, 2);
  assert.match(line, /line one\\nline two/);
});

test('writer emits exactly one handshake and preserves order under concurrency', async () => {
  const chunks = [];
  const writer = createNdjsonWriter({
    write(chunk) { chunks.push(chunk); return Promise.resolve(); },
  });
  await Promise.all([
    writer.emit(progressEvent({ operationId: 'op', completed: 1, total: 2 })),
    writer.emit(diagnosticEvent({ operationId: 'op', severity: 'warning', message: 'slow' })),
    writer.emit(finalEvent({ operationId: 'op', status: 'succeeded' })),
  ]);
  await writer.flush();
  assert.deepEqual(chunks.map(chunk => JSON.parse(chunk).type), ['version', 'progress', 'diagnostic', 'final']);
});

test('writer can be configured for an already-negotiated sink', async () => {
  const chunks = [];
  const writer = createNdjsonWriter({ write: chunk => chunks.push(chunk) }, { emitVersion: false });
  await writer.write(finalEvent({ operationId: 'op', status: 'cancelled' }));
  assert.equal(chunks.length, 1);
  assert.equal(JSON.parse(chunks[0]).type, 'final');
});

test('writer waits for Node Writable drain backpressure', async () => {
  const chunks = [];
  let releaseDrain;
  const drained = new Promise(resolve => { releaseDrain = resolve; });
  const writer = createNdjsonWriter({
    write(chunk) { chunks.push(chunk); return chunks.length === 1 ? false : true; },
    once(event, listener) { assert.equal(event, 'drain'); void drained.then(listener); },
  });
  const pending = writer.emit(finalEvent({ operationId: 'op', status: 'succeeded' }));
  await Promise.resolve();
  assert.equal(chunks.length, 1);
  releaseDrain();
  await pending;
  assert.equal(chunks.length, 2);
});
