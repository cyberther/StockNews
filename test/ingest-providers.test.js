import test from 'node:test';
import assert from 'node:assert/strict';
import { LICENSES, NotConfigured, providersFor } from '../ingest/providers/index.mjs';
import { createYahoo } from '../ingest/providers/yahoo.mjs';
import { eodhd, twelvedata, bvb } from '../ingest/providers/stubs.mjs';

const fakeClient = (rows, summary) => {
  const calls = { quote: [], summary: [] };
  return { calls, quote: async (symbols, opts) => { calls.quote.push(symbols); return rows.filter(r => symbols.includes(r.symbol)); },
    quoteSummary: async (sym, opts) => { calls.summary.push([sym, opts]); return summary(sym); } };
};
const row = (symbol, price, extra) => Object.assign({ symbol, regularMarketPrice: price, regularMarketChange: 0.5, regularMarketChangePercent: 1.25,
  regularMarketPreviousClose: price - 0.5, currency: 'USD', regularMarketTime: new Date('2026-10-20T13:45:00Z') }, extra);

test('licences', () => assert.deepEqual(LICENSES, ['dev_only', 'commercial_display', 'redistribution']));

test('yahoo is dev_only and maps a batch to the quotes table shape', async () => {
  const client = fakeClient([row('AAPL', 230.1), row('SNP.RO', 0.712, { currency: 'RON' }), row('PZC.L', 99.4, { currency: 'GBX' }), row('BRK-B', 470)]);
  const y = createYahoo({ client });
  assert.equal(y.license, 'dev_only');
  assert.equal(y.configured, true);
  const out = await y.quotes(['AAPL', 'SNP.RO', 'PZC.L', 'BRK.B']);
  assert.deepEqual(client.calls.quote, [['AAPL', 'SNP.RO', 'PZC.L', 'BRK-B']]);
  const by = Object.fromEntries(out.map(q => [q.symbol, q]));
  assert.deepEqual(by.AAPL, { symbol: 'AAPL', price: 230.1, change: 0.5, change_pct: 1.25, prev_close: 229.6, currency: 'USD',
    market_time: '2026-10-20T13:45:00.000Z', source: 'yahoo', license: 'dev_only' });
  assert.equal(by['SNP.RO'].currency, 'RON');
  assert.equal(by['PZC.L'].currency, 'GBp');   // London stays in pence, as in the apps
  assert.equal(by['BRK.B'].price, 470);        // back to the apps' spelling
});

test('yahoo asks for 120 symbols in 3 requests of at most 50, and drops rows without a price', async () => {
  const syms = Array.from({ length: 120 }, (_, i) => 'S' + i);
  const client = fakeClient(syms.map((s, i) => row(s, i === 0 ? null : 10)));
  const out = await createYahoo({ client }).quotes(syms);
  assert.deepEqual(client.calls.quote.map(c => c.length), [50, 50, 20]);
  assert.equal(out.length, 119);
});

test('yahoo recommendation: counts from the latest period, or null when there are none', async () => {
  const client = fakeClient([], sym => sym === 'AAPL'
    ? { recommendationTrend: { trend: [{ period: '0m', strongBuy: 5, buy: 20, hold: 10, sell: 2, strongSell: 1 }, { period: '-1m', strongBuy: 1 }] } }
    : { recommendationTrend: { trend: [{ period: '0m', strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0 }] } });
  const y = createYahoo({ client });
  assert.deepEqual(await y.recommendation('AAPL'), { symbol: 'AAPL', status: 'ok', buy: 25, hold: 10, sell: 3, period: '0m', source: 'yahoo', license: 'dev_only' });
  assert.equal(await y.recommendation('MSFT'), null);
  assert.deepEqual(client.calls.summary[0], ['AAPL', { modules: ['recommendationTrend'] }]);
});

test('licensed providers are prepared but not configured, and say so', async () => {
  assert.equal(eodhd.license, 'commercial_display');
  assert.equal(twelvedata.license, 'commercial_display');
  assert.equal(bvb.license, 'redistribution');
  for (const p of [eodhd, twelvedata, bvb]) {
    assert.equal(p.configured, false);
    await assert.rejects(p.quotes(['SNP.RO']), NotConfigured);
  }
});

test('providersFor: configured providers for a capability; commercial mode drops dev_only ones', () => {
  const y = createYahoo({ client: fakeClient([]) });
  const licensed = { name: 'lic', license: 'commercial_display', configured: true, supports: c => c === 'quotes' };
  const all = [y, eodhd, licensed];
  assert.deepEqual(providersFor('quotes', { providers: all }).map(p => p.name), ['yahoo', 'lic']);
  assert.deepEqual(providersFor('quotes', { providers: all, commercialMode: true }).map(p => p.name), ['lic']);
  assert.deepEqual(providersFor('recommendation', { providers: all }).map(p => p.name), ['yahoo']);
});
