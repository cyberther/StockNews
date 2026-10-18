import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const fileFlags = JSON.parse(readFileSync(new URL('../config/flags.json', import.meta.url), 'utf8'));
await import('../templates/shared/hif-flags.js');
const F = globalThis.HIFFlags;

test('the browser copy of the flags matches config/flags.json', () => {
  assert.deepEqual(F.all(), fileFlags);
});

test('Phase A defaults: Following, BVB and Portfolio on; US/EU feeds and scans on hold', () => {
  assert.equal(F.get('following'), true);
  assert.equal(F.get('bvb'), true);
  assert.equal(F.get('portfolio'), true);
  for (const k of ['usMarket', 'euMarket', 'universeScan', 'prefetchUnfollowedNews', 'hiddenModuleRefresh', 'commercialMode'])
    assert.equal(F.get(k), false, k);
  assert.equal(F.get('dataSource'), 'supabase');
});

test('an unknown flag reads as undefined, and all() is a copy', () => {
  assert.equal(F.get('nope'), undefined);
  F.all().usMarket = true;
  assert.equal(F.get('usMarket'), false);
});

test('the gateway refuses the on-hold US and EU market feeds without calling anyone', async () => {
  const { handleMarketRequest, resetGatewayForTests } = await import('../netlify/functions/_shared/market/gateway.js');
  resetGatewayForTests();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('[]', { status: 200 }); };
  try {
    for (const path of ['/us-news', '/eu-news']) {
      const r = await handleMarketRequest(new Request('http://localhost/api/finnhub?path=' + path), {});
      assert.equal(r.status, 404, path);
      assert.equal((await r.json()).error, 'feature on hold');
    }
    assert.equal(calls, 0);
    // Following's feeds stay on: the Bucharest press, and US press for the followed names
    // (the background scan asks /us-news with names=TICKER:Name).
    const ro = await handleMarketRequest(new Request('http://localhost/api/finnhub?path=/ro-news'), {});
    assert.notEqual(ro.status, 404);
    const us = await handleMarketRequest(new Request('http://localhost/api/finnhub?path=/us-news&names=OKLO:Oklo'), {});
    assert.notEqual(us.status, 404);
    assert.ok(calls > 0);
  } finally { globalThis.fetch = originalFetch; }
});
