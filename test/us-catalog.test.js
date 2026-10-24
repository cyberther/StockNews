// US shares in the search (2026-10-24): the Cloudflare gateway has no US search (Finnhub is not
// used there), so the apps search the SEC's public list (templates/shared/us-tickers.json,
// tools/update-us-catalog.mjs), read once on the first search, with no gateway call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { catalogRows } from '../tools/update-us-catalog.mjs';

const file = JSON.parse(readFileSync(new URL('../templates/shared/us-tickers.json', import.meta.url), 'utf8'));

test('the SEC file becomes [ticker, name, exchange]: Nasdaq, NYSE and Cboe only, share classes as BRK.B, one row per ticker', () => {
  const rows = catalogRows({ fields: ['cik', 'name', 'ticker', 'exchange'], data: [
    [1, 'Rocket Lab Corp', 'RKLB', 'Nasdaq'], [2, 'BERKSHIRE HATHAWAY INC', 'BRK-B', 'NYSE'], [3, 'Some Pink Co', 'PINKX', 'OTC'],
    [4, 'No Exchange Inc', 'NOEX', null], [5, 'Rocket Lab Corp', 'RKLB', 'Nasdaq'], [6, 'Odd', 'A$B', 'NYSE'], [7, 'Cboe Co', 'CBX', 'CBOE']] });
  assert.deepEqual(rows, [['BRK.B', 'BERKSHIRE HATHAWAY INC', 'NYSE'], ['CBX', 'Cboe Co', 'Cboe'], ['RKLB', 'Rocket Lab Corp', 'Nasdaq']]);
  assert.throws(() => catalogRows({ fields: ['x'], data: [] }), /unexpected SEC file/);
});

test('the committed catalog: thousands of listings, the ones readers asked for, no over-the-counter', () => {
  assert.ok(file.rows.length > 5000, String(file.rows.length));
  assert.match(file.source, /^https:\/\/www\.sec\.gov\//);
  const by = Object.fromEntries(file.rows.map(r => [r[0], r]));
  for (const t of ['ASTS', 'CLS', 'RKLB', 'NVDA', 'BRK.B']) assert.ok(by[t], t);
  assert.ok(file.rows.every(r => ['Nasdaq', 'NYSE', 'Cboe'].includes(r[2]) && /^[A-Z]{1,5}(\.[A-Z])?$/.test(r[0])));
  assert.doesNotMatch(JSON.stringify(file), /@/, 'no contact address in the published file');
});

test('search: the SEC list answers US symbols and names, first by symbol, without calling the gateway', async () => {
  globalThis.window = globalThis;
  globalThis.location = { href: 'https://www.marketpulse.ro/templates/stock-news-web/StockNewsWeb.dc.html', protocol: 'https:' };
  window.HIFFlags = { get: () => undefined };
  const calls = [];
  globalThis.fetch = async url => { calls.push(String(url));
    if (String(url).endsWith('/templates/shared/us-tickers.json')) return new Response(JSON.stringify(file), { status: 200 });
    return new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }); };
  await import('../templates/shared/hif-live.js?us');
  const L = window.HIFLive;
  for (const q of ['ASTS', 'cls', 'RKLB']) assert.equal((await L.search(q, 'token'))[0].ticker, q.toUpperCase(), q);
  assert.ok((await L.search('rocket lab', 'token')).some(r => r.ticker === 'RKLB'));
  assert.equal(calls.filter(u => u.includes('us-tickers.json')).length, 1, 'read once');
  assert.equal(calls.filter(u => u.includes('/api/')).length, 0, 'no gateway call');
  assert.deepEqual(L.usSearch(file.rows, 'BRK.B', 3)[0], { ticker: 'BRK.B', name: 'BERKSHIRE HATHAWAY INC', exchange: 'NYSE' });
});
