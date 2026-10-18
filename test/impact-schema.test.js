import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateAnalysis, validateFinancials, validateOutcomes, loadAnalyses, checkLock, catalogTickers } from '../ingest/impact/schema.mjs';

const taxonomy = JSON.parse(readFileSync(new URL('../config/policy-taxonomy.json', import.meta.url), 'utf8'));
const sample = () => JSON.parse(readFileSync(new URL('./fixtures/impact/sample-v1.json', import.meta.url), 'utf8'));
const ctx = { taxonomy, tickers: catalogTickers() };
const errs = a => { const r = validateAnalysis(a, ctx); return r.ok ? [] : r.errors; };
const fails = (mutate, re) => { const a = sample(); mutate(a); const e = errs(a); assert.ok(e.some(x => re.test(x)), 'expected ' + re + ' in ' + JSON.stringify(e)); };

test('the sample analysis is valid', () => {
  assert.deepEqual(validateAnalysis(sample(), ctx), { ok: true });
});

test('each broken analysis fails with an error that names the key', () => {
  fails(a => { a.facts[0].source_url = 'http://www.cdep.ro/x'; }, /facts\.rate.*https/);
  fails(a => { delete a.assumptions[0].why; }, /assumptions\.cost.*why/);
  fails(a => { delete a.assumptions[0].range; }, /assumptions\.cost.*range/);
  fails(a => { a.assumptions[1].value = 120; }, /assumptions\.funded_pct.*outside/);
  fails(a => { a.assumptions[3].value = '2030-01-01'; }, /assumptions\.start.*outside/);
  fails(a => { a.companies[0].ticker = 'NOPE.RO'; }, /NOPE\.RO.*unknown/);
  fails(a => { a.sectors = ['spatiu']; }, /spatiu.*unknown/);
  fails(a => { a.companies[0].shock_pct = -5; }, /M\.RO\.shock_pct.*ref/);
  fails(a => { a.companies[0].shock_pct = { ref: 'missing' }; }, /M\.RO\.shock_pct.*missing/);
  fails(a => { a.id = 'Tva 2026!'; }, /id/);
  fails(a => { a.assumptions.push({ ...a.assumptions[0] }); }, /cost.*twice/);
  fails(a => { a.assumptions = a.assumptions.filter(x => x.key !== 'gdp'); }, /assumptions\.gdp.*required/);
  fails(a => { a.budget.approved = 'maybe'; }, /budget\.approved/);
  fails(a => { a.budget.approved_fact = 'nope'; }, /budget\.approved_fact/);
  fails(a => { a.risks[0].kind = 'political'; }, /risks\[0\]\.kind/);
  fails(a => { a.events = ['<script>']; }, /events/);
  fails(a => { a.assumptions[6].value = 140; }, /exposure.*between 0 and 100|outside/);
});

test('the version must match the file name', () => {
  const r = validateAnalysis(sample(), { ...ctx, file: 'analyses/sample-measure/v2.json' });
  assert.ok(!r.ok && r.errors.some(e => /version 1.*v2/.test(e)));
  const r2 = validateAnalysis(sample(), { ...ctx, file: 'analyses/other/v1.json' });
  assert.ok(!r2.ok && r2.errors.some(e => /id.*folder/.test(e)));
  assert.deepEqual(validateAnalysis(sample(), { ...ctx, file: 'analyses/sample-measure/v1.json' }), { ok: true });
});

test('financials: sources, years, shares and duplicates are checked', () => {
  const good = { ticker: 'M.RO', fiscal_year: 2025, currency: 'RON', revenue: 1000, operating_profit: 150, net_profit: 90,
    geo_ro_pct: 100, geo_eu_pct: 0, geo_other_pct: 0, segments: [{ sector: 'sanatate-farma', pct: 100 }], source_url: 'https://x.ro/r.pdf' };
  assert.deepEqual(validateFinancials([good], ctx), { ok: true });
  const bad = (m, re) => { const r = validateFinancials([{ ...good, ...m }], ctx); assert.ok(!r.ok && r.errors.some(e => re.test(e)), JSON.stringify(r)); };
  bad({ source_url: 'ftp://x' }, /M\.RO 2025.*source_url/);
  bad({ fiscal_year: 1990 }, /fiscal_year/);
  bad({ revenue: -1 }, /revenue/);
  bad({ geo_ro_pct: 80, geo_eu_pct: 40 }, /geo/);
  bad({ ticker: 'X.RO' }, /X\.RO.*unknown/);
  bad({ currency: 'USD' }, /currency/);
  bad({ segments: [{ sector: 'nope', pct: 10 }] }, /segments/);
  const dup = validateFinancials([good, good], ctx);
  assert.ok(!dup.ok && dup.errors.some(e => /twice/.test(e)));
});

test('observed outcomes need a source and a known subject', () => {
  const a = sample();
  const good = [{ version: 1, scenario: 'full', subject: 'M.RO', metric: 'operating_profit_change', period: '2026', observed: -3, source_url: 'https://x.ro/r.pdf' }];
  assert.deepEqual(validateOutcomes(good, [a]), { ok: true });
  assert.ok(!validateOutcomes([{ ...good[0], subject: 'TLV.RO' }], [a]).ok);
  assert.ok(!validateOutcomes([{ ...good[0], version: 2 }], [a]).ok);
  assert.ok(!validateOutcomes([{ ...good[0], source_url: 'http://x' }], [a]).ok);
  assert.ok(!validateOutcomes([{ ...good[0], metric: 'price' }], [a]).ok);
  assert.ok(validateOutcomes([{ ...good[0], subject: 'budget', metric: 'budget_effect' }], [a]).ok);
});

test('the lock: a changed or unlisted analysis is reported', () => {
  const dir = mkdtempSync(join(tmpdir(), 'analyses-'));
  mkdirSync(join(dir, 'sample-measure'));
  writeFileSync(join(dir, 'sample-measure', 'v1.json'), JSON.stringify(sample()));
  const list = loadAnalyses(dir);
  assert.equal(list.length, 1);
  assert.equal(list[0].path, 'sample-measure/v1.json');
  assert.match(list[0].hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(checkLock(list, { 'sample-measure/v1.json': list[0].hash }), []);
  assert.match(checkLock(list, { 'sample-measure/v1.json': '0'.repeat(64) })[0], /changed after publishing/);
  assert.match(checkLock(list, {})[0], /npm run impact:lock/);
  assert.match(checkLock([], { 'gone/v1.json': 'x' })[0], /missing/);
});

test('every analysis in the repo is valid and locked', () => {
  const dir = new URL('../analyses/', import.meta.url).pathname;
  const lock = JSON.parse(readFileSync(join(dir, 'LOCK.json'), 'utf8'));
  const list = loadAnalyses(dir);
  assert.deepEqual(checkLock(list, lock), []);
  for (const a of list) assert.deepEqual(validateAnalysis(a.json, { ...ctx, file: 'analyses/' + a.path }), { ok: true }, a.path);
  const fin = JSON.parse(readFileSync(new URL('../config/company-financials.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateFinancials(fin, ctx), { ok: true });
});
