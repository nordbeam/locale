import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./next-middleware-hooks.mjs', import.meta.url));
const { getDomain } = await import('../dist/next-server.js');

const withHeader = value => { globalThis.__nordbeamRequestHeaders = new Headers(value === undefined ? {} : { 'x-nordbeam-domain': value }); };
const routing = { domains: [{ domain: 'Example.de' }, { domain: 'localhost:3001' }] };

test('getDomain with the routing returns only a configured domain, in lowercase', async () => {
  const cases = [
    [undefined, undefined],
    ['', undefined],
    ['example.de', 'example.de'],
    ['EXAMPLE.DE', 'example.de'],
    ['localhost:3001', 'localhost:3001'],
    ['localhost:3000', undefined],
    ['evil.test', undefined],
    ['example.de.evil.test', undefined],
  ];
  for (const [value, expected] of cases) {
    withHeader(value);
    assert.equal(await getDomain(routing), expected, `routing, header ${JSON.stringify(value)}`);
  }
});

test('getDomain without a routing accepts only a host-shaped value', async () => {
  const cases = [
    ['example.de', 'example.de'],
    ['localhost:3001', 'localhost:3001'],
    ['../../etc/passwd', undefined],
    ['example.de/path', undefined],
    [undefined, undefined],
  ];
  for (const [value, expected] of cases) {
    withHeader(value);
    assert.equal(await getDomain(), expected, `no routing, header ${JSON.stringify(value)}`);
  }
});
