// Command line for the ingestion jobs (.github/workflows/ingest.yml):
//
//   node ingest/main.mjs --job=intraday|eod
//     env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (GitHub secrets),
//          SCAN_URL, SCAN_SECRET (optional: push alerts through the scan Edge Function)
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

const arg = name => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const has = name => process.argv.includes(`--${name}`);
const readJson = p => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));

const job = arg('job');
if (job !== 'intraday' && job !== 'eod') { console.error('usage: node ingest/main.mjs --job=intraday|eod [--dry-run --watchlist=A,B]'); process.exit(2); }
const flags = readJson('../config/flags.json');
const limits = readJson('../config/budgets.json');
const now = arg('now') ? new Date(arg('now')) : new Date();

const plainFetch = globalThis.fetch;
const meter = countingFetch(plainFetch);
// The press feed readers use the global fetch: counted too.
globalThis.fetch = meter.fetch;

function memoryDb(seed) {
  const t = { ingest_provider_state: [], ingest_usage: [], ticker_names: [], market_recommendations: [], stories: [], ...seed };
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

const summary = await runIngest({ job, now, db, providers, news: pressNews, flags, limits, bvbTop: BVB_TOP, meter, alerts });
const out = { ...summary, dryRun: dry, at: now.toISOString() };
if (dry) out.sample = { quotes: (db.t.market_quotes || []).slice(0, 5), stories: (db.t.stories || []).length };
console.log(JSON.stringify(out, null, 2));
writeFileSync('summary.json', JSON.stringify(out));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
  `### ingest ${job}\n\n| symbols | quotes | new stories | recs | outside requests | ok |\n|---|---|---|---|---|---|\n` +
  `| ${out.symbols} | ${out.quotes} | ${out.newStories} | ${out.recs} | ${JSON.stringify(out.requests)} | ${out.ok} |\n\n` +
  (out.errors.length ? 'Errors:\n\n' + out.errors.map(e => '- ' + e).join('\n') + '\n' : '') +
  (out.over.length ? 'Over budget:\n\n' + out.over.map(e => '- ' + e).join('\n') + '\n' : ''));
