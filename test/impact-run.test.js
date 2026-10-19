import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { runImpact } from '../ingest/impact/run.mjs';
import { catalogTickers } from '../ingest/impact/schema.mjs';

const taxonomy = JSON.parse(readFileSync(new URL('../config/policy-taxonomy.json', import.meta.url), 'utf8'));
const sampleRaw = readFileSync(new URL('./fixtures/impact/sample-v1.json', import.meta.url), 'utf8');
const sha = s => createHash('sha256').update(s).digest('hex');
const NOW = new Date('2026-10-19T21:40:00Z');
const FIN = [{ ticker: 'M.RO', fiscal_year: 2025, currency: 'RON', revenue: 1000, operating_profit: 150, net_profit: 90,
  geo_ro_pct: null, geo_eu_pct: null, geo_other_pct: null, segments: [], source_url: 'https://x.ro/m.pdf' }];

function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'analyses-')), lock = {};
  for (const [path, raw] of Object.entries(files)) {
    mkdirSync(join(dir, path.split('/')[0]), { recursive: true });
    writeFileSync(join(dir, path), raw);
    if (!path.endsWith('outcomes.json')) lock[path] = sha(raw);
  }
  writeFileSync(join(dir, 'LOCK.json'), JSON.stringify(lock));
  return dir;
}
function fakeDb(seed = {}) {
  const t = { policy_events: [{ id: 'cdep:1' }], impact_analyses: [], impact_results: [], impact_outcomes: [], company_financials: [], ingest_runs: [], ...seed };
  const writes = [];
  return { t, writes,
    async read(table) { return t[table].map(r => ({ ...r })); },
    async upsert(table, rows) { writes.push(table); t[table].push(...rows.map(r => ({ ...r }))); return rows; },
    async insert(table, rows) { writes.push(table); t[table].push(...rows.map(r => ({ ...r }))); return rows; } };
}
const args = (db, dir, extra) => ({ db, dir, financials: FIN, taxonomy, tickers: catalogTickers(), now: NOW, ...extra });

test('a new analysis is stored whole, with its results frozen under the engine version', async () => {
  const db = fakeDb(), dir = repo({ 'sample-measure/v1.json': sampleRaw });
  const s = await runImpact(args(db, dir));
  assert.deepEqual(s.errors, []);
  assert.equal(s.inserted, 1);
  const a = db.t.impact_analyses[0];
  assert.equal(a.id, 'sample-measure');
  assert.equal(a.content_hash, sha(sampleRaw));
  assert.deepEqual(a.events, ['cdep:1']);
  assert.deepEqual(a.body, JSON.parse(sampleRaw));
  // budget + M.RO in three scenarios; SNP.RO has no figures: no rows for it.
  assert.equal(db.t.impact_results.length, 6);
  assert.ok(db.t.impact_results.every(r => r.engine_version === '1.0.0' && r.formula.length > 10));
  const m = db.t.impact_results.find(r => r.subject === 'M.RO' && r.scenario === 'full');
  assert.equal(m.vals.profitDelta, -4.8);
  assert.equal(m.vals.formula, undefined, 'the formula is its own column');
  assert.equal(db.t.company_financials[0].verified, true);
  assert.equal(db.t.company_financials[0].provenance, 'manual');
});

test('a second run writes nothing', async () => {
  const db = fakeDb(), dir = repo({ 'sample-measure/v1.json': sampleRaw });
  await runImpact(args(db, dir));
  db.writes.length = 0;
  const s = await runImpact(args(db, dir));
  assert.deepEqual(s.errors, []);
  assert.deepEqual(db.writes, []);
});

test('a published version whose content changed is refused, nothing written', async () => {
  const db = fakeDb({ impact_analyses: [{ id: 'sample-measure', version: 1, content_hash: '0'.repeat(64) }] });
  const dir = repo({ 'sample-measure/v1.json': sampleRaw });
  const s = await runImpact(args(db, dir, { financials: [] }));
  assert.ok(s.errors.some(e => /sample-measure v1 changed after publishing/.test(e)), s.errors.join());
  assert.deepEqual(db.writes, []);
});

test('an invalid or unlocked file is reported by name; the others still go in', async () => {
  const bad = JSON.parse(sampleRaw); bad.id = 'bad-one'; bad.assumptions[1].value = 150;
  const other = JSON.parse(sampleRaw); other.id = 'other-one';
  const db = fakeDb(), dir = repo({ 'bad-one/v1.json': JSON.stringify(bad), 'other-one/v1.json': JSON.stringify(other), 'sample-measure/v1.json': sampleRaw });
  writeFileSync(join(dir, 'LOCK.json'), JSON.stringify({ 'bad-one/v1.json': sha(JSON.stringify(bad)), 'other-one/v1.json': sha(JSON.stringify(other)) }));
  const s = await runImpact(args(db, dir));
  assert.ok(s.errors.some(e => /bad-one\/v1\.json: assumptions\.funded_pct/.test(e)), s.errors.join('\n'));
  assert.ok(s.errors.some(e => /sample-measure\/v1\.json is not in analyses\/LOCK\.json/.test(e)));
  assert.deepEqual(db.t.impact_analyses.map(a => a.id), ['other-one']);
});

test('an analysis about events not stored yet waits', async () => {
  const db = fakeDb({ policy_events: [] }), dir = repo({ 'sample-measure/v1.json': sampleRaw });
  const s = await runImpact(args(db, dir));
  assert.ok(s.errors.some(e => /sample-measure v1: event cdep:1 is not in policy_events/.test(e)));
  assert.equal(db.t.impact_analyses.length, 0);
});

test('figures added later give the missing results, never touching the frozen ones', async () => {
  const db = fakeDb(), dir = repo({ 'sample-measure/v1.json': sampleRaw });
  await runImpact(args(db, dir));
  const snp = { ...FIN[0], ticker: 'SNP.RO', source_url: 'https://x.ro/s.pdf' };
  const s = await runImpact(args(db, dir, { financials: [...FIN, snp] }));
  assert.equal(s.results, 3);
  assert.equal(db.t.impact_results.filter(r => r.subject === 'SNP.RO').length, 3);
  assert.equal(db.t.impact_results.length, 9);
});

test('observed outcomes are stored once; invalid ones are reported', async () => {
  const out = [{ version: 1, scenario: 'full', subject: 'M.RO', metric: 'operating_profit_change', period: '2026', observed: -4, source_url: 'https://x.ro/r.pdf' },
    { version: 1, scenario: 'full', subject: 'TLV.RO', metric: 'operating_profit_change', period: '2026', observed: 1, source_url: 'https://x.ro/r.pdf' }];
  const db = fakeDb(), dir = repo({ 'sample-measure/v1.json': sampleRaw, 'sample-measure/outcomes.json': JSON.stringify([out[0]]) });
  const s = await runImpact(args(db, dir));
  assert.equal(s.outcomes, 1);
  assert.equal(db.t.impact_outcomes[0].analysis_id, 'sample-measure');
  const dir2 = repo({ 'sample-measure/v1.json': sampleRaw, 'sample-measure/outcomes.json': JSON.stringify(out) });
  const s2 = await runImpact(args(fakeDb(), dir2));
  assert.ok(s2.errors.some(e => /sample-measure outcomes.*TLV\.RO/.test(e)));
});

test('invalid financials are reported and not written', async () => {
  const db = fakeDb(), dir = repo({});
  const s = await runImpact(args(db, dir, { financials: [{ ...FIN[0], source_url: 'http://x' }] }));
  assert.ok(s.errors.some(e => /financials: M\.RO 2025: source_url/.test(e)));
  assert.equal(db.t.company_financials.length, 0);
});
