// The impact job (node ingest/main.mjs --job=impact; the eod job runs it after the policy
// sources): checks the files in analyses/ and config/company-financials.json, stores what is
// new and works out the results with the engine (templates/shared/hif-impact.js), frozen under
// its ENGINE_VERSION. Nothing is ever updated or deleted: a published version whose file
// changed is refused, figures added later only add the results that were missing.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { validateAnalysis, validateFinancials, validateOutcomes, loadAnalyses, loadOutcomes, checkLock } from './schema.mjs';

const I = globalThis.HIFImpact;
const FIN_KEYS = ['currency', 'revenue', 'operating_profit', 'net_profit', 'geo_ro_pct', 'geo_eu_pct', 'geo_other_pct', 'segments', 'source_url'];
const canon = v => JSON.stringify(v, (k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(y => [y, x[y]])) : x);
const same = (a, b) => canon(a ?? null) === canon(b ?? null);
const quoted = ids => 'in.(' + ids.map(i => '"' + String(i).replace(/["\\]/g, '') + '"').join(',') + ')';

export async function runImpact({ db, dir, financials, taxonomy, tickers, now = new Date() }) {
  const errors = [], at = now.toISOString(), ctx = { taxonomy, tickers };
  let inserted = 0, results = 0, outcomes = 0, figures = 0;

  // Companies' figures: checked in review (the pull request), so stored as verified.
  const fin = validateFinancials(financials, ctx);
  const verifiedFin = fin.ok ? financials.map(r => ({ ...r, verified: true })) : [];
  if (!fin.ok) errors.push(...fin.errors.map(e => 'financials: ' + e));
  else if (financials.length) {
    const stored = new Map((await db.read('company_financials', 'select=ticker,fiscal_year,provenance,verified,' + FIN_KEYS.join(',') + '&provenance=eq.manual'))
      .map(r => [r.ticker + ' ' + r.fiscal_year, r]));
    const rows = verifiedFin.filter(r => { const o = stored.get(r.ticker + ' ' + r.fiscal_year); return !o || !o.verified || !FIN_KEYS.every(k => same(Number.isFinite(+o[k]) && typeof r[k] === 'number' ? +o[k] : o[k], r[k])); })
      .map(r => ({ ticker: r.ticker, fiscal_year: r.fiscal_year, provenance: 'manual', verified: true, updated_at: at, ...Object.fromEntries(FIN_KEYS.map(k => [k, r[k] ?? (k === 'segments' ? [] : null)])) }));
    if (rows.length) { await db.upsert('company_financials', rows, { onConflict: 'ticker,fiscal_year,provenance' }); figures = rows.length; }
  }

  // Analyses: valid and locked only.
  const lockFile = join(dir, 'LOCK.json');
  const lock = existsSync(lockFile) ? JSON.parse(readFileSync(lockFile, 'utf8')) : {};
  const list = loadAnalyses(dir);
  const lockErrors = checkLock(list, lock);
  errors.push(...lockErrors);
  const usable = list.filter(a => {
    if (lockErrors.some(e => e.startsWith(a.path + ' '))) return false;
    const v = validateAnalysis(a.json, { ...ctx, file: a.path });
    if (!v.ok) { errors.push(...v.errors.map(e => a.path + ': ' + e)); return false; }
    return true;
  });
  if (!usable.length) return { analyses: list.length, inserted, results, outcomes, financials: figures, errors };

  const stored = new Map((await db.read('impact_analyses', 'select=id,version,content_hash')).map(r => [r.id + ' v' + r.version, r]));
  const eventIds = [...new Set(usable.flatMap(a => a.json.events))];
  const known = new Set((await db.read('policy_events', 'select=id&id=' + quoted(eventIds))).map(r => r.id));
  const haveResults = new Set((await db.read('impact_results', 'select=analysis_id,version,engine_version,scenario,subject'))
    .map(r => [r.analysis_id, r.version, r.engine_version, r.scenario, r.subject].join('|')));

  const live = [];
  for (const a of usable) {
    const { json } = a, key = json.id + ' v' + json.version, old = stored.get(key);
    if (old) {
      if (old.content_hash !== a.hash) { errors.push(key + ' changed after publishing: publish a new version'); continue; }
      live.push(a);
      continue;
    }
    const missing = json.events.filter(e => !known.has(e));
    if (missing.length) { errors.push(key + ': event ' + missing.join(', ') + ' is not in policy_events yet'); continue; }
    await db.insert('impact_analyses', [{ id: json.id, version: json.version, published_at: json.published_at, title: json.title, policy: json.policy,
      events: json.events, sectors: json.sectors, body: json, content_hash: a.hash, synced_at: at }]);
    inserted++;
    live.push(a);
  }

  // Results: those not stored yet for this engine version (a new analysis, or figures added later).
  for (const a of live) {
    const { json } = a, r = I.run(json, verifiedFin), rows = [];
    const add = (scenario, subject, res) => {
      const k = [json.id, json.version, I.ENGINE_VERSION, scenario, subject].join('|');
      if (haveResults.has(k)) return;
      const { formula, ...vals } = res;
      rows.push({ analysis_id: json.id, version: json.version, engine_version: I.ENGINE_VERSION, scenario, subject, vals, formula, computed_at: at });
      haveResults.add(k);
    };
    I.SCENARIOS.forEach(sc => {
      add(sc, 'budget', r.budget[sc]);
      Object.entries(r.companies).forEach(([t, c]) => { if (!c.missing) add(sc, t, { ...c[sc], fiscal_year: c.fiscal_year, source_url: c.source_url }); });
    });
    if (rows.length) { await db.insert('impact_results', rows); results += rows.length; }
  }

  // Observed outcomes (analyses/<id>/outcomes.json), against the versions stored.
  const ids = [...new Set(live.map(a => a.json.id))];
  if (ids.length) {
    const have = new Set((await db.read('impact_outcomes', 'select=analysis_id,version,scenario,subject,metric,period'))
      .map(o => [o.analysis_id, o.version, o.scenario, o.subject, o.metric, o.period].join('|')));
    for (const id of ids) {
      const rows = loadOutcomes(dir, id);
      if (!rows.length) continue;
      const v = validateOutcomes(rows, live.filter(a => a.json.id === id).map(a => a.json));
      if (!v.ok) { errors.push(...v.errors.map(e => id + ' outcomes: ' + e)); continue; }
      const fresh = rows.map(o => ({ analysis_id: id, version: o.version, scenario: o.scenario, subject: o.subject, metric: o.metric,
        period: String(o.period), observed: o.observed, source_url: o.source_url, recorded_at: at }))
        .filter(o => !have.has([o.analysis_id, o.version, o.scenario, o.subject, o.metric, o.period].join('|')));
      if (fresh.length) { await db.upsert('impact_outcomes', fresh, { onConflict: 'analysis_id,version,scenario,subject,metric,period', ignoreDuplicates: true }); outcomes += fresh.length; }
    }
  }
  return { analyses: list.length, inserted, results, outcomes, financials: figures, errors };
}
