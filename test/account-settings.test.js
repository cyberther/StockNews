// The settings that follow the account (templates/shared/hif-settings.js), and the positions
// table while prices and profiles load (hif-insight.js holdings()).
// 2026-10-24: the owner asked for every reader's settings, the chart's set-up per ticker
// included, to be kept with the account; a Bucharest position was counted in dollars until
// its profile came, so the portfolio showed part of its total first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const load = f => { const ctx = { window: {}, navigator: { language: 'en-US' } }; vm.runInNewContext(readFileSync(new URL('../templates/shared/' + f, import.meta.url), 'utf8'), ctx); return ctx.window; };
const S = load('hif-settings.js').HIFSettings;
const IN = load('hif-insight.js').HIFInsight;

test('pick keeps the settings that follow the account, and nothing else', () => {
  const state = { theme: 'light', timeoutMin: 15, feedTab: 'bvb', lcIv: '1d', lcAvg: { sma20: true }, lcInd: { rsi: true }, lcPen: 'red', lcAuto: true,
    pfCur: 'RON', session: { email: 'x@y.z' }, follows: ['AMD'], positions: { AMD: {} }, authPw: 'secret', lcView: { AMD: { iv: '1wk', auto: false } } };
  assert.deepEqual(JSON.parse(JSON.stringify(S.pick(state))), { theme: 'light', timeoutMin: 15, feedTab: 'bvb', pfCur: 'RON', lcIv: '1d', lcAvg: { sma20: true },
    lcInd: { rsi: true }, lcAuto: true, lcPen: 'red', lcView: { AMD: { iv: '1wk', auto: false } } });
});

test('clean leaves out what is not a setting or has the wrong shape', () => {
  const out = S.clean({ theme: 'pink', timeoutMin: -1, lcIv: '5m', lcAvg: { sma20: 'yes' }, lcInd: { rsi: true }, showOpinion: false, admin: true,
    lcView: { 'AMD': { iv: '1d', avg: { ema50: true }, x: 1 }, 'bad ticker': { iv: '1d' }, 'TLV.RO': { iv: 'forever' } } });
  assert.deepEqual(JSON.parse(JSON.stringify(out)), { lcIv: '5m', lcInd: { rsi: true }, showOpinion: false, lcView: { AMD: { iv: '1d', avg: { ema50: true } } } });
  assert.deepEqual(JSON.parse(JSON.stringify(S.clean(null))), {});
  assert.deepEqual(JSON.parse(JSON.stringify(S.clean([1]))), {});
});

test('withView puts the ticker last and keeps the most recent MAX_VIEWS', () => {
  let v = S.withView({ AMD: { iv: '1d' }, MSFT: { iv: '5m' } }, 'AMD', { iv: '1wk', avg: {}, ind: { rsi: true }, auto: false });
  assert.deepEqual(Object.keys(v), ['MSFT', 'AMD']);
  assert.deepEqual(JSON.parse(JSON.stringify(v.AMD)), { iv: '1wk', avg: {}, ind: { rsi: true }, auto: false });
  for (let i = 0; i < S.MAX_VIEWS + 5; i++) v = S.withView(v, 'T' + i, { iv: '1d' });
  assert.equal(Object.keys(v).length, S.MAX_VIEWS);
  assert.equal(Object.keys(v)[0], 'T5');
});

test('a Bucharest position is counted in lei while its profile loads, and a missing price is counted', () => {
  const pos = { 'TLV.RO': { shares: 10, cost: '20' }, 'SNG.RO': { shares: 5, cost: '50' }, AMD: { shares: 2, cost: '100' } };
  const quotes = { 'TLV.RO': { price: 30 }, AMD: { price: 150, currency: 'USD' } };
  const HB = IN.holdings(pos, t => quotes[t] || {});
  const ron = HB.totals.find(t => t.currency === 'RON'), usd = HB.totals.find(t => t.currency === 'USD');
  assert.equal(ron.count, 2);
  assert.equal(ron.missing, 1, 'SNG.RO has no price yet');
  assert.equal(usd.count, 1);
  assert.equal(usd.missing, 0);
});
