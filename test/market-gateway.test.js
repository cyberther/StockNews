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
  assert.equal(gatewayStatus().providers.finnhub.open, true);
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
