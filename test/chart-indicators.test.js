import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The chart analysis tab's indicator maths (templates/shared/hif-livechart.js).
const ctx = { window: {} };
vm.runInNewContext(readFileSync(new URL('../templates/shared/hif-livechart.js', import.meta.url), 'utf8'), ctx);
const C = ctx.window.HIFLiveChart;
const near = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('simple and exponential averages', () => {
  const v = [1, 2, 3, 4, 5, 6];
  assert.deepEqual([...C.smaOf(v, 3)], [null, null, 2, 3, 4, 5]);
  const e = C.emaOf(v, 3);
  assert.equal(e[1], null);
  near(e[2], 2); near(e[3], 3); near(e[5], 5);
  const flat = C.emaOf(new Array(40).fill(7), 9);
  near(flat[39], 7);
});

// StockCharts' worked example gives 70.53 from averages rounded to 2 decimals; unrounded, 70.46.
test('RSI matches Wilder’s worked example', () => {
  const c = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28];
  const r = C.rsiOf(c, 14);
  assert.equal(r[13], null);
  near(r[14], 70.46, 0.01);
});

test('MACD is flat on a flat price; DMI on a steady rise', () => {
  const m = C.macdOf(new Array(60).fill(10), 12, 26, 9);
  near(m.line[59], 0); near(m.signal[59], 0); near(m.hist[59], 0);
  assert.equal(m.signal[30], null);
  const bars = Array.from({ length: 60 }, (_, i) => ({ high: 11 + i, low: 9 + i, close: 10 + i }));
  const d = C.dmiOf(bars, 14);
  near(d.minus[59], 0); near(d.adx[59], 100); assert.ok(d.plus[59] > 30);
});
