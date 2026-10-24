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

// More indicators (2026-10-24: the chart tab gets the usual TradingView set).
const bar = (high, low, close, volume = 0, open = close) => ({ open, high, low, close, volume });

test('Bollinger bands: k standard deviations around the average', () => {
  const b = C.bollingerOf([1, 2, 3, 4, 5], 5, 2);
  assert.equal(b.mid[3], null);
  near(b.mid[4], 3); near(b.up[4], 3 + 2 * Math.sqrt(2)); near(b.lo[4], 3 - 2 * Math.sqrt(2));
});

test('Stochastic, Williams %R and CCI at the top and bottom of a range', () => {
  const up = Array.from({ length: 30 }, (_, i) => bar(10 + i + 0.5, 10 + i - 0.5, 10 + i + 0.5));
  const s = C.stochOf(up, 14, 3, 3);
  near(s.k[29], 100); near(s.d[29], 100); assert.equal(s.k[14], null);
  near(C.willrOf(up, 14)[29], 0);
  const down = up.map(b => bar(-b.low, -b.high, -b.high));
  near(C.willrOf(down, 14)[29], -100);
  assert.ok(C.cciOf(up, 20)[29] > 100, 'a steady rise sits above +100');
  assert.equal(C.cciOf(Array.from({ length: 25 }, () => bar(2, 1, 1.5)), 20)[24], 0);
});

test('ATR on bars of a constant range; OBV adds up and takes away', () => {
  near(C.atrOf(Array.from({ length: 30 }, (_, i) => bar(11 + i, 9 + i, 10 + i)), 14)[29], 2);
  assert.deepEqual([...C.obvOf([bar(1, 1, 10, 100), bar(1, 1, 11, 50), bar(1, 1, 9, 20), bar(1, 1, 9, 70)])], [0, 50, 30, 30]);
});

test('VWAP starts again each session', () => {
  const bars = [bar(11, 9, 10, 100), bar(13, 11, 12, 300), bar(21, 19, 20, 10), bar(23, 21, 22, 10)];
  const v = C.vwapOf(bars, i => i < 2 ? 'd1' : 'd2');
  near(v[1], (10 * 100 + 12 * 300) / 400); near(v[2], 20); near(v[3], 21);
});

test('Ichimoku lines are mid-points of their ranges; spans shift 26 bars', () => {
  const bars = Array.from({ length: 60 }, (_, i) => bar(10 + i + 1, 10 + i - 1, 10 + i));
  const k = C.ichimokuOf(bars, 9, 26, 52);
  near(k.tenkan[59], ((10 + 59 + 1) + (10 + 51 - 1)) / 2);
  near(k.kijun[59], ((10 + 59 + 1) + (10 + 34 - 1)) / 2);
  near(k.spanA[59], (k.tenkan[59] + k.kijun[59]) / 2);
  assert.equal(k.spanB[50], null); assert.equal(k.shift, 26);
});

test('Heikin Ashi bars', () => {
  const h = C.heikinAshi([bar(12, 8, 11, 0, 9), bar(14, 10, 13, 0, 11)]);
  near(h[0].open, 10); near(h[0].close, 10);
  near(h[1].open, 10); near(h[1].close, 12); near(h[1].high, 14); near(h[1].low, 10);
});

test('Volume profile: the busiest price row is the point of control', () => {
  const p = C.volumeProfile([bar(10, 0, 5, 100), bar(10, 9.5, 9.8, 900)], 10);
  near(p.lo, 0); near(p.hi, 10); assert.equal(p.vol.length, 10);
  near(p.vol.reduce((a, b) => a + b, 0), 1000);
  assert.equal(p.poc, 9);
  assert.equal(C.volumeProfile([bar(5, 5, 5, 1)], 10), null);
});

test('every drawing tool says how many clicks it takes', () => {
  for (const t of ['hline', 'hray', 'vline', 'text', 'trend', 'ray', 'ext', 'arrow', 'zone', 'rect', 'fib', 'measure', 'channel', 'fibext', 'pitchfork'])
    assert.ok(C.POINTS[t] >= 1 && C.POINTS[t] <= 3, t);
});
