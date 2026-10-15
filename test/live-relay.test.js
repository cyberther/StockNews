import test from 'node:test';
import assert from 'node:assert/strict';
import { addTrade, SYMBOL_RE } from '../tools/live-relay.mjs';

test('trades fold into one bar per second; late trades join their second', () => {
  const st = { bars: [], dirty: new Set() };
  addTrade(st, 1_000_000_100, 10, 5);
  addTrade(st, 1_000_000_900, 12, 1);
  addTrade(st, 1_000_000_950, 9, 2);
  addTrade(st, 1_000_001_200, 11, 4);
  addTrade(st, 1_000_000_990, 13, 1);   // late, for the first second
  assert.deepEqual(st.bars, [{ t: 1_000_000, o: 10, h: 13, l: 9, c: 9, v: 9 }, { t: 1_000_001, o: 11, h: 11, l: 11, c: 11, v: 4 }]);
  assert.deepEqual([...st.dirty], [1_000_000, 1_000_001]);
  assert.ok(SYMBOL_RE.test('NVDA') && SYMBOL_RE.test('BRK.B'));
  assert.ok(!SYMBOL_RE.test('SNP.RO') && !SYMBOL_RE.test('nvda') && !SYMBOL_RE.test('A/B'));
});
