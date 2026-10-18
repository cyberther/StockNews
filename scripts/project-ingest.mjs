// A model, not a measurement: how many outside requests the ingestion makes on one weekday,
// running the real scheduling and gating code (ingest/run.mjs) over every cron slot with
// providers that only count. Per-call costs come from a real dry run (2026-10-18:
// node ingest/main.mjs --job=eod --dry-run ...): Yahoo needs a 2-request cookie/crumb
// handshake per run plus one request per 50 symbols; each press feed is one request.
//
//   node scripts/project-ingest.mjs [--day=2026-10-20] [--watchlist=A,B] [--holdings=C,D]
import { runIngest } from '../ingest/run.mjs';
import { expectedSlots } from '../ingest/health.mjs';
import { BVB_TOP } from '../netlify/functions/_shared/market/bvb-symbols.js';
import { RO_FEEDS } from '../netlify/functions/_shared/market/ro-news.js';
import { US_FEEDS } from '../netlify/functions/_shared/market/us-news.js';
import { EU_FEEDS } from '../netlify/functions/_shared/market/eu-news.js';
import { readFileSync } from 'node:fs';

const arg = (n, d) => { const a = process.argv.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const day = arg('day', '2026-10-20');
const watchlist = arg('watchlist', 'ABAT,ASTS,BMW.DE,BVB.RO,EOSE,FLY,OKLO,SNG.RO,SNP.RO,VRT').split(',');
const holdings = arg('holdings', 'SNP.RO,TLV.RO,OKLO').split(',');
const flags = JSON.parse(readFileSync(new URL('../config/flags.json', import.meta.url)));
const limits = JSON.parse(readFileSync(new URL('../config/budgets.json', import.meta.url)));

const total = { runs: 0, runsWithWork: 0, yahoo: 0, feeds: 0 };
let runYahoo = 0;
const yahoo = { name: 'yahoo', license: 'dev_only', configured: true, supports: () => true,
  async quotes(s) { runYahoo += Math.ceil(s.length / 50); return s.map(symbol => ({ symbol, price: 1, source: 'yahoo', license: 'dev_only' })); },
  async recommendation() { runYahoo += 1; return null; } };
const news = { feedCount: { ro: RO_FEEDS.length, us: US_FEEDS.length, eu: EU_FEEDS.length },
  async ro() { total.feeds += RO_FEEDS.length; return []; }, async us() { total.feeds += US_FEEDS.length; return []; },
  async eu() { return []; } };
// EU feeds are read once per run however many EU symbols are followed.
let euRead = false;
const newsWrapped = { ...news, async eu(s, n) { if (!euRead) { euRead = true; total.feeds += EU_FEEDS.length; } return []; } };
const db = { t: { market_recommendations: [] },
  async read(t) { return t === 'watchlist' ? watchlist.map(ticker => ({ ticker })) : t === 'holdings' ? holdings.map(ticker => ({ ticker })) : (this.t[t] || []); },
  async upsert(t, rows) { if (t === 'market_recommendations') this.t[t] = rows; return []; }, async insert() { return []; } };

const slots = expectedSlots(day).map(s => ['intraday', s]).concat([['eod', day + 'T21:40:00Z']]);
for (const [job, at] of slots) {
  runYahoo = 0; euRead = false;
  const s = await runIngest({ job, now: new Date(at), db, providers: [yahoo], news: newsWrapped, flags, limits, bvbTop: BVB_TOP });
  total.runs++;
  if (runYahoo) { total.runsWithWork++; total.yahoo += runYahoo + 2; }
}
const perDay = total.yahoo + total.feeds;
console.log(JSON.stringify({ day, model: true, watchlist, holdings, ...total, outsideRequestsPerDay: perDay,
  serverlessInvocationsForQuotesAndNews: 0 }, null, 2));
