import test from 'node:test';
import assert from 'node:assert/strict';

await import('../templates/shared/hif-markets.js');
await import('../templates/shared/hif-refresh.js');
const R = globalThis.HIFRefresh;
const MIN = 60000;
// Tuesday 2026-10-20 11:00 in Bucharest, 07:00 in New York: BVB open, US closed.
const tue = Date.parse('2026-10-20T08:00:00Z');
const base = { hidden: false, lastActivity: tue - MIN, lastRefresh: tue - 6 * MIN, now: tue, symbols: ['SNP.RO', 'AAPL'] };
const go = o => R.shouldRefresh(Object.assign({}, base, o));

test('constants', () => {
  assert.equal(R.IDLE_MS, 15 * MIN);
  assert.equal(R.MIN_INTERVAL_MS, 5 * MIN);
  assert.equal(R.LIVE_MAX_AGE_MS, 20 * MIN);
});

test('a hidden page never refreshes', () => assert.equal(go({ hidden: true }), false));

test('a visible page nobody has touched for more than 15 minutes stops refreshing', () => {
  assert.equal(go({ lastActivity: tue - 16 * MIN }), false);
  assert.equal(go({ lastActivity: tue - 14 * MIN }), true);
});

test('while a market is open: every 5 minutes, not sooner', () => {
  assert.equal(go({ lastRefresh: tue - 6 * MIN }), true);
  assert.equal(go({ lastRefresh: tue - 4 * MIN }), false);
  assert.equal(go({ lastRefresh: 0 }), true);
});

test('with every market closed: once after the close, then nothing', () => {
  const sat = Date.parse('2026-10-24T10:00:00Z');
  const s = { now: sat, lastActivity: sat - MIN, symbols: ['SNP.RO', 'AAPL'] };
  // Last refresh on Friday before New York closed: one more, for the closing prices.
  assert.equal(go(Object.assign({}, s, { lastRefresh: Date.parse('2026-10-23T19:00:00Z') })), true);
  // Already refreshed after Friday's close (plus the jobs' grace period): nothing until Monday.
  assert.equal(go(Object.assign({}, s, { lastRefresh: Date.parse('2026-10-23T21:00:00Z') })), false);
});

test('symbols on closed markets only: no polling during the other markets\' hours', () => {
  // 08:00Z Tuesday: only Europe trades; a US-only watchlist refreshed after Monday's close waits.
  assert.equal(go({ symbols: ['AAPL'], lastRefresh: Date.parse('2026-10-19T21:00:00Z') }), false);
});

test('freshness: live only when recent and the market is trading', () => {
  assert.equal(R.freshness(tue - 3 * MIN, ['SNP.RO'], tue), 'live');
  assert.equal(R.freshness(tue - 25 * MIN, ['SNP.RO'], tue), 'delayed');
  assert.equal(R.freshness(tue - 3 * MIN, ['AAPL'], tue), 'closed');
  assert.equal(R.freshness(null, ['SNP.RO'], tue), 'delayed');
});
