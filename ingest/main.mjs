// Command line for the ingestion jobs (.github/workflows/ingest.yml):
//
//   node ingest/main.mjs --job=intraday|eod
//     env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (GitHub secrets),
//          SCAN_URL, SCAN_SECRET (optional: push alerts through the scan Edge Function)
//
//   node ingest/main.mjs --job=policy
//     the official policy sources only (ingest/policy/); the eod job runs them too
//
//   node ingest/main.mjs --job=impact
//     the impact analyses and company figures from the repository (ingest/impact/); the eod
//     and policy jobs run it too, after the policy sources
//
//   node ingest/main.mjs --job=intraday --dry-run --watchlist=AAPL,SNP.RO [--now=ISO]
//     real providers and feeds, an in-memory database: shows what a run would fetch and
//     how many outside requests it makes, without any credentials.
//
// Prints a JSON summary (no secrets) and writes summary.json for the workflow's alerts.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { runIngest } from './run.mjs';
import { createDb } from './supabase.mjs';
import { countingFetch } from './meter.mjs';
import { createYahoo, yahooClient } from './providers/yahoo.mjs';
import { eodhd, twelvedata, bvb } from './providers/stubs.mjs';
import { pressNews } from './news.mjs';
import { BVB_TOP } from '../netlify/functions/_shared/market/bvb-symbols.js';
import { runPolicy, relayFetch } from './policy/run.mjs';
import { bvbCatalog } from './policy/classify.mjs';
import { runImpact } from './impact/run.mjs';
import { catalogTickers } from './impact/schema.mjs';

const arg = name => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const has = name => process.argv.includes(`--${name}`);
const readJson = p => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));

const job = arg('job');
if (!['intraday', 'eod', 'policy', 'impact'].includes(job)) { console.error('usage: node ingest/main.mjs --job=intraday|eod|policy|impact [--dry-run --watchlist=A,B]'); process.exit(2); }
const flags = readJson('../config/flags.json');
const limits = readJson('../config/budgets.json');
const now = arg('now') ? new Date(arg('now')) : new Date();

const plainFetch = globalThis.fetch;
const meter = countingFetch(plainFetch);
// The press feed readers use the global fetch: counted too.
globalThis.fetch = meter.fetch;

function memoryDb(seed) {
  const t = { ingest_provider_state: [], ingest_usage: [], ticker_names: [], market_recommendations: [], stories: [], policy_events: [], policy_event_history: [], ...seed };
  return { t,
    async read(table) { return (t[table] || []).slice(); },
    async upsert(table, rows, { onConflict = 'id', ignoreDuplicates } = {}) {
      const keys = onConflict.split(','), out = [];
      t[table] = t[table] || [];
      for (const r of rows) { const i = t[table].findIndex(x => keys.every(k => x[k] === r[k])); if (i < 0) { t[table].push(r); out.push(r); } else if (!ignoreDuplicates) { t[table][i] = { ...t[table][i], ...r }; out.push(r); } }
      return out;
    },
    async insert(table, rows) { (t[table] = t[table] || []).push(...rows); return rows; } };
}

// Secrets piped into GitHub can carry a trailing newline, which no HTTP header accepts.
const env = k => String(process.env[k] || '').trim();
const dry = has('dry-run');
const db = dry
  ? memoryDb({ watchlist: (arg('watchlist') || '').split(',').filter(Boolean).map(ticker => ({ ticker })), holdings: (arg('holdings') || '').split(',').filter(Boolean).map(ticker => ({ ticker })) })
  : createDb({ url: env('SUPABASE_URL'), key: env('SUPABASE_SERVICE_ROLE_KEY'), fetch: plainFetch });

const providers = [createYahoo({ client: await yahooClient(meter.fetch) }), eodhd, twelvedata, bvb];
const scanUrl = env('SCAN_URL'), scanSecret = env('SCAN_SECRET');
const alerts = !dry && scanUrl && scanSecret ? async () => {
  const u = new URL(scanUrl); u.searchParams.set('mode', 'alerts');
  const res = await plainFetch(u, { method: 'POST', headers: { authorization: 'Bearer ' + scanSecret }, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error('scan ' + res.status);
} : null;

const summary = job === 'policy' || job === 'impact' ? { job, ok: true, symbols: 0, quotes: 0, newStories: 0, recs: 0, requests: {}, over: [], errors: [] }
  : await runIngest({ job, now, db, providers, news: pressNews, flags, limits, bvbTop: BVB_TOP, meter, alerts });

// Official policy sources: once a day (eod), or on their own (--job=policy). Their requests are
// counted apart, in their own ingest_runs row.
let policy = null;
if (flags.policy !== false && (job === 'eod' || job === 'policy')) {
  const before = meter.counts(), startedAt = new Date().toISOString();
  const taxonomy = readJson('../config/policy-taxonomy.json');
  // POLICY_RELAY=supabase (the workflow sets it): the Chamber pages through Supabase.
  const relay = !dry && env('POLICY_RELAY') === 'supabase' ? relayFetch(db) : null;
  try { policy = await runPolicy({ db, now, taxonomy, catalog: bvbCatalog(), relay }); }
  catch (e) { policy = { events: 0, created: 0, changed: 0, errors: ['policy: ' + e.message] }; }
  const after = meter.counts(), requests = Object.fromEntries(Object.keys(after).map(k => [k, after[k] - (before[k] || 0)]).filter(([, n]) => n));
  policy.requests = requests;
  await db.insert('ingest_runs', [{ job: 'policy', started_at: startedAt, finished_at: new Date().toISOString(), ok: !policy.errors.length,
    symbols: policy.events, requests, errors: policy.errors.join('\n').slice(0, 4000) || null }]);
}

// Impact analyses (analyses/, config/company-financials.json): after the policy events they refer to.
let impact = null;
if (flags.impact !== false && (job === 'eod' || job === 'policy' || job === 'impact')) {
  const startedAt = new Date().toISOString();
  try {
    impact = await runImpact({ db, now, dir: new URL('../analyses/', import.meta.url).pathname, financials: readJson('../config/company-financials.json'),
      taxonomy: readJson('../config/policy-taxonomy.json'), tickers: catalogTickers() });
  } catch (e) { impact = { analyses: 0, inserted: 0, results: 0, outcomes: 0, financials: 0, errors: ['impact: ' + e.message] }; }
  await db.insert('ingest_runs', [{ job: 'impact', started_at: startedAt, finished_at: new Date().toISOString(), ok: !impact.errors.length,
    symbols: impact.inserted, requests: {}, errors: impact.errors.join('\n').slice(0, 4000) || null }]);
}
// The policy push alerts (new events, status changes, analyses) go out with the stories' alerts
// in the scan Edge Function; this run's events are new, so ask it once more now.
if ((policy || impact) && alerts) {
  try { await alerts(); } catch (e) { (impact || policy).errors.push('alerts: ' + e.message); }
}
const out = { ...summary, policy, impact, dryRun: dry, at: now.toISOString() };
if (dry) out.sample = { quotes: (db.t.market_quotes || []).slice(0, 5), stories: (db.t.stories || []).length,
  policyEvents: (db.t.policy_events || []).length, policyExamples: (db.t.policy_events || []).filter(e => e.sectors.length).slice(0, 3)
    .map(e => ({ id: e.id, status: e.status, title: e.title.slice(0, 90), sectors: e.sectors, companies: e.companies.slice(0, 3) })) };
console.log(JSON.stringify(out, null, 2));
writeFileSync('summary.json', JSON.stringify(out));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
  `### ingest ${job}\n\n| symbols | quotes | new stories | recs | outside requests | ok |\n|---|---|---|---|---|---|\n` +
  `| ${out.symbols} | ${out.quotes} | ${out.newStories} | ${out.recs} | ${JSON.stringify(out.requests)} | ${out.ok} |\n\n` +
  (out.errors.length ? 'Errors:\n\n' + out.errors.map(e => '- ' + e).join('\n') + '\n' : '') +
  (out.over.length ? 'Over budget:\n\n' + out.over.map(e => '- ' + e).join('\n') + '\n' : '') +
  (impact ? `\n### impact\n\n| analyses | new | results | outcomes | figures | errors |\n|---|---|---|---|---|---|\n| ${impact.analyses} | ${impact.inserted} | ${impact.results} | ${impact.outcomes} | ${impact.financials} | ${impact.errors.length} |\n` + impact.errors.map(e => '- ' + e).join('\n') + '\n' : '') +
  (policy ? `\n### policy\n\n| events | new | changed | requests | errors |\n|---|---|---|---|---|\n| ${policy.events} | ${policy.created} | ${policy.changed} | ${JSON.stringify(policy.requests)} | ${policy.errors.length} |\n` : ''));
