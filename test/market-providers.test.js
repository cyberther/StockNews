import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMarketRequest, resetGatewayForTests, orderFromEnv } from '../netlify/functions/_shared/market/gateway.js';

const originalFetch = globalThis.fetch;
const req = q => new Request('http://localhost:8080/api/finnhub?' + q);
const J = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const keys = { finnhub: 'fk', twelvedata: 'tk', fmp: 'mk', alphavantage: 'ak' };
// Routes fake upstream calls by host; each handler gets the URL.
function upstream(routes) {
  const seen = [];
  globalThis.fetch = async url => {
    const u = new URL(url), host = u.hostname.split('.').slice(-2, -1)[0];
    seen.push(host + u.pathname);
    const h = routes[host];
    if (!h) throw new Error('unexpected ' + u.hostname);
    return h(u);
  };
  return seen;
}
test.beforeEach(() => resetGatewayForTests());
test.afterEach(() => { globalThis.fetch = originalFetch; });

test('quote fails over Finnhub 429 -> Twelve Data, in Finnhub shape', async () => {
  upstream({
    finnhub: () => J({ error: 'limit' }, 429),
    twelvedata: u => { assert.equal(u.searchParams.get('apikey'), 'tk'); return J({ symbol: 'NVDA', close: '190.5', change: '2.5', percent_change: '1.33', high: '191', low: '187', open: '188', previous_close: '188', timestamp: 1791820700 }); }
  });
  const r = await handleMarketRequest(req('path=/quote&symbol=NVDA'), { keys });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-market-source'), 'twelvedata');
  assert.deepEqual(await r.json(), { c: 190.5, d: 2.5, dp: 1.33, h: 191, l: 187, o: 188, pc: 188, t: 1791820700 });
});

test('errors inside a 200 reply count as errors: Twelve Data code 429, then FMP answers', async () => {
  const seen = upstream({
    finnhub: () => J({}, 502),
    twelvedata: () => J({ status: 'error', code: 429, message: 'You have run out of API credits' }),
    financialmodelingprep: () => J([{ symbol: 'AAPL', price: 331.85, changePercentage: -1.87, change: -6.33, dayLow: 329.6, dayHigh: 334.5, open: 333.1, previousClose: 338.2, timestamp: 1785430812 }])
  });
  const r = await handleMarketRequest(req('path=/quote&symbol=AAPL'), { keys });
  assert.equal(r.headers.get('x-market-source'), 'fmp');
  assert.equal((await r.json()).c, 331.85);
  assert.deepEqual(seen, ['finnhub/api/v1/quote', 'twelvedata/quote', 'financialmodelingprep/stable/quote']);
});

test('Alpha Vantage over quota (a Note in a 200) is treated as rate limited', async () => {
  upstream({ finnhub: () => J({}, 500), alphavantage: () => J({ Note: 'Thank you for using Alpha Vantage! Our standard API rate limit is 25 requests per day.' }) });
  const r = await handleMarketRequest(req('path=/quote&symbol=IBM'), { keys: { finnhub: 'fk', alphavantage: 'ak' } });
  assert.equal(r.status, 429);
});

test('an empty Finnhub profile lets FMP fill it in', async () => {
  upstream({
    finnhub: () => J({}),
    financialmodelingprep: () => J([{ symbol: 'SPY', companyName: 'SPDR S&P 500 ETF Trust', currency: 'USD', exchange: 'AMEX', exchangeFullName: 'New York Stock Exchange Arca', industry: 'Asset Management', image: 'https://img/SPY.png', defaultImage: false }])
  });
  const r = await handleMarketRequest(req('path=/stock/profile2&symbol=SPY'), { keys });
  assert.equal(r.headers.get('x-market-source'), 'fmp');
  const body = await r.json();
  assert.equal(body.name, 'SPDR S&P 500 ETF Trust');
  assert.equal(body.currency, 'USD');
});

test('if no provider has a profile, the empty answer stands and is cached', async () => {
  const seen = upstream({ finnhub: () => J({}), financialmodelingprep: () => J([]), alphavantage: () => J({}) });
  const a = await handleMarketRequest(req('path=/stock/profile2&symbol=ZZZZ'), { keys });
  assert.equal(a.status, 200);
  assert.deepEqual(await a.json(), {});
  await handleMarketRequest(req('path=/stock/profile2&symbol=ZZZZ'), { keys });
  assert.equal(seen.length, 3);
});

test('an empty Finnhub quote (unknown symbol) is kept, not passed to the backups', async () => {
  const seen = upstream({ finnhub: () => J({ c: 0, d: null, dp: null }) });
  const r = await handleMarketRequest(req('path=/quote&symbol=NOPE'), { keys });
  assert.equal(r.headers.get('x-market-source'), 'finnhub');
  assert.equal(seen.length, 1);
});

test('chart falls back to Twelve Data, converted to the Yahoo shape the app reads', async () => {
  upstream({
    yahoo: () => J({}, 503),
    twelvedata: u => {
      assert.equal(u.searchParams.get('interval'), '5min');
      assert.equal(u.searchParams.get('timezone'), 'UTC');
      return J({ meta: { symbol: 'NVDA', interval: '5min', currency: 'USD', exchange_timezone: 'America/New_York' },
        values: [{ datetime: '2026-10-12 19:55:00', open: '2', high: '2', low: '2', close: '2', volume: '10' },
                 { datetime: '2026-10-12 19:50:00', open: '1', high: '1', low: '1', close: '1', volume: '5' }], status: 'ok' });
    }
  });
  const r = await handleMarketRequest(req('path=/chart&symbol=NVDA&range=1d'), { keys });
  assert.equal(r.headers.get('x-market-source'), 'twelvedata');
  const res = (await r.json()).chart.result[0];
  assert.deepEqual(res.indicators.quote[0].close, [1, 2]);
  assert.equal(res.timestamp[1] - res.timestamp[0], 300);
  assert.equal(res.timestamp[1], Date.parse('2026-10-12T19:55:00Z') / 1000);
  assert.ok(res.meta.gmtoffset === -14400 || res.meta.gmtoffset === -18000);
});

test('an earnings calendar without past results is enriched with FMP history', async () => {
  upstream({
    finnhub: () => J({ earningsCalendar: [{ date: '2026-11-19', epsActual: null, epsEstimate: 1.2, hour: 'amc', quarter: 3, year: 2027, symbol: 'NVDA' }] }),
    financialmodelingprep: () => J([
      { symbol: 'NVDA', date: '2026-08-27', epsActual: 1.05, epsEstimated: 1.01 },
      { symbol: 'NVDA', date: '2026-11-19', epsActual: null, epsEstimated: 1.2 },
      { symbol: 'NVDA', date: '2023-01-01', epsActual: 0.5, epsEstimated: 0.4 }
    ])
  });
  const r = await handleMarketRequest(req('path=/calendar/earnings&symbol=NVDA&from=2026-04-01&to=2027-04-01'), { keys });
  const rows = (await r.json()).earningsCalendar;
  assert.deepEqual(rows.map(x => x.date).sort(), ['2026-08-27', '2026-11-19']);
  assert.equal(rows.find(x => x.date === '2026-08-27').epsActual, 1.05);
  assert.equal(r.headers.get('x-market-source'), 'finnhub,fmp');
});

test('MARKET_ORDER_* reorders providers and ignores unknown or unsupported names', () => {
  const o = orderFromEnv({ MARKET_ORDER_CHART: 'twelvedata, yahoo', MARKET_ORDER_QUOTE: 'nope,fmp', MARKET_ORDER_NEWS: 'fmp' });
  assert.deepEqual(o.chart.map(p => p.name), ['twelvedata', 'yahoo']);
  assert.deepEqual(o.quote.map(p => p.name), ['fmp']);
  assert.equal(o.news, undefined);
});

test('unconfigured backups do not hide the real failure', async () => {
  upstream({ finnhub: () => J({ error: 'limit' }, 429) });
  const r = await handleMarketRequest(req('path=/quote&symbol=NVDA'), { keys: { finnhub: 'fk' } });
  assert.equal(r.status, 429);
});

test('provider keys never appear in replies or logs', async () => {
  const logs = [];
  upstream({ finnhub: () => J({}, 500), twelvedata: () => J({ close: '1', percent_change: '0' }) });
  const r = await handleMarketRequest(req('path=/quote&symbol=NVDA'), { keys: { finnhub: 'fk-secret', twelvedata: 'td-secret' }, log: e => logs.push(JSON.stringify(e)) });
  const text = JSON.stringify([...r.headers]) + await r.text() + logs.join('');
  assert.equal(/fk-secret|td-secret/.test(text), false);
});

test('candles for the live chart: compact arrays, gaps dropped, bar sizes checked', async () => {
  const { compactCandles } = await import('../netlify/functions/_shared/market/providers/yahoo.js');
  const { handleMarketRequest, resetGatewayForTests } = await import('../netlify/functions/_shared/market/gateway.js');
  const yahooChart = { chart: { result: [{ meta: { currency: 'USD', exchangeTimezoneName: 'America/New_York', regularMarketPrice: 181.2, chartPreviousClose: 180 },
    timestamp: [100, 160, 220], indicators: { quote: [{ open: [1, null, 3], high: [2, null, 4], low: [0.5, null, 2.5], close: [1.5, null, 3.5], volume: [10, null, 30] }] } }] } };
  const c = compactCandles(yahooChart);
  assert.deepEqual([c.t, c.o, c.c, c.v], [[100, 220], [1, 3], [1.5, 3.5], [10, 30]]);
  assert.equal(c.tz, 'America/New_York');
  resetGatewayForTests();
  const orig = globalThis.fetch;
  let asked = '';
  globalThis.fetch = async url => { asked = String(url); return Response.json(yahooChart); };
  try {
    const r = await handleMarketRequest(new Request('http://localhost/api/finnhub?path=/candles&symbol=NVDA&interval=1m&tail=1'), { log: () => {} });
    assert.equal(r.status, 200);
    assert.match(asked, /interval=1m/); assert.match(asked, /range=1d/);
    assert.equal(r.headers.get('cache-control'), 'public, max-age=5');
    const bad = await handleMarketRequest(new Request('http://localhost/api/finnhub?path=/candles&symbol=NVDA&interval=3s'), { log: () => {} });
    assert.equal(bad.status, 400);
  } finally { globalThis.fetch = orig; resetGatewayForTests(); }
});

test('candles: bars in an old unit dropped, a late day added, weeks grouped into months', async () => {
  const { compactCandles } = await import('../netlify/functions/_shared/market/providers/yahoo.js');
  const chart = (meta, t, c) => ({ chart: { result: [{ meta, timestamp: t, indicators: { quote: [{ open: c, high: c.map(x => x * 1.01), low: c.map(x => x * 0.99), close: c, volume: c.map(() => 5) }] } }] } });
  const old = compactCandles(chart({ dataGranularity: '1mo' }, [1, 2, 3, 4], [400, 410, 1.2, 1.3]), '1mo');
  assert.deepEqual(old.c, [1.2, 1.3]);
  const turn = compactCandles({ chart: { result: [{ meta: {}, timestamp: [1, 2], indicators: { quote: [{ open: [3729, 0.39], high: [3729, 0.4], low: [0.37, 0.38], close: [0.384, 0.39], volume: [1, 1] }] } }] } });
  assert.deepEqual([turn.o[0], turn.h[0], turn.l[0]], [0.384, 0.384, 0.37]);
  const day = 86400, t0 = 20000 * day + 7 * 3600;
  const late = compactCandles(chart({ dataGranularity: '1d', regularMarketPrice: 1.305, regularMarketTime: t0 + day + 5 * 3600, regularMarketDayHigh: 1.31, regularMarketDayLow: 1.25, gmtoffset: 10800 },
    [t0 - day, t0], [1.24, 1.258]), '1d');
  assert.deepEqual(late.t, [t0 - day, t0, t0 + day]);
  assert.deepEqual([late.o[2], late.h[2], late.l[2], late.c[2]], [1.258, 1.31, 1.25, 1.305]);
  const jan = Date.UTC(2026, 0, 5) / 1000, feb = Date.UTC(2026, 1, 2) / 1000;
  const m = compactCandles(chart({ dataGranularity: '1wk' }, [jan, jan + 7 * day, jan + 14 * day, feb], [10, 12, 11, 13]), '1mo');
  assert.deepEqual(m.t, [jan, feb]);
  assert.deepEqual(m.c, [11, 13]);
  assert.equal(m.v[0], 15);
});

test('a US share class goes to Yahoo with a dash (BRK.B -> BRK-B); London and Frankfurt symbols unchanged', async () => {
  const { yahoo } = await import('../netlify/functions/_shared/market/providers/yahoo.js');
  assert.match(String(yahoo.url('quote', { symbol: 'BRK.B' })), /\/chart\/BRK-B\?/);
  assert.match(String(yahoo.url('quote', { symbol: 'PZC.L' })), /\/chart\/PZC\.L\?/);
  assert.match(String(yahoo.url('quote', { symbol: 'BMW.DE' })), /\/chart\/BMW\.DE\?/);
});
