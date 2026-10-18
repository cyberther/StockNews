import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = globalThis;
await import('../templates/shared/hif-scenario.js');
await import('../templates/shared/hif-impact.js');
await import('../templates/shared/hif-impact-client.js');
const C = window.HIFImpactClient;
const sample = JSON.parse(readFileSync(new URL('./fixtures/impact/sample-v1.json', import.meta.url), 'utf8'));

test('one request per list, exact PostgREST queries', () => {
  assert.equal(C.query.analyses(), 'impact_analyses?select=id,version,published_at,title,policy,events,sectors,body&order=published_at.desc,id.asc,version.desc&limit=200');
  assert.equal(C.query.results('sample-measure', 1), 'impact_results?select=scenario,subject,engine_version,vals,formula,computed_at&analysis_id=eq.sample-measure&version=eq.1&order=computed_at.asc');
  assert.equal(C.query.accuracy('sample-measure', 1), 'analysis_accuracy?select=*&analysis_id=eq.sample-measure&version=eq.1');
  assert.equal(C.query.financials('SNP.RO'), 'company_financials?select=*&ticker=eq.SNP.RO&order=fiscal_year.desc,provenance.asc&limit=6');
  assert.equal(C.query.exposure(), 'company_exposure?select=*&limit=2000');
  assert.throws(() => C.query.results('x);drop', 1), /id/);
  assert.throws(() => C.query.financials('snp&x=1'), /ticker/);
});

test('the latest version of each analysis, with the older ones listed', () => {
  const rows = [{ id: 'a-b', version: 2, title: 'v2' }, { id: 'a-b', version: 1, title: 'v1' }, { id: 'c-d', version: 1, title: 'c' }];
  const l = C.latest(rows);
  assert.deepEqual(l.map(a => [a.id, a.version, a.versions]), [['a-b', 2, [2, 1]], ['c-d', 1, [1]]]);
});

test('frozen results: the first computed row per scenario and subject', () => {
  const rows = [
    { scenario: 'full', subject: 'M.RO', engine_version: '1.0.0', vals: { pctOfProfit: -3 }, formula: 'old', computed_at: '2026-10-19T00:00:00Z' },
    { scenario: 'full', subject: 'M.RO', engine_version: '1.1.0', vals: { pctOfProfit: -2 }, formula: 'new', computed_at: '2026-11-01T00:00:00Z' },
    { scenario: 'full', subject: 'budget', engine_version: '1.0.0', vals: { net: -9 }, formula: 'b', computed_at: '2026-10-19T00:00:00Z' }];
  const f = C.frozen(rows);
  assert.equal(f.full['M.RO'].formula, 'old');
  assert.equal(f.full['M.RO'].pctOfProfit, -3);
  assert.equal(f.full['M.RO'].engine_version, '1.0.0');
  assert.equal(f.full.budget.net, -9);
  assert.equal(f.partial, undefined);
});

test('which of the analysis companies the reader follows or holds', () => {
  assert.deepEqual(C.concerns(sample, ['M.RO'], { 'SNP.RO': { shares: 1 } }), [{ ticker: 'M.RO', via: ['following'] }, { ticker: 'SNP.RO', via: ['portfolio'] }]);
  assert.deepEqual(C.concerns(sample, [], {}), []);
});

test('portfolio effect over the positions in lei, weighted by value', () => {
  const frozen = { full: { 'M.RO': { pctOfProfit: -10 }, 'SNP.RO': { pctOfProfit: 5 } } };
  const holdings = [{ ticker: 'M.RO', value: 600, currency: 'RON' }, { ticker: 'SNP.RO', value: 400, currency: 'RON' }, { ticker: 'AAPL', value: 5000, currency: 'USD' }];
  const p = C.portfolioEffect(frozen, holdings, 'full');
  assert.equal(p.weighted, -4);
  assert.equal(C.portfolioEffect(frozen, [{ ticker: 'M.RO', value: null, currency: 'RON' }], 'full').reason, 'no_values');
});

test('calculator parameters from an analysis: budget assumptions and one company\'s inputs', () => {
  const p = C.calcParams(sample, 'M.RO', [{ ticker: 'M.RO', fiscal_year: 2025, revenue: 1000, operating_profit: 150, verified: true }]);
  assert.deepEqual(p, { a: 'sample-measure', v: 1, t: 'M.RO', cost: 12000000000, funded_pct: 25, gdp: 2000000000000, start: '2026-01-01',
    impl_pct: 100, delay_months: 0, revenue: 1000, operating_profit: 150, exposure: 40, shock: -5, mitigation: 20, contribution: 30 });
  const noFigures = C.calcParams(sample, 'SNP.RO', []);
  assert.equal(noFigures.revenue, undefined);
  assert.equal(noFigures.exposure, 40);
});

test('the calculator link: parameters in the hash, anything invalid dropped', () => {
  const p = { a: 'sample-measure', v: 1, t: 'M.RO', cost: 1.2e10, funded_pct: 25, start: '2026-01-01', end: '2026-10-31', exposure: 40, shock: -5 };
  const h = C.encodeHash(p);
  assert.match(h, /^#a=sample-measure&v=1&t=M\.RO&cost=12000000000/);
  assert.deepEqual(C.decodeHash(h), p);
  assert.deepEqual(C.decodeHash('#funded_pct=140&exposure=abc&start=2026-13-45&t=<b>&a=X Y&shock=-5&evil=1'), { shock: -5 });
  assert.deepEqual(C.decodeHash(''), {});
});
