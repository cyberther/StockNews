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

// Automatic support and resistance.
const wave = (n, lo, hi, period) => Array.from({ length: n }, (_, i) => {
  const x = lo + (hi - lo) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / period));
  return { high: x + 0.2, low: x - 0.2, close: x };
});

test('auto levels: a range between 100 and 110 gives support and resistance there', () => {
  const bars = wave(200, 100, 110, 20).concat([{ high: 105.2, low: 104.8, close: 105 }]);
  const lv = C.autoLevels(bars);
  const r1 = lv.find(x => x.label === 'R1'), s1 = lv.find(x => x.label === 'S1');
  near(r1.p, 110.2, 0.3); near(s1.p, 99.8, 0.3);
  assert.ok(r1.touches >= 5 && s1.touches >= 5);
});

test('auto levels: swings a tick apart never chain into one level across the chart', () => {
  // Swing lows creeping up by 0.1% each time: every band stays within its tolerance.
  const bars = [];
  for (let k = 0; k < 40; k++) {
    const base = 100 * (1 + k * 0.001);
    for (let i = 0; i < 12; i++) { const x = base + (i < 6 ? i : 12 - i) * 0.5; bars.push({ high: x + 0.05, low: x - 0.05, close: x }); }
  }
  bars.push({ high: 103.6, low: 103.4, close: 103.5 });
  const supports = C.autoLevels(bars).filter(x => x.label[0] === 'S');
  assert.ok(supports.length >= 2);
  supports.forEach(x => assert.ok(x.touches < 20, `${x.p} ×${x.touches}`));
});

test('auto levels: a run of equal prices counts as one swing', () => {
  const bars = [];
  for (let i = 0; i < 30; i++) bars.push({ high: 50 + (i % 10), low: 49.8 + (i % 10), close: 50 + (i % 10) });
  for (let i = 0; i < 40; i++) bars.push({ high: 47, low: 47, close: 47 });
  for (let i = 0; i < 30; i++) bars.push({ high: 50 + (i % 10), low: 49.8 + (i % 10), close: 50 + (i % 10) });
  bars.push({ high: 53, low: 53, close: 53 });
  const s = C.autoLevels(bars).find(x => Math.abs(x.p - 47) < 0.2);
  assert.ok(s, 'support at 47');
  assert.equal(s.touches, 1);
});
