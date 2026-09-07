import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMarketRequest, resetProxyStateForTests } from '../netlify/functions/_shared/market-proxy.js';

const originalFetch = globalThis.fetch;
function request(query, options = {}) { return new Request('http://localhost:8080/api/finnhub?' + query, options); }
test.beforeEach(() => resetProxyStateForTests());
test.afterEach(() => { globalThis.fetch = originalFetch; });

test('rejects unsupported methods', async () => {
  assert.equal((await handleMarketRequest(request('path=/quote&symbol=NVDA', { method:'POST' }))).status, 405);
});

test('rejects invalid symbols before contacting an upstream', async () => {
  globalThis.fetch = () => { throw new Error('must not run'); };
  const response = await handleMarketRequest(request('path=/quote&symbol=NVDA%26token%3Dstolen'), { apiKey:'secret' });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error:'invalid symbol' });
});

test('requires a configured key for Finnhub endpoints', async () => {
  assert.equal((await handleMarketRequest(request('path=/search&q=apple'))).status, 503);
});

test('rejects cross-origin browser calls', async () => {
  const response = await handleMarketRequest(request('path=/quote&symbol=NVDA', { headers:{ origin:'https://attacker.example' } }), { apiKey:'secret' });
  assert.equal(response.status, 403);
});

test('forwards only validated fields and caches successful data', async () => {
  let calls = 0;
  globalThis.fetch = async url => {
    calls += 1;
    assert.equal(url.searchParams.get('symbol'), 'NVDA');
    assert.equal(url.searchParams.get('token'), 'secret');
    assert.equal(url.searchParams.get('unexpected'), null);
    return new Response(JSON.stringify({ c:123.45 }), { status:200, headers:{ 'content-type':'application/json' } });
  };
  const query = 'path=/quote&symbol=nvda&unexpected=value';
  const first = await handleMarketRequest(request(query), { apiKey:'secret', clientId:'one' });
  const second = await handleMarketRequest(request(query), { apiKey:'secret', clientId:'one' });
  assert.equal(first.status, 200);
  assert.equal(second.headers.get('x-stocknews-cache'), 'hit');
  assert.equal(calls, 1);
});

test('enforces the configured per-client rate limit', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ c:1 }), { status:200 });
  const options = { apiKey:'secret', clientId:'one', rateLimit:1 };
  assert.equal((await handleMarketRequest(request('path=/quote&symbol=NVDA'), options)).status, 200);
  assert.equal((await handleMarketRequest(request('path=/quote&symbol=AAPL'), options)).status, 429);
});

test('does not expose upstream exception details', async () => {
  globalThis.fetch = async () => { throw new Error('private upstream detail'); };
  const response = await handleMarketRequest(request('path=/quote&symbol=NVDA'), { apiKey:'secret' });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error:'market data unavailable' });
});
