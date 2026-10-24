// Financial statements from the SEC's XBRL company facts (tools/financials-lib.mjs), checked on
// Apple's own filings (test/fixtures/sec/aapl-companyfacts.json, trimmed to the figures used).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { secRows, secTicker } from '../tools/financials-lib.mjs';

const facts = JSON.parse(readFileSync(new URL('./fixtures/sec/aapl-companyfacts.json', import.meta.url), 'utf8'));
const rows = secRows(facts);
const A = rows.filter(r => r.period === 'A'), Q = rows.filter(r => r.period === 'Q');

test('five fiscal years, newest first, named by the year they end in', () => {
  assert.deepEqual(A.map(r => r.label), ['2025', '2024', '2023', '2022', '2021']);
  assert.equal(A[0].period_end, '2025-09-27');
  // Apple's 10-K for fiscal 2025: revenue 416.161 bn, net income 112.010 bn, diluted EPS 7.46.
  assert.equal(A[0].data.revenue, 416161000000);
  assert.equal(A[0].data.net_income, 112010000000);
  assert.equal(A[0].data.eps, 7.46);
  assert.equal(A[0].data.fcf, A[0].data.ocf - A[0].data.capex);
  assert.ok(A[0].data.assets > 0 && A[0].data.equity > 0);
  assert.equal(A[0].currency, 'USD');
});

test('twenty quarters; the fourth is the year less the first nine months', () => {
  assert.equal(Q.length, 20);
  assert.equal(Q[0].label, 'T3 2026');
  const q4 = Q.find(r => r.label === 'T4 2025'), q1 = Q.find(r => r.label === 'T1 2025');
  assert.equal(q4.period_end, '2025-09-27');
  assert.equal(q4.data.revenue, 102466000000);
  assert.equal(q1.data.revenue, 124300000000);
  // Cash flows come as the year so far; a quarter is the difference.
  const q2 = Q.find(r => r.label === 'T2 2026');
  assert.ok(q2.data.ocf > 20e9 && q2.data.ocf < 40e9, String(q2.data.ocf));
  // Balance sheet at the quarter's end.
  assert.ok(q2.data.assets > 300e9);
  // The four quarters add up to the year.
  const fy = Q.filter(r => / 2025$/.test(r.label)).reduce((s, r) => s + r.data.revenue, 0);
  assert.equal(fy, A[0].data.revenue);
});

test('a share class is written as the SEC does', () => {
  assert.equal(secTicker('BRK.B'), 'BRK-B');
  assert.equal(secTicker('aapl'), 'AAPL');
});

test('no figures, no rows', () => {
  assert.deepEqual(secRows({}), []);
  assert.deepEqual(secRows({ facts: { 'ifrs-full': { Revenue: {} } } }), []);
});
