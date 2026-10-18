import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = globalThis;
await import('../templates/shared/hif-scenario.js');
await import('../templates/shared/hif-impact.js');
const I = window.HIFImpact;
const sample = JSON.parse(readFileSync(new URL('./fixtures/impact/sample-v1.json', import.meta.url), 'utf8'));
const co = { revenue: 1000, operating_profit: 150, exposure: 40, shock: -5, mitigation: 20, contribution: 30 };

test('engine version and the three scenarios', () => {
  assert.equal(I.ENGINE_VERSION, '1.0.0');
  assert.deepEqual(I.SCENARIOS, ['full', 'partial', 'delayed']);
});

test('months in force in a year, from the start date plus the delay', () => {
  assert.equal(I.monthsInForce('2026-08-01', 0, 2026), 5);
  assert.equal(I.monthsInForce('2026-08-01', 6, 2026), 0);
  assert.equal(I.monthsInForce('2026-08-01', 6, 2027), 11);
  assert.equal(I.monthsInForce('2025-01-01', 0, 2026), 12);
  assert.equal(I.monthsInForce('2026-01-01', 0, 2026), 12);
  assert.equal(I.monthsInForce('2027-01-01', 0, 2026), 0);
});

test('a temporary measure: months in force stop at the end date (inclusive)', () => {
  assert.equal(I.monthsInForce('2026-08-01', 0, 2026, '2026-10-31'), 3);
  assert.equal(I.monthsInForce('2026-08-05', 0, 2026, '2026-10-31'), 2.8709677419);
  assert.equal(I.monthsInForce('2026-08-01', 1, 2026, '2026-10-31'), 2);
  assert.equal(I.monthsInForce('2026-08-01', 6, 2027, '2026-10-31'), 0);
  assert.equal(I.monthsInForce('2026-11-01', 0, 2027, '2027-01-31'), 1);
  const b = I.budget({ cost: 1.2e9, funded_pct: 0, gdp: 2e12, start: '2026-08-01', end: '2026-10-31', impl_pct: 100, delay_months: 0 });
  assert.equal(b.byYear[2026], -3e8);
  assert.equal(b.byYear[2027], 0);
  assert.throws(() => I.budget({ cost: 1, funded_pct: 0, gdp: 1, start: '2026-08-01', end: 'never', impl_pct: 100, delay_months: 0 }), /end/);
});

test('budget: net effect on the balance, share of GDP, effect per year', () => {
  const b = I.budget({ cost: 1.2e10, funded_pct: 25, gdp: 2e12, start: '2026-01-01', impl_pct: 100, delay_months: 0 });
  assert.equal(b.net, -9e9);
  assert.equal(b.pctGdp, -0.45);
  assert.equal(b.byYear[2026], -9e9);
  assert.equal(b.byYear[2027], -9e9);
  assert.match(b.formula, /−12000000000 × \(1 − 25%\) = −9000000000/);
  const rev = I.budget({ cost: -5e9, funded_pct: 0, gdp: 2e12, start: '2026-07-01', impl_pct: 50, delay_months: 0 });
  assert.equal(rev.net, 5e9);
  assert.equal(rev.byYear[2026], 1.25e9);
});

test('budget inputs out of range are refused with the field name', () => {
  assert.throws(() => I.budget({ cost: 1, funded_pct: 120, gdp: 1, start: '2026-01-01', impl_pct: 100, delay_months: 0 }), /funded_pct/);
  assert.throws(() => I.budget({ cost: 1, funded_pct: 0, gdp: 0, start: '2026-01-01', impl_pct: 100, delay_months: 0 }), /gdp/);
  assert.throws(() => I.budget({ cost: 1, funded_pct: 0, gdp: 1, start: 'mâine', impl_pct: 100, delay_months: 0 }), /start/);
});

test('company: the PR #82 example, then scaled by the scenario', () => {
  const full = I.company(co, { impl_pct: 100, start: '2026-01-01', delay_months: 0 });
  assert.equal(full.revenueDelta, -16);
  assert.equal(full.profitDelta, -4.8);
  assert.equal(full.pctOfProfit, -3.2);
  const half = I.company(co, { impl_pct: 50, start: '2026-07-01', delay_months: 0 });
  assert.equal(half.byYear[2026], -1.2);
  assert.equal(half.byYear[2027], -2.4);
  assert.equal(half.pctOfProfit, -1.6);
  assert.match(full.formula, /1000 × 40% × −5% × \(1 − 20%\) = −16/);
});

test('company: zero baseline gives no percentage; a loss is measured against its size', () => {
  assert.equal(I.company({ ...co, operating_profit: 0 }, { impl_pct: 100, start: '2026-01-01', delay_months: 0 }).pctOfProfit, null);
  assert.equal(I.company({ ...co, operating_profit: -100 }, { impl_pct: 100, start: '2026-01-01', delay_months: 0 }).pctOfProfit, -4.8);
});

test('scenario parameters come from the analysis assumptions', () => {
  assert.deepEqual(I.scenarioParams(sample, 'full'), { impl_pct: 100, delay_months: 0, start: '2026-01-01', end: null });
  assert.deepEqual(I.scenarioParams(sample, 'partial'), { impl_pct: 50, delay_months: 0, start: '2026-01-01', end: null });
  assert.deepEqual(I.scenarioParams(sample, 'delayed'), { impl_pct: 100, delay_months: 6, start: '2026-01-01', end: null });
  const temp = { ...sample, assumptions: [...sample.assumptions, { key: 'end', value: '2026-10-31' }] };
  assert.equal(I.scenarioParams(temp, 'full').end, '2026-10-31');
});

test('resolve reads an assumption or a fact by key, and refuses anything else', () => {
  assert.equal(I.resolve(sample, { ref: 'exp' }), 40);
  assert.equal(I.resolve(sample, { ref: 'rate' }), 21);
  assert.throws(() => I.resolve(sample, { ref: 'nope' }), /nope/);
  assert.throws(() => I.resolve(sample, 40), /ref/);
});

test('run: budget and every company in three scenarios; missing financials are said so', () => {
  const r = I.run(sample, [{ ticker: 'M.RO', fiscal_year: 2025, revenue: 1000, operating_profit: 150, verified: true }]);
  assert.equal(r.engine, '1.0.0');
  assert.deepEqual(Object.keys(r.budget), ['full', 'partial', 'delayed']);
  assert.equal(r.budget.full.net, -9e9);
  assert.equal(r.budget.delayed.byYear[2026], -4.5e9);
  assert.equal(r.companies['M.RO'].full.profitDelta, -4.8);
  assert.equal(r.companies['M.RO'].partial.pctOfProfit, -1.6);
  assert.deepEqual(r.companies['SNP.RO'], { missing: 'financials' });
});

test('run uses only verified financials, the latest year', () => {
  const r = I.run(sample, [
    { ticker: 'M.RO', fiscal_year: 2024, revenue: 500, operating_profit: 50, verified: true },
    { ticker: 'M.RO', fiscal_year: 2025, revenue: 1000, operating_profit: 150, verified: true },
    { ticker: 'SNP.RO', fiscal_year: 2025, revenue: 1000, operating_profit: 150, verified: false }]);
  assert.equal(r.companies['M.RO'].full.revenueDelta, -16);
  assert.equal(r.companies['M.RO'].fiscal_year, 2025);
  assert.deepEqual(r.companies['SNP.RO'], { missing: 'financials' });
});

test('portfolio: weighted change of operating profit over the positions held', () => {
  const results = { companies: { 'A.RO': { full: { pctOfProfit: -10 } }, 'B.RO': { full: { pctOfProfit: 5 } }, 'C.RO': { missing: 'financials' } } };
  const p = I.portfolio(results, { 'A.RO': { value: 600 }, 'B.RO': { value: 400 } }, 'full');
  assert.equal(p.weighted, -4);
  assert.deepEqual(p.parts.map(x => [x.ticker, x.weight]), [['A.RO', 60], ['B.RO', 40]]);
  assert.match(p.formula, /60% × −10%/);
  assert.deepEqual(I.portfolio(results, { 'A.RO': { value: null } }, 'full'), { weighted: null, parts: [], formula: '', reason: 'no_values' });
  assert.equal(I.portfolio(results, { 'Z.RO': { value: 10 } }, 'full').reason, 'not_held');
});

test('accuracy: error, relative error and direction', () => {
  assert.deepEqual(I.accuracy(-10, -8), { error: 2, relError: 0.2, direction: true });
  assert.equal(I.accuracy(0, 1).relError, null);
  assert.equal(I.accuracy(-10, 3).direction, false);
});
