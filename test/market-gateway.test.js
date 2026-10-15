import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMarketRequest, resetGatewayForTests, gatewayStatus } from '../netlify/functions/_shared/market/gateway.js';

const originalFetch = globalThis.fetch;
const req = query => new Request('http://localhost:8080/api/finnhub?' + query);
const ok = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
test.beforeEach(() => resetGatewayForTests());
test.afterEach(() => { globalThis.fetch = originalFetch; });

test('answers many quotes in one request, each cached on its own', async () => {
  const seen = [];
  globalThis.fetch = async url => { seen.push(url.searchParams.get('symbol')); return ok({ c: seen.length, dp: 1 }); };
  const opts = { apiKey: 'secret' };
  const r = await handleMarketRequest(req('path=/quotes&symbols=nvda,AAPL,nvda'), opts);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(Object.keys(body.quotes).sort(), ['AAPL', 'NVDA']);
  assert.equal(seen.length, 2);
  // A single-symbol request after the batch is served from the same cache.
  const single = await handleMarketRequest(req('path=/quote&symbol=AAPL'), opts);
  assert.equal(single.headers.get('x-market-cache'), 'hit');
  assert.equal(seen.length, 2);
});

test('a batch with an unknown-to-upstream symbol returns null for it and is not CDN-cached', async () => {
  globalThis.fetch = async url => url.searchParams.get('symbol') === 'BAD' ? new Response('{}', { status: 502 }) : ok({ c: 5 });
  const r = await handleMarketRequest(req('path=/quotes&symbols=GOOD,BAD'), { apiKey: 'secret' });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).quotes, { BAD: null, GOOD: { c: 5 } });
  assert.equal(r.headers.get('netlify-cdn-cache-control'), null);
});

test('rejects oversized or malformed batches', async () => {
  const many = Array.from({ length: 51 }, (_, i) => 'T' + i).join(',');
  assert.equal((await handleMarketRequest(req('path=/quotes&symbols=' + many), { apiKey: 'k' })).status, 400);
  assert.equal((await handleMarketRequest(req('path=/quotes&symbols=A%26token%3Dx'), { apiKey: 'k' })).status, 400);
});

test('identical requests in flight share one upstream call', async () => {
  let calls = 0, release;
  const gate = new Promise(r => { release = r; });
  globalThis.fetch = async () => { calls++; await gate; return ok({ c: 1 }); };
  const a = handleMarketRequest(req('path=/quote&symbol=NVDA'), { apiKey: 'k' });
  const b = handleMarketRequest(req('path=/quote&symbol=NVDA'), { apiKey: 'k' });
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(calls, 1);
  assert.deepEqual([ra.headers.get('x-market-cache'), rb.headers.get('x-market-cache')].sort(), ['coalesced', 'miss']);
});

test('a 429 cools the provider down instead of calling it again', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('{"error":"limit"}', { status: 429, headers: { 'retry-after': '20' } }); };
  assert.equal((await handleMarketRequest(req('path=/quote&symbol=NVDA'), { apiKey: 'k' })).status, 429);
  assert.equal((await handleMarketRequest(req('path=/quote&symbol=AAPL'), { apiKey: 'k' })).status, 429);
  assert.equal(calls, 1);
  assert.equal(gatewayStatus().providers.finnhub.breaker.open, true);
  assert.equal(gatewayStatus().providers.finnhub.thisInstance.rate_limited, 1);
});

test('serves the last good answer, marked stale, when the provider fails', async () => {
  const realNow = Date.now;
  try {
    globalThis.fetch = async () => ok({ c: 42 });
    await handleMarketRequest(req('path=/quote&symbol=NVDA'), { apiKey: 'k' });
    Date.now = () => realNow() + 60_000; // past the 30s quote TTL
    globalThis.fetch = async () => { throw new Error('down'); };
    const r = await handleMarketRequest(req('path=/quote&symbol=NVDA'), { apiKey: 'k' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-market-cache'), 'stale');
    assert.deepEqual(await r.json(), { c: 42 });
  } finally { Date.now = realNow; }
});

test('successful answers carry CDN caching keyed on the query; errors are not cached', async () => {
  globalThis.fetch = async () => ok({ name: 'NVIDIA Corp' });
  const r = await handleMarketRequest(req('path=/stock/profile2&symbol=NVDA'), { apiKey: 'k' });
  assert.match(r.headers.get('netlify-cdn-cache-control'), /durable, max-age=86400/);
  assert.match(r.headers.get('netlify-vary'), /query=path\|symbol\|symbols/);
  const bad = await handleMarketRequest(req('path=/quote&symbol=%24%24'), { apiKey: 'k' });
  assert.equal(bad.status, 400);
  assert.equal(bad.headers.get('netlify-cdn-cache-control'), null);
});

test('chart keeps the warm-up range and needs no key', async () => {
  let target;
  globalThis.fetch = async url => { target = url; return ok({ chart: { result: [] } }); };
  const r = await handleMarketRequest(req('path=/chart&symbol=NVDA&range=1mo&warm=1'));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-market-source'), 'yahoo');
  assert.equal(target.searchParams.get('range'), '3mo');
  assert.equal(target.searchParams.get('interval'), '60m');
});

test('earnings honours a smaller limit; the key never appears in replies or logs', async () => {
  let target;
  const logs = [];
  globalThis.fetch = async url => { target = url; return ok([{ period: '2026-06-30' }]); };
  const r = await handleMarketRequest(req('path=/stock/earnings&symbol=NVDA&limit=4'), { apiKey: 'sekret-key', log: e => logs.push(JSON.stringify(e)) });
  assert.equal(target.searchParams.get('limit'), '4');
  const text = JSON.stringify([...r.headers]) + (await r.text()) + logs.join('');
  assert.equal(text.includes('sekret-key'), false);
  assert.equal(logs.length, 1);
});

test('paces a provider under its per-minute limit on this instance', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return ok({ c: 1 }); };
  const results = [];
  for (let i = 0; i < 60; i++) results.push((await handleMarketRequest(req('path=/quote&symbol=S' + i), { apiKey: 'k' })).status);
  assert.equal(calls, 54); // 90% of Finnhub's 60 a minute
  assert.equal(results.filter(s => s === 429).length, 6);
});

test('counts go to the shared store in batches, and come back if the store fails', async () => {
  globalThis.fetch = async () => ok({ c: 1 });
  const sent = [];
  let fail = true;
  const usage = { bump: async rows => { if (fail) throw new Error('down'); sent.push(...rows); }, read: async () => [] };
  for (let i = 0; i < 25; i++) await handleMarketRequest(req('path=/quote&symbol=T' + i), { apiKey: 'k', usage });
  // The 25th call triggered a flush that failed; the counts were kept for the next one.
  fail = false;
  const { flushUsage } = await import('../netlify/functions/_shared/market/gateway.js');
  await flushUsage(usage);
  assert.deepEqual(sent, [{ provider: 'finnhub', calls: 25, rate_limited: 0, errors: 0 }]);
});

test('a provider over its daily cap is skipped, using the shared count', async () => {
  const { finnhub } = await import('../netlify/functions/_shared/market/providers/finnhub.js');
  const saved = finnhub.limits;
  finnhub.limits = { perDay: 100 };
  try {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return ok({ c: 1 }); };
    const day = new Date().toISOString().slice(0, 10);
    const usage = { bump: async () => {}, read: async () => [{ provider: 'finnhub', day, calls: 95 }] };
    const r = await handleMarketRequest(req('path=/quote&symbol=NVDA'), { apiKey: 'k', usage });
    assert.equal(r.status, 429);
    assert.deepEqual(await r.json(), { error: 'daily quota reached' });
    assert.equal(calls, 0);
  } finally { finnhub.limits = saved; }
});

test('health endpoint: hidden without a token, refuses a wrong one, never shows keys', async () => {
  const env = { ...process.env };
  try {
    process.env.FINNHUB_KEY = 'finnhub-secret-value';
    delete process.env.HEALTH_TOKEN;
    const mod = await import('../netlify/functions/market-health.js?a');
    assert.equal((await mod.default(new Request('http://x/api/market/health'))).status, 404);
    process.env.HEALTH_TOKEN = 'h'.repeat(40);
    const wrong = await mod.default(new Request('http://x/api/market/health', { headers: { authorization: 'Bearer nope' } }));
    assert.equal(wrong.status, 401);
    const good = await mod.default(new Request('http://x/api/market/health', { headers: { authorization: 'Bearer ' + 'h'.repeat(40) } }));
    assert.equal(good.status, 200);
    const text = await good.text();
    assert.equal(text.includes('finnhub-secret-value'), false);
    const body = JSON.parse(text);
    const conf = Object.fromEntries(body.providers.map(p => [p.name, p.configured]));
    assert.equal(conf.finnhub, true);
    assert.equal(conf.yahoo, true);
  } finally { process.env = env; }
});

test('cache misses that spend quota need a signed-in user; RSS news and landing quotes do not', async () => {
  const { handleMarketRequest: h, resetGatewayForTests: reset, publicRequest } = await import('../netlify/functions/_shared/market/gateway.js');
  reset();
  const seen = [];
  // good: an approved account; waiting: signed up, not approved yet.
  const authFetch = async (url, init) => {
    const tok = init.headers.authorization.replace('Bearer ', '');
    if (String(url).includes('/auth/v1/user')) {
      seen.push(init.headers.authorization);
      return tok === 'good' || tok === 'waiting' ? Response.json({ id: tok + '-id' }) : new Response('{}', { status: 401 });
    }
    return Response.json([{ approved: tok === 'good', suspended: false }]);
  };
  const auth = { supabaseUrl: 'https://x.supabase.co', anonKey: 'anon', fetch: authFetch };
  const q = (s, hdr) => new Request('http://localhost:8080/api/finnhub?' + s, { headers: hdr || {} });
  const opts = { keys: {}, log: () => {}, auth };
  assert.equal((await h(q('path=/stock/recommendation&symbol=NVDA'), opts)).status, 401);
  assert.equal((await h(q('path=/stock/recommendation&symbol=NVDA', { 'x-hif-auth': 'bad' }), opts)).status, 401);
  assert.notEqual((await h(q('path=/stock/recommendation&symbol=NVDA', { 'x-hif-auth': 'good' }), opts)).status, 401);
  assert.notEqual((await h(q('path=/stock/recommendation&symbol=AAPL', { 'x-hif-auth': 'good' }), opts)).status, 401);
  assert.equal(seen.filter(x => x === 'Bearer good').length, 1, 'a good token is checked once, then remembered');
  // An account that waits for the owner's approval gets nothing that costs quota.
  const waiting = await h(q('path=/stock/recommendation&symbol=NVDA', { 'x-hif-auth': 'waiting' }), opts);
  assert.equal(waiting.status, 403);
  assert.equal((await waiting.json()).error, 'account awaiting approval');
  assert.equal(publicRequest('marketNewsRO', {}), true);
  assert.equal(publicRequest('news', { symbol: 'SNP.RO' }), true);
  assert.equal(publicRequest('news', { symbol: 'NVDA' }), false);
  assert.equal(publicRequest('quotes', { symbols: ['AAPL', 'NVDA'] }), true);
  assert.equal(publicRequest('quotes', { symbols: ['AAPL', 'GME'] }), false);
  assert.equal(publicRequest('quotes', { symbols: ['GME'] }, 'GME,AMC'), true);
  assert.equal(publicRequest('chart', { symbol: 'NVDA' }), false);
  reset();
});
