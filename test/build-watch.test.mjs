import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm, unlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { CatalogWatch } from '../dist/build-watch.js';
import { waitFor } from './helpers.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'nordbeam-i18n-')), input = join(root, 'messages');
  const warnings = [];
  let bridge;
  t.after(async () => {
    try { await bridge?.close(); assert.deepEqual(warnings, []); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  await mkdir(input);
  await writeFile(join(input, 'en.json'), '{"hello":"Hello"}');
  bridge = await CatalogWatch.create(input, error => warnings.push(error));
  // Record delivery at the callback boundary. The production queue may have
  // consumed a notification before a delayed test continuation inspects it.
  const notifications = new Map(), received = [], changed = bridge.changed.bind(bridge);
  bridge.changed = (kind, name) => {
    received.push({ kind, name });
    changed(kind, name);
    const event = bridge.events.get(name);
    if (event) notifications.set(name, event);
  };
  // fs.watch has no ready event; macOS may miss an immediate first write.
  // Confirm actual delivery before exercising the bridge state machine.
  const ready = join(input, 'watch-ready');
  await writeFile(ready, 'ready');
  await waitFor(async () => {
    if (received.some(event => event.name === 'watch-ready' || event.name === null)) return true;
    await writeFile(ready, 'ready');
    return false;
  }, 'Native watcher did not begin delivering events');
  await unlink(ready);
  await bridge.start(); bridge.finish();
  return { input, bridge, marker: () => readFile(bridge.marker, 'utf8'), event: name => notifications.get(name),
    queued: async (name, previous) => {
      try {
        await waitFor(() => {
          const event = notifications.get(name);
          return event !== undefined && event !== previous;
        }, `No filesystem notification for ${name}`);
      } catch (error) {
        error.message += `; received=${JSON.stringify(received)}; marker=${await readFile(bridge.marker, 'utf8')}`;
        throw error;
      }
    } };
}

test('a failed attempt acknowledges its inputs without a duplicate bridge rebuild', async t => {
  const { input, bridge, marker, queued } = await fixture(t);
  await writeFile(join(input, 'de.json'), '{"hello":"{broken"}');
  await queued('de.json');
  const files = await bridge.start();
  await bridge.pending;
  const before = await marker();
  assert.ok(files.includes(join(input, 'de.json')));
  assert.equal(await readFile(join(input, 'de.json'), 'utf8'), '{"hello":"{broken"}');
  bridge.finish(); // Compilation failed; these inputs were still observed.
  await delay(160);
  assert.equal(await marker(), before);
  await bridge.close();
  await assert.rejects(access(bridge.marker), { code: 'ENOENT' });
});

test('changes to new inputs during an attempt still trigger recovery after failure', async t => {
  const { input, bridge, marker, queued, event } = await fixture(t);
  const file = join(input, 'de.json');
  await writeFile(file, '{"hello":"{broken"}'); await queued('de.json');
  const files = await bridge.start(); assert.ok(files.includes(file));
  await bridge.pending;
  const before = await marker();
  assert.equal(await readFile(file, 'utf8'), '{"hello":"{broken"}');
  const prior = event('de.json');
  await writeFile(file, '{"hello":"Repaired"}'); await queued('de.json', prior);
  bridge.finish();
  await waitFor(async () => await marker() !== before, 'The repair during compilation was lost');
  assert.equal(await readFile(file, 'utf8'), '{"hello":"Repaired"}');
  // A catalog first appearing after the attempted snapshot must also wake it.
  await bridge.start();
  const next = await marker();
  await writeFile(join(input, 'it.json'), '{"hello":"Ciao"}'); await queued('it.json');
  bridge.finish();
  await waitFor(async () => await marker() !== next, 'The locale added during compilation was lost');
});

test('a queued directory scan cannot publish an obsolete wakeup after a newer attempt', async t => {
  const { input, bridge, marker } = await fixture(t);
  const original = bridge.names.bind(bridge);
  let release, entered, timeout;
  const waiting = new Promise((resolve, reject) => {
    entered = resolve;
    timeout = setTimeout(() => reject(new Error('The fallback directory scan did not start')), 5000);
  });
  const gate = new Promise(resolve => { release = resolve; });
  let intercept = true;
  bridge.names = async () => {
    if (intercept) { intercept = false; entered(); await gate; }
    return original();
  };
  try {
    await writeFile(join(input, 'de.json'), '{"hello":"Hallo"}');
    // Drive this controlled I/O race at the notification boundary. Native
    // delivery/coalescing is covered separately by the real watch tests.
    bridge.changed('rename', 'de.json');
    await waiting; // The fallback timer has begun its asynchronous directory read.
    const before = await marker();
    const files = await bridge.start(); assert.ok(files.includes(join(input, 'de.json')));
    bridge.finish();
    release();
    await bridge.pending;
    assert.equal(await marker(), before);
  } finally { release(); clearTimeout(timeout); }
});

test('delayed notifications for known files distinguish an unread edit from handled input', async t => {
  const { input, bridge, marker } = await fixture(t);
  const file = join(input, 'en.json');
  for (const event of ['rename', 'change']) {
    await bridge.start();
    assert.match(await readFile(file, 'utf8'), /hello/);
    const before = await marker();
    if (event === 'rename') {
      const temporary = join(input, 'en.tmp');
      await writeFile(temporary, '{"hello":"Replaced"}'); await rename(temporary, file);
    } else await writeFile(file, '{"hello":"Edited again"}');
    bridge.finish();
    // Deliver after finish, when this filename is already known. This also
    // exercises ordinary changes without depending on native event spelling.
    bridge.changed(event, 'en.json');
    await waitFor(async () => await marker() !== before, `Lost delayed ${event}`);
    await bridge.start(); bridge.finish(); await bridge.pending;
    const handled = await marker();
    bridge.changed(event, 'en.json');
    await delay(160); await bridge.pending;
    assert.equal(await marker(), handled, `Repeated ${event} rebuilt handled input`);
  }
});

test('a fingerprint scan cannot publish a wakeup after a newer attempt handles the file', async t => {
  const { input, bridge, marker } = await fixture(t);
  await writeFile(join(input, 'en.json'), '{"hello":"Updated"}');
  const original = bridge.snapshot.bind(bridge);
  let release, entered, timeout;
  const waiting = new Promise((resolve, reject) => {
    entered = resolve;
    timeout = setTimeout(() => reject(new Error('The fingerprint scan did not start')), 5000);
  });
  const gate = new Promise(resolve => { release = resolve; });
  let intercept = true;
  bridge.snapshot = async names => {
    const state = await original(names);
    if (intercept) { intercept = false; entered(); await gate; }
    return state;
  };
  try {
    bridge.changed('change', 'en.json'); await waiting;
    const before = await marker();
    await bridge.start(); bridge.finish();
    release(); await bridge.pending;
    assert.equal(await marker(), before);
  } finally { release(); clearTimeout(timeout); }
});
