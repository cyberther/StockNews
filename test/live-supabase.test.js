// templates/shared/hif-live.js reading market data from Supabase (flags dataSource:
// 'supabase'): a fixed number of requests per refresh, whatever the number of symbols, and
// no request at all where there is nothing to get.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis;
const flags = { dataSource: 'supabase' };
window.HIFFlags = { get: k => flags[k] };
const restCalls = [], fetchCalls = [];
let restReply = () => ({ ok: true, status: 200, body: [] });
window.HIFAuth = { ready: Promise.resolve(), enabled: () => true, session: () => ({}), token: async () => 't',
  rest: async (path) => { restCalls.push(path); return restReply(path); } };
let fetchReply = () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url) => { fetchCalls.push(String(url)); return fetchReply(String(url)); };
await import('../templates/shared/hif-markets.js');
await import('../templates/shared/hif-live.js');
const L = window.HIFLive;
const reset = () => { restCalls.length = 0; fetchCalls.length = 0; L.clearCache(); };

const SYMS = ['AAPL', 'ASTS', 'BMW.DE', 'BVB.RO', 'EOSE', 'FLY', 'OKLO', 'SNG.RO', 'SNP.RO', 'VRT'];

test('load() for 10 symbols: 3 Supabase requests (quotes, stories, recommendations), no gateway call', async () => {
  reset();
  restReply = path => {
    if (path.startsWith('market_quotes')) return { ok: true, body: [{ symbol: 'AAPL', price: 230.1, change: 1.1, change_pct: 0.48, prev_close: 229, currency: 'USD',
      market_time: '2026-10-20T13:45:00Z', fetched_at: '2026-10-20T13:52:00Z', source: 'yahoo' }, { symbol: 'PZC.L', price: 99.4, change_pct: -1, currency: 'GBp', market_time: '2026-10-20T13:45:00Z', fetched_at: '2026-10-20T13:52:00Z' }] };
    if (path.startsWith('stories')) return { ok: true, body: [{ id: 'AAPL:abc', ticker: 'AAPL', headline: 'Apple news', source: 'CNBC', url: 'https://cnbc.com/a', summary: 'x', published_at: '2026-10-20T12:00:00Z' }] };
    if (path.startsWith('market_recommendations')) return { ok: true, body: [{ symbol: 'AAPL', status: 'ok', buy: 25, hold: 10, sell: 3, period: '0m' }] };
    return { ok: false, body: null };
  };
  const res = await L.load(SYMS, '');
  assert.equal(restCalls.length, 3);
  assert.equal(fetchCalls.length, 0);
  assert.equal(res.mode, 'supabase');
  assert.match(restCalls[0], /^market_quotes\?select=.*&symbol=in\.\(/);
  assert.ok(decodeURIComponent(restCalls[0]).includes('"SNP.RO"'));
  // Recommendations are asked for the US symbols only.
  const recPath = decodeURIComponent(restCalls.find(p => p.startsWith('market_recommendations')));
  assert.ok(recPath.includes('"AAPL"') && !recPath.includes('BMW.DE') && !recPath.includes('SNP.RO'));
  const q = res.quotes.AAPL;
  assert.equal(q.price, '230.10');
  assert.equal(q.move, '+0.5%');
  assert.equal(q.up, true);
  assert.equal(q.last, 230.1);
  assert.equal(q.asOf, Date.parse('2026-10-20T13:45:00Z'));
  assert.deepEqual(res.news.AAPL.map(n => [n.id, n.related, n.headline]), [['abc', 'AAPL', 'Apple news']]);
  assert.deepEqual(res.recs.AAPL, { buyPct: '66%', detail: '25 / 10 / 3', period: '0m' });
  // The second time stories and recommendations come from the adapter's cache; only the
  // symbols still without a price are asked again, in one request.
  await L.load(SYMS, '');
  assert.equal(restCalls.length, 4);
  assert.ok(!decodeURIComponent(restCalls[3]).includes('"AAPL"'));
});

test('BMW.DE has no analyst data source: no request is made for its recommendation', async () => {
  reset();
  assert.equal(await L.recommendation('BMW.DE', ''), null);
  assert.equal(await L.recommendation('SNP.RO', ''), null);
  assert.equal(restCalls.length + fetchCalls.length, 0);
});

test('the BVB tab reads the Bucharest stories from Supabase in one request', async () => {
  reset();
  restReply = () => ({ ok: true, body: [{ id: 'SNP.RO:x1', ticker: 'SNP.RO', headline: 'Petrom', source: 'ZF', url: 'https://zf.ro/1', summary: '', published_at: '2026-10-20T09:00:00Z' }] });
  const rows = await L.roNews();
  assert.equal(restCalls.length, 1);
  assert.match(restCalls[0], /^stories\?.*ticker=like\.\*\.RO/);
  assert.deepEqual(rows.map(r => [r.id, r.related]), [['x1', 'SNP.RO']]);
});

test('a failed Supabase read is an error, not a call to the gateway', async () => {
  reset();
  restReply = () => ({ ok: false, status: 500, body: null });
  const out = await L.quotes(['AAPL'], '');
  assert.deepEqual(out, {});
  assert.equal(fetchCalls.length, 0);
});

test('gateway mode: a failed recommendation is remembered for 24 hours', async () => {
  reset();
  flags.dataSource = 'gateway';
  try {
    // The gateway is there (a quote answers), then the analysts call fails.
    fetchReply = url => url.includes('/quote&') || url.includes('path=%2Fquote&')
      ? new Response(JSON.stringify({ c: 10, dp: 1 }), { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response(JSON.stringify({ error: 'market data unavailable' }), { status: 502, headers: { 'content-type': 'application/json' } });
    assert.ok(await L.quote('AAPL', ''));
    const before = fetchCalls.length;
    assert.equal(await L.recommendation('AAPL', ''), null);
    assert.equal(fetchCalls.length, before + 1);
    assert.equal(await L.recommendation('AAPL', ''), null);
    assert.equal(fetchCalls.length, before + 1);
  } finally { flags.dataSource = 'supabase'; }
});

test('before the saved sign-in is restored, a request waits for it and still goes to Supabase', async () => {
  reset();
  const real = window.HIFAuth;
  let open;
  const ready = new Promise(r => { open = r; });
  let enabled = false;
  window.HIFAuth = { ...real, ready, enabled: () => enabled };
  restReply = () => ({ ok: true, body: [{ symbol: 'OKLO', price: 80, change_pct: 2, currency: 'USD', name: 'Oklo Inc.', market_time: '2026-10-20T13:45:00Z', fetched_at: '2026-10-20T13:52:00Z' }] });
  try {
    const p = L.quotes(['OKLO'], '');
    await new Promise(r => setTimeout(r, 20));
    assert.equal(fetchCalls.length + restCalls.length, 0);
    enabled = true; open();
    const q = (await p).OKLO;
    assert.equal(fetchCalls.length, 0);
    assert.equal(restCalls.length, 1);
    assert.equal(q.name, 'Oklo Inc.');
    assert.equal(q.currency, 'USD');
  } finally { window.HIFAuth = real; }
});

test('Supabase not set up at all (demo): the gateway is used as before', async () => {
  reset();
  const real = window.HIFAuth;
  window.HIFAuth = { ...real, ready: Promise.resolve(), enabled: () => false };
  fetchReply = () => new Response(JSON.stringify({ quotes: { AAPL: { c: 5, dp: 1 } } }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const out = await L.quotes(['AAPL'], '');
    assert.equal(restCalls.length, 0);
    assert.equal(fetchCalls.length, 1);
    assert.equal(out.AAPL.price, '5.000');
  } finally { window.HIFAuth = real; }
});

test('a ticker nobody follows (no row in market_quotes): its quote comes from the gateway, then from its chart', async () => {
  reset();
  restReply = () => ({ ok: true, body: [] });
  // /quote fails (no US quote provider on Cloudflare), /chart answers with Yahoo's meta.
  fetchReply = url => url.includes('path=%2Fquote&') ? new Response('{"error":"market data is not configured"}', { status: 503 })
    : url.includes('path=%2Fchart') ? Response.json({ chart: { result: [{ meta: { currency: 'USD', symbol: 'AAPL', regularMarketPrice: 252.3, chartPreviousClose: 250, regularMarketTime: 1792267200 }, timestamp: [1792267200], indicators: { quote: [{ close: [252.3] }] } }] } })
    : new Response('{}', { status: 404 });
  const q = await L.quote('AAPL', '');
  assert.ok(q, 'a quote');
  assert.equal(q.last, 252.3);
  assert.equal(q.dp, 0.92);
  assert.equal(q.price, '252.30');
  assert.equal(q.up, true);
  assert.equal(q.asOf, 1792267200 * 1000);
  // Supabase first, then the gateway: one request each way at most.
  assert.equal(restCalls.length, 1);
  assert.ok(fetchCalls.some(u => u.includes('path=%2Fquote&')) && fetchCalls.some(u => u.includes('path=%2Fchart')));
  // A followed ticker with a row never goes to the gateway.
  reset();
  restReply = () => ({ ok: true, body: [{ symbol: 'SNP.RO', price: 1.31, change_pct: 0.4, currency: 'RON', market_time: '2026-10-19T08:00:00Z', fetched_at: '2026-10-19T08:16:00Z' }] });
  assert.equal((await L.quote('SNP.RO', '')).last, 1.31);
  assert.equal(fetchCalls.length, 0);
  fetchReply = () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
});
