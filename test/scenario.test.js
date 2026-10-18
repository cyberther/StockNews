import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis;
await import('../templates/shared/hif-scenario.js');
const S = window.HIFScenario;
const base = { revenue: 1000, margin: 15, exposure: 40, shock: -5, mitigation: 20, contribution: 30 };

test('the worked example from PR #82: -16 revenue, -4.8 operating profit, 150 -> 145.2', () => {
  const r = S.compute(base);
  assert.equal(r.base, 150);
  assert.equal(r.revenueDelta, -16);
  assert.equal(r.profitDelta, -4.8);
  assert.equal(r.projected, 145.2);
  assert.equal(r.deltaPct, -3.2);
  assert.match(r.formula, /1000 × 40% × −5% × \(1 − 20%\) = −16/);
  assert.match(r.formula, /−16 × 30% = −4\.8/);
});

test('inputs out of range are refused with the field\'s name', () => {
  assert.throws(() => S.compute({ ...base, exposure: 140 }), /exposure must be between 0 and 100/);
  assert.throws(() => S.compute({ ...base, revenue: -1 }), /revenue must be between 0/);
  assert.throws(() => S.compute({ ...base, shock: Number.NaN }), /shock/);
  assert.throws(() => S.compute({ ...base, margin: '' }), /margin is required/);
});

test('a zero baseline gives no percentage instead of dividing by zero', () => {
  const r = S.compute({ ...base, margin: 0 });
  assert.equal(r.base, 0);
  assert.equal(r.deltaPct, null);
});
