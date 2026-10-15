import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { createElement as h } from 'react';
import { registerClientReference, renderToPipeableStream } from 'react-server-dom-webpack/server';
import { rich } from '@nordbeam/locale/react/rich';

const manifest = {};
function clientComponent(name) {
  const id = `file:///app/${name}.js`;
  manifest[`${id}#${name}`] = { id, chunks: [], name };
  return registerClientReference(function () {}, id, name);
}
async function flight(element) {
  const chunks = [], errors = [];
  await new Promise((resolve, reject) => {
    const { pipe } = renderToPipeableStream(element, manifest, {
      onError(error) { errors.push(String(error?.message ?? error).split('\n')[0]); },
    });
    pipe(new Writable({
      write(chunk, _encoding, next) { chunks.push(chunk); next(); },
      final(done) { done(); resolve(); },
    })).on('error', reject);
  });
  return { payload: Buffer.concat(chunks).toString(), errors };
}

function welcome({ name, strong }) { return ['Hello ', strong([name]), '!']; }
async function ServerPage() {
  return h('main', null, rich(welcome, {
    name: 'Ada',
    strong: children => h('strong', null, children),
  }));
}

const server = await flight(h(ServerPage));
assert.deepEqual(server.errors, []);
assert.match(server.payload, /Hello /);
assert.match(server.payload, /Ada/);

const Provider = clientComponent('Provider');
const messages = Object.assign(Object.create(null), { welcome });
const invalid = await flight(h(Provider, { initial: { locale: 'en', messages } }));
assert.ok(invalid.errors.length > 0, 'Flight must reject function-valued loaded catalogs');

const LocaleProvider = clientComponent('LocaleProvider');
const compatible = await flight(h(LocaleProvider, { locale: 'en' }, h('p', null, 'child')));
assert.deepEqual(compatible.errors, []);
assert.match(compatible.payload, /LocaleProvider/);

console.log(JSON.stringify({
  serverRich: { ok: true, bytes: server.payload.length },
  loadedCatalogRejected: { ok: true, error: invalid.errors[0] },
  localeOnlyProvider: { ok: true, bytes: compatible.payload.length },
}));
