import { failurePolicy } from './filings-retry.mjs';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runFilings, parseJson } from './filings-extract.mjs';

const ROOT = '/home/yoda/Documents/Codex/2026-10-22/inst/outputs';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const sameFigures = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const atomic = (path, value) => { writeFileSync(path + '.tmp', value); renameSync(path + '.tmp', path); };
export function auditCounts(state) {
  const counts = { unchanged: 0, differences: 0, unverifiable: 0 };
  for (const result of Object.values(state.results)) counts[result.outcome]++;
  return { total: state.total, processed: Object.keys(state.results).length,
    remaining: state.total - Object.keys(state.results).length, ...counts };
}

// A finite, resumable audit of the saved snapshot. Every RPC is intercepted locally:
// historical data is NEVER overwritten by a different/failed new extraction.
export async function runHistoricalAudit(limit, deps, paths = {}) {
  const snapshotPath = paths.snapshot || ROOT + '/audit-istoric-snapshot.json';
  const statePath = paths.state || ROOT + '/audit-istoric-progres.json';
  const reportPath = paths.report || ROOT + '/audit-istoric-raport.md';
  const warningPath = paths.warnings || ROOT + '/audit-istoric-semnalari.json';
  const warnings = existsSync(warningPath) ? JSON.parse(readFileSync(warningPath, 'utf8')) : {};
  if (!limit || !existsSync(snapshotPath)) return { pending: false, processed: 0 };
  const raw = readFileSync(snapshotPath, 'utf8'), snapshot = JSON.parse(raw);
  const hash = createHash('sha256').update(raw).digest('hex');
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8'))
    : { version: 1, snapshotHash: hash, startedAt: new Date().toISOString(), total: snapshot.rows.length, results: {} };
  if (state.snapshotHash !== hash) throw new Error('Audit snapshot changed; preserve old state and review before restarting');
  if (deps.extractionVersion && state.extractionVersion !== deps.extractionVersion) {
    state.previousRuns ||= [];
    if (Object.keys(state.results).length) state.previousRuns.push({ extractionVersion: state.extractionVersion || 'legacy', results: state.results, archivedAt: new Date().toISOString() });
    state.results = {}; state.retries = {}; state.attempts = {}; state.current = null; state.lastDeferred = null;
    state.extractionVersion = deps.extractionVersion;
  }
  state.attempts ||= {};
  state.retries ||= {};
  const persist = () => {
    state.updatedAt = new Date().toISOString(); state.counts = auditCounts(state);
    state.status = state.counts.remaining ? 'running' : (state.counts.differences || state.counts.unverifiable ? 'completed_with_findings' : 'completed');
    atomic(statePath, JSON.stringify(state, null, 2));
    const c = state.counts;
    const findings = Object.values(state.results).filter(r => r.outcome !== 'unchanged');
    const safe = s => String(s || '').replace(/[|\r\n]/g, ' ');
    atomic(reportPath, `# Audit istoric Market Pulse\n\nActualizat: ${state.updatedAt}\n\n` +
      `Procesate: ${c.processed}/${c.total}; rămase: ${c.remaining}.\n\n` +
      `Reextragere identică: ${c.unchanged}; diferențe de revizuit: ${c.differences}; neverificabile: ${c.unverifiable}.\n\n` +
      `Datele istorice sunt păstrate intacte. O reextragere identică nu dovedește singură corectitudinea tuturor cifrelor. ` +
      `Diferențele sunt propuneri de revizuire, nu corecții aplicate. Sursa de astăzi poate diferi de cea citită inițial. ` +
      `Se verifică primele opt pagini; versiunea ${deps.extractionVersion || 'legacy'} ${deps.pageAwareOcr ? 'păstrează textul complet și verifică bugetul de tokeni, fără trunchiere' : 'folosește limita veche de text'}. Documentele inaccesibile sau prea mari sunt raportate, nu declarate confirmate. ` +
      `Acesta verifică rezultatele salvate în filings, nu rezumatele știrilor sau analizele de politici.\n\n` +
      `## Cazuri de revizuit\n\n| ID | Simbol | Tip | Rezultat | Motiv |\n|---|---|---|---|---|\n` +
      findings.map(r => `| ${r.id} | ${safe(r.ticker)} | ${r.kind} | ${r.outcome} | ${safe(r.reason)} |`).join('\n') + '\n\n' +
      `Detaliile, rezultatele vechi/noi și dovezile disponibile se află în audit-istoric-progres.json. ` +
      `Snapshotul integral este audit-istoric-snapshot.json. Rezultatele auditului nu sunt aplicate automat în baza de date.\n`);
  };
  persist();
  let processed = 0, attempted = 0;
  for (const row of snapshot.rows) {
    if (state.results[row.id]) continue;
    if (attempted >= limit || (deps.deadline && Date.now() >= deps.deadline)) break;
    if (warnings[row.id] && !deps.pageAwareOcr) {
      state.results[row.id] = { id: row.id, ticker: row.ticker, kind: row.kind, url: row.url,
        outcome: 'unverifiable', oldData: row.data, newData: null, extractionStatus: 'known_ocr_gap',
        reason: warnings[row.id], provenance: 'audit-istoric-semnalari.json; visual PDF review and OCR benchmark',
        completedAt: new Date().toISOString() };
      processed++; attempted++; persist(); deps.log('historical audit: known OCR gap needs review', row.id); continue;
    }
    if (state.retries[row.id]?.nextAttemptAt > Date.now()) continue;
    attempted++;
    state.attempts[row.id] = (state.attempts[row.id] || 0) + 1;
    state.current = { id: row.id, ticker: row.ticker, startedAt: new Date().toISOString() }; persist();
    const start = Date.now(), diagnostics = [], evidence = [];
    let saved = null, sourceHash = null, failure = null;
    await runFilings(1, { ...deps, observationOrigin: 'historical_audit', retry: null, onFailure: error => { failure = error; },
      // No network RPC is possible from this audit, including filings_save.
      rpc: async (fn, body) => {
        if (fn === 'filings_pending') return [row];
        if (fn !== 'filings_save') throw new Error('Unexpected audit RPC: ' + fn);
        saved = body; return 1;
      },
      log: (...args) => { diagnostics.push(args.join(' ')); deps.log('historical audit:', ...args); },
      httpGet: async (...args) => {
        const response = await deps.httpGet(...args);
        sourceHash = createHash('sha256').update(response.body).digest('hex'); return response;
      },
      postJson: async (...args) => {
        const response = await deps.postJson(...args);
        if (response.status === 200) {
          try { const parsed = JSON.parse(response.body); const data = parseJson(parsed.choices?.[0]?.message?.content);
            evidence.push({ status: data?.status, status_evidence: data?.status_evidence,
              consolidated: data?.consolidated, consolidated_evidence: data?.consolidated_evidence }); } catch {}
        }
        return response;
      }
    });
    if (!saved && diagnostics.some(line => line.includes('time is up for this run'))) {
      state.attempts[row.id]--; state.current = null; persist(); break;
    }
    if (!saved || saved.p_status === 'failed') {
      const policy = failurePolicy(failure || new Error(diagnostics.at(-1) || 'Extraction requires review'), state.attempts[row.id]);
      state.retries[row.id] = policy;
      if (policy.retryable) {
        state.current = null; state.lastDeferred = { id: row.id, ...policy };
        persist(); deps.log('historical audit: deferred', row.id, JSON.stringify(policy)); continue;
      }
    }
    const outcome = saved?.p_status === 'ok' ? sameFigures(row.data, saved.p_data) ? 'unchanged' : 'differences' : 'unverifiable';
    state.results[row.id] = { id: row.id, ticker: row.ticker, kind: row.kind, url: row.url,
      outcome, extractionVersion: deps.extractionVersion || 'legacy', previousOcrConcern: warnings[row.id] || null, oldData: row.data, newData: saved?.p_status === 'ok' ? saved.p_data : null,
      extractionStatus: saved?.p_status || 'error', evidence, sourceHash,
      reason: outcome === 'differences' ? 'Reextragerea diferă; necesită revizuire în sursă' : outcome === 'unverifiable' ? diagnostics.at(-1) || 'No verified extraction' : '',
      diagnostics: diagnostics.slice(-10), seconds: (Date.now() - start) / 1000, completedAt: new Date().toISOString() };
    state.current = null; processed++; persist();
    deps.log('historical audit progress:', JSON.stringify(state.counts));
  }
  return { pending: state.counts.remaining > 0, processed, counts: state.counts };
}
