import test from 'node:test';
import assert from 'node:assert/strict';

await import('../templates/shared/hif-markets.js');
const M = globalThis.HIFMarkets;
const at = iso => new Date(iso);

test('marketOf files each symbol under its exchange, and rejects what it cannot place', () => {
  assert.equal(M.marketOf('SNP.RO'), 'BVB');
  assert.equal(M.marketOf('bmw.de'), 'XETRA');
  assert.equal(M.marketOf('PZC.L'), 'LSE');
  assert.equal(M.marketOf('AAPL'), 'US');
  assert.equal(M.marketOf('brk.b'), 'US');
  assert.equal(M.marketOf('FOO.XX'), null);
  assert.equal(M.marketOf("'; drop"), null);
  assert.equal(M.marketOf(''), null);
});

test('Bucharest: open on a Tuesday morning, closed on Saturday and after 17:45', () => {
  assert.equal(M.isOpen('BVB', at('2026-10-20T08:00:00Z')), true);   // 11:00 EEST
  assert.equal(M.isOpen('BVB', at('2026-10-24T08:00:00Z')), false);  // Saturday
  assert.equal(M.isOpen('BVB', at('2026-10-20T14:50:00Z')), false);  // 17:50 EEST
});

test('New York follows its own daylight saving change', () => {
  assert.equal(M.isOpen('US', at('2026-10-20T13:00:00Z')), false);  // 09:00 EDT
  assert.equal(M.isOpen('US', at('2026-10-20T13:31:00Z')), true);   // 09:31 EDT
  assert.equal(M.isOpen('US', at('2026-11-03T14:31:00Z')), true);   // 09:31 EST, after 1 Nov
  assert.equal(M.isOpen('US', at('2026-11-03T13:31:00Z')), false);  // 08:31 EST
});

test('XETRA the day after Europe moves to summer time', () => {
  assert.equal(M.isOpen('XETRA', at('2026-03-30T07:05:00Z')), true);  // 09:05 CEST
  assert.equal(M.isOpen('XETRA', at('2026-03-30T15:31:00Z')), false); // 17:31 CEST
});

test('lastClose is the latest session end at or before the moment', () => {
  // Monday morning before New York opens: Friday 16:00 EDT.
  assert.equal(M.lastClose('US', at('2026-10-19T08:00:00Z')).toISOString(), '2026-10-16T20:00:00.000Z');
  // During Tuesday's session: Monday's close.
  assert.equal(M.lastClose('BVB', at('2026-10-20T08:00:00Z')).toISOString(), '2026-10-19T14:45:00.000Z');
  // Tuesday evening: that same day's close.
  assert.equal(M.lastClose('BVB', at('2026-10-20T18:00:00Z')).toISOString(), '2026-10-20T14:45:00.000Z');
});

test('anyOpen looks at the markets of the symbols given, ignoring unknown ones', () => {
  assert.equal(M.anyOpen(['SNP.RO', 'AAPL'], at('2026-10-20T08:00:00Z')), true);
  assert.equal(M.anyOpen(['SNP.RO', 'AAPL'], at('2026-10-20T22:00:00Z')), false);
  assert.equal(M.anyOpen(['AAPL', 'FOO.XX'], at('2026-10-20T08:00:00Z')), false);
  assert.equal(M.anyOpen([], at('2026-10-20T08:00:00Z')), false);
  assert.deepEqual(M.openMarkets(at('2026-10-20T14:00:00Z')).sort(), ['BVB', 'LSE', 'US', 'XETRA']);
});
