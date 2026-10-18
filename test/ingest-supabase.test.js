import test from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../ingest/supabase.mjs';
import { countingFetch } from '../ingest/meter.mjs';

const KEY = 'service-role-secret-value';

test('reads, upserts and inserts through PostgREST with the service key', async () => {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url: String(url), method: init.method || 'GET', headers: init.headers, body: init.body });
    return new Response(JSON.stringify([{ ok: 1 }]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const db = createDb({ url: 'https://abc.supabase.co/', key: KEY, fetch: fetchImpl });
  await db.read('watchlist', 'select=ticker');
  await db.upsert('stories', [{ id: 'a' }], { onConflict: 'id', ignoreDuplicates: true });
  await db.upsert('market_quotes', [{ symbol: 'A' }], { onConflict: 'symbol' });
  await db.insert('ingest_runs', [{ job: 'x' }]);
  assert.equal(seen[0].url, 'https://abc.supabase.co/rest/v1/watchlist?select=ticker');
  assert.equal(seen[0].headers.apikey, KEY);
  assert.equal(seen[0].headers.authorization, 'Bearer ' + KEY);
  assert.equal(seen[1].url, 'https://abc.supabase.co/rest/v1/stories?on_conflict=id');
  assert.equal(seen[1].method, 'POST');
  assert.equal(seen[1].headers.prefer, 'resolution=ignore-duplicates,return=representation');
  assert.equal(seen[2].headers.prefer, 'resolution=merge-duplicates,return=representation');
  assert.equal(seen[3].headers.prefer, 'return=minimal');
});

test('reads page through large tables', async () => {
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls++;
    const from = Number(init.headers.range.split('-')[0]);
    const rows = from === 0 ? Array.from({ length: 1000 }, (_, i) => ({ i })) : [{ i: 1000 }];
    return new Response(JSON.stringify(rows), { status: 200 });
  };
  const db = createDb({ url: 'https://abc.supabase.co', key: KEY, fetch: fetchImpl });
  assert.equal((await db.read('watchlist', 'select=ticker')).length, 1001);
  assert.equal(calls, 2);
});

test('an error names the table and status but never the key', async () => {
  const db = createDb({ url: 'https://abc.supabase.co', key: KEY, fetch: async () => new Response('{"message":"bad ' + KEY + '"}', { status: 401 }) });
  await assert.rejects(db.read('watchlist', 'select=ticker'), err => {
    assert.match(err.message, /watchlist.*401/);
    assert.doesNotMatch(err.message, new RegExp(KEY));
    return true;
  });
});

test('refuses to start without a URL and key, or with a non-Supabase URL', () => {
  assert.throws(() => createDb({ url: '', key: KEY }), /SUPABASE_URL/);
  assert.throws(() => createDb({ url: 'https://abc.supabase.co', key: '' }), /SUPABASE_SERVICE_ROLE_KEY/);
  assert.throws(() => createDb({ url: 'http://evil.example', key: KEY }), /SUPABASE_URL/);
});

test('countingFetch counts requests per provider by host', async () => {
  const meter = countingFetch(async () => new Response('ok'));
  await meter.fetch('https://query1.finance.yahoo.com/v7/finance/quote?symbols=A');
  await meter.fetch(new URL('https://fc.yahoo.com/'));
  await meter.fetch('https://www.zf.ro/rss');
  await meter.fetch(new Request('https://abc.supabase.co/rest/v1/x'));
  assert.deepEqual(meter.counts(), { yahoo: 2, feeds: 1 });
});
