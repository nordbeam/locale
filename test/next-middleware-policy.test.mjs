import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server.js';
import { createNextMiddleware } from '../dist/next-middleware.js';

const request = (path, init = {}) => new NextRequest(`http://localhost${path}`, init);
const target = response => response.headers.get('location') ?? response.headers.get('x-middleware-rewrite');
const negotiated = (middleware, acceptLanguage) => target(middleware(request('/', { headers: { 'accept-language': acceptLanguage } })));

const chinese = createNextMiddleware({
  locales: ['en-US', 'en-GB', 'zh-CN', 'zh-TW'],
  defaultLocale: 'en-US',
  localePrefix: 'always',
});

test('Accept-Language negotiation matches script and region before falling back to language', () => {
  const cases = [
    ['zh-Hant', 'http://localhost/zh-TW'],
    ['zh-HK', 'http://localhost/zh-TW'],
    ['zh-TW', 'http://localhost/zh-TW'],
    ['zh-Hans', 'http://localhost/zh-CN'],
    ['zh', 'http://localhost/zh-CN'],
    ['zh-SG', 'http://localhost/zh-CN'],
    ['en-AU', 'http://localhost/en-US'],
    ['en-gb', 'http://localhost/en-GB'],
    ['EN-GB;q=0.8, zh-TW;q=0.9', 'http://localhost/zh-TW'],
    ['de, zh-TW;q=0.5', 'http://localhost/zh-TW'],
    ['de, fr;q=0.9', 'http://localhost/en-US'],
    ['zz-ZZ, *;q=0.1', 'http://localhost/en-US'],
    ['bad_tag, en-GB;q=0.5', 'http://localhost/en-GB'],
  ];
  for (const [header, expected] of cases) assert.equal(negotiated(chinese, header), expected, header);
});

test('Accept-Language drops invalid quality values and q=0 entries', () => {
  const cases = [
    ['zh-TW;q=1.5, en-GB;q=0.5', 'http://localhost/en-GB'],
    ['zh-TW;q=-1, en-GB;q=0.5', 'http://localhost/en-GB'],
    ['zh-TW;q=abc, en-GB;q=0.5', 'http://localhost/en-GB'],
    ['zh-TW;q=0, en-GB;q=0.5', 'http://localhost/en-GB'],
    ['zh-TW;q=0.5, en-GB;q=0.5', 'http://localhost/zh-TW'],
    ['en-GB;q=0.7, zh-TW;q=0.9', 'http://localhost/zh-TW'],
  ];
  for (const [header, expected] of cases) assert.equal(negotiated(chinese, header), expected, header);
});

test('Accept-Language with no supported match falls back to the default locale', () => {
  assert.equal(negotiated(chinese, 'de-DE, ja;q=0.5'), 'http://localhost/en-US');
  assert.equal(negotiated(chinese, '*;q=0.5, zh-TW;q=0.1'), 'http://localhost/en-US');
});

test('case-variant locale prefixes redirect to the canonical prefix and keep the query', () => {
  const middleware = createNextMiddleware({ locales: ['en', 'fr'], defaultLocale: 'en', localePrefix: 'always' });
  const response = middleware(request('/EN/about?tab=team'));
  assert.equal(response.status, 307);
  assert.equal(response.headers.get('location'), 'http://localhost/en/about?tab=team');
  const french = middleware(request('/Fr'));
  assert.equal(french.headers.get('location'), 'http://localhost/fr');
  assert.equal(middleware(request('/en/about')).status, 200);
});

test('encoded path segments are not decoded a second time', () => {
  const middleware = createNextMiddleware({ locales: ['en', 'fr'], defaultLocale: 'en', localePrefix: 'always' });
  assert.equal(target(middleware(request('/%2541'))), 'http://localhost/en/%2541');
  assert.equal(middleware(request('/en/%2541')).status, 200);
  assert.equal(middleware(request('/en/a%2Fb?x=%25')).status, 200);
  assert.equal(target(middleware(request('/%2541?x=%25'))), 'http://localhost/en/%2541?x=%25');
});

test('spoofed locale headers are overwritten on every rewrite and on the malformed-path path', () => {
  const middleware = createNextMiddleware({ locales: ['en', 'fr'], defaultLocale: 'en', localePrefix: 'always' });
  const spoofed = { 'x-nordbeam-locale': '../../etc/passwd' };
  const rewritten = middleware(request('/en/about', { headers: spoofed }));
  assert.equal(rewritten.headers.get('x-middleware-request-x-nordbeam-locale'), 'en');
  const malformed = middleware(request('/%E0%A4%A/x', { headers: spoofed }));
  assert.equal(malformed.status, 200);
  assert.equal(malformed.headers.get('x-middleware-request-x-nordbeam-locale'), '');
  assert.match(malformed.headers.get('x-middleware-override-headers') ?? '', /x-nordbeam-locale/);
});

test('locale cookies default to one year, Secure on https, and user options override', () => {
  const middleware = createNextMiddleware({ locales: ['en', 'fr'], defaultLocale: 'en', localePrefix: 'always' });
  const plain = middleware(request('/fr'));
  assert.match(plain.headers.get('set-cookie') ?? '', /NEXT_LOCALE=fr; Path=\/; Expires=[^;]+; Max-Age=31536000; SameSite=lax/);
  assert.doesNotMatch(plain.headers.get('set-cookie') ?? '', /Secure/);

  const secure = middleware(new NextRequest('https://example.com/fr'));
  assert.match(secure.headers.get('set-cookie') ?? '', /Max-Age=31536000/);
  assert.match(secure.headers.get('set-cookie') ?? '', /; Secure/);

  const custom = createNextMiddleware({ locales: ['en', 'fr'], defaultLocale: 'en', localePrefix: 'always', localeCookie: { maxAge: 60, secure: false } });
  const overridden = custom(new NextRequest('https://example.com/fr'));
  assert.match(overridden.headers.get('set-cookie') ?? '', /Max-Age=60/);
  assert.doesNotMatch(overridden.headers.get('set-cookie') ?? '', /Secure/);
});
