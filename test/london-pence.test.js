import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// hif-insight.js is a browser script; run it with a window of its own.
const ctx = { window: {} };
vm.runInNewContext(readFileSync(new URL('../templates/shared/hif-insight.js', import.meta.url), 'utf8'), ctx);
const { holdings, position, portfolioSeries, unitScale } = ctx.window.HIFInsight;

test('a London position is priced in pence and valued in pounds', () => {
  const h = holdings({ 'PZC.L': { shares: 1000, cost: '90' }, 'AAPL': { shares: 2, cost: '150' } },
    t => t === 'PZC.L' ? { price: '99.40p', move: '+1.6%', currency: 'GBP' } : { price: '200.00', move: '+1.0%', currency: 'USD' });
  const pz = h.rows.find(r => r.ticker === 'PZC.L');
  assert.equal(pz.priceLabel, '99.40p');
  assert.equal(pz.avgLabel, '90.00p');
  assert.equal(pz.currency, 'GBP');
  assert.ok(Math.abs(pz.value - 994) < 1e-9, '1000 x 99.40p = £994');
  assert.ok(Math.abs(pz.pl - 94) < 1e-9, '£94 gain');
  assert.equal(pz.valueLabel, '994.00 GBP');
  const us = h.rows.find(r => r.ticker === 'AAPL');
  assert.equal(us.value, 400);
  assert.equal(us.priceLabel, '200.00 USD');
});

test('the detail box and the value chart use the same pounds', () => {
  assert.equal(unitScale('PZC.L'), 0.01);
  assert.equal(unitScale('SAP.DE'), 1);
  const p = position({ shares: 1000, cost: '90' }, '99.40p', '0', 'GBP ', unitScale('PZC.L'));
  assert.ok(Math.abs(p.value - 994) < 1e-9);
  const s = portfolioSeries({ 'PZC.L': { shares: 1000, cost: '90' } }, () => [{ ts: 1, close: 98 }, { ts: 2, close: 99.4 }], () => 'GBP', 'GBP');
  assert.ok(Math.abs(s.cost - 900) < 1e-9);
  assert.ok(Math.abs(s.points[1].value - 994) < 1e-9);
});
