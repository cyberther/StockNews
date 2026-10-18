// One ingestion run (GitHub Actions, .github/workflows/ingest.yml):
//   node ingest/run.mjs --job=intraday   every 15 minutes while a market trades
//   node ingest/run.mjs --job=eod        once after New York's close
//
// It reads who follows and holds what, asks the providers for the prices of the markets
// that are trading in one batch, reads the press feeds once for the followed companies and
// the BVB tab, writes everything to Supabase, and asks the scan Edge Function to send push
// alerts for the stories that are new. Recommendations are read in the eod run only.
// Circuit breaker and budgets as in breaker.mjs and budget.mjs; nothing is retried in a run.
import { buildUniverse, symbolsToFetch, marketOf, tradingOrJustClosed } from './universe.mjs';
import { providersFor } from './providers/index.mjs';
import { createBreaker } from './breaker.mjs';
import { createBudget } from './budget.mjs';

const DAY_MS = 86400000;
const NEWS_WINDOW_MS = 2 * DAY_MS;
const QUOTE_BATCH = 50;

export async function runIngest({ job, now = new Date(), db, providers, news, flags, limits, bvbTop = [], meter, alerts, log = () => {} }) {
  const startedAt = now.toISOString(), day = startedAt.slice(0, 10), errors = [];
  const [wl, hd, nameRows, state, usage] = await Promise.all([
    db.read('watchlist', 'select=ticker'),
    db.read('holdings', 'select=ticker'),
    db.read('ticker_names', 'select=ticker,name'),
    db.read('ingest_provider_state', 'select=*'),
    db.read('ingest_usage', `select=*&day=eq.${day}`)
  ]);
  const watchlist = wl.map(r => r.ticker), holdings = hd.map(r => r.ticker);
  const universe = buildUniverse({ watchlist, holdings, bvbTop, flags });
  // Followed: on someone's watchlist or in someone's portfolio (not just the BVB top list).
  const followed = buildUniverse({ watchlist, holdings, bvbTop: [], flags });
  const symbols = symbolsToFetch(universe, job, now);
  const breaker = createBreaker(state, now.getTime());
  const budget = createBudget(limits, usage, day);
  const names = new Map(nameRows.filter(r => r.name).map(r => [r.ticker, r.name]));
  let quotes = 0, newStories = 0, recs = 0;

  if (symbols.length) {
    // ---- quotes: the first provider that answers; one batch per 50 symbols
    const list = providersFor('quotes', { providers, commercialMode: !!flags.commercialMode });
    if (!list.length) errors.push('quotes: no licensed provider configured (commercialMode)');
    for (const p of list) {
      if (!breaker.allowed(p.name)) { errors.push(`${p.name}: circuit open`); continue; }
      if (!budget.take(p.name, job, Math.ceil(symbols.length / QUOTE_BATCH))) continue;
      try {
        const rows = await p.quotes(symbols);
        breaker.success(p.name);
        const newNames = rows.filter(r => r.name && !names.has(r.symbol)).map(r => ({ ticker: r.symbol, name: r.name, updated_at: startedAt }));
        newNames.forEach(r => names.set(r.ticker, r.name));
        if (rows.length) await db.upsert('market_quotes', rows.map(q => ({ ...q, name: q.name || names.get(q.symbol) || null, fetched_at: startedAt })), { onConflict: 'symbol' });
        if (newNames.length) await db.upsert('ticker_names', newNames, { onConflict: 'ticker' });
        quotes = rows.length;
        break;
      } catch (e) {
        breaker.failure(p.name, e.message);
        errors.push(`${p.name}: ${e.message}`);
      }
    }
    // ---- news: every other intraday run (:07 and :37), and in the eod run
    if (job === 'eod' || newsSlot(now)) {
      try { newStories = await ingestNews({ db, news, flags, job, budget, followed, names, now, errors }); }
      catch (e) { errors.push('news: ' + e.message); }
    }
  }

  if (job === 'eod') {
    try { recs = await ingestRecommendations({ db, providers, flags, breaker, budget, followed, startedAt, now, errors }); }
    catch (e) { errors.push('recommendations: ' + e.message); }
  }

  if (newStories && alerts) {
    try { await alerts(newStories); } catch (e) { errors.push('alerts: ' + e.message); }
  }

  const changes = breaker.changes().map(r => ({ ...r, updated_at: startedAt }));
  if (changes.length) await db.upsert('ingest_provider_state', changes, { onConflict: 'provider' });
  const used = budget.usage().map(u => {
    const before = usage.find(r => r.day === u.day && r.provider === u.provider && r.job === u.job);
    return { ...u, calls: u.calls + (before ? before.calls : 0) };
  });
  if (used.length) await db.upsert('ingest_usage', used, { onConflict: 'day,provider,job' });
  const over = budget.over();
  const summary = { job, ok: !errors.length, symbols: symbols.length, quotes, newStories, recs,
    requests: meter ? meter.counts() : {}, over, errors };
  await db.insert('ingest_runs', [{ job, started_at: startedAt, finished_at: new Date().toISOString(), ok: summary.ok,
    symbols: symbols.length, requests: summary.requests, errors: errors.concat(over.map(o => 'budget ' + o)).join('\n').slice(0, 4000) || null }]);
  log({ evt: 'ingest.run', ...summary });
  return summary;
}

// Stories in public.stories, with ids as the scan made them (<TICKER>:<story id>), so the
// AI summaries already written stay attached. Returns how many were new.
// The runs at :07 and :37 (the cron is :07 :22 :37 :52): news every 30 minutes.
const newsSlot = now => Math.floor(now.getUTCMinutes() / 15) % 2 === 0;

// Each region's press is read while its market trades or just closed, and in the eod run.
async function ingestNews({ db, news, flags, job, budget, followed, names, now, errors }) {
  const since = now.getTime() - NEWS_WINDOW_MS, found = [];
  const region = (...markets) => job === 'eod' || markets.some(m => tradingOrJustClosed(m, now));
  const want = new Set(followed);
  const keep = (items, ok) => (items || []).filter(n => n && n.id && n.headline && n.datetime * 1000 > since && ok(n.related)).forEach(n => found.push(row(n)));

  // The BVB tab: every Bucharest press story that names a listed company.
  if (flags.bvb !== false && region('BVB') && budget.take('feeds', job, news.feedCount.ro)) keep(await news.ro(), t => /\.RO$/.test(t || ''));
  // Followed US companies: press releases and press stories naming them.
  const us = followed.filter(s => marketOf(s) === 'US');
  if (us.length && region('US') && budget.take('feeds', job, news.feedCount.us)) {
    const named = Object.fromEntries(us.filter(s => names.has(s)).map(s => [s, names.get(s)]));
    keep(await news.us(named), t => want.has(t));
  }
  // Followed German and British companies.
  const eu = followed.filter(s => /\.(DE|L)$/.test(s));
  if (eu.length && region('XETRA', 'LSE') && budget.take('feeds', job, news.feedCount.eu)) {
    for (const s of eu) keep(await news.eu(s, names.get(s) || ''), t => t === s);
  }
  // Followed Bucharest companies are in the BVB press already; when the BVB tab is off they
  // would still need theirs (not the case in Phase A: bvb is on).
  if (!found.length) return 0;
  const unique = [...new Map(found.map(r => [r.id, r])).values()];
  const added = await db.upsert('stories', unique, { onConflict: 'id', ignoreDuplicates: true });
  return added.length;
}
const clip = (s, n) => (s ? String(s).replace(/\s+/g, ' ').trim().slice(0, n) : null);
function row(n) {
  return { id: `${n.related}:${n.id}`, ticker: n.related, headline: clip(n.headline, 500), source: clip(n.source, 120),
    url: /^https?:\/\//.test(n.url || '') ? String(n.url).slice(0, 1000) : null, summary: clip(n.summary, 400),
    published_at: new Date(n.datetime * 1000).toISOString() };
}

// Analyst recommendation counts for followed US companies, read at most once a day each.
// "Nothing there" and failures are remembered for 24 hours too (status 'none').
async function ingestRecommendations({ db, providers, flags, breaker, budget, followed, startedAt, now, errors }) {
  const list = providersFor('recommendation', { providers, commercialMode: !!flags.commercialMode });
  if (!list.length) return 0;
  const have = new Map((await db.read('market_recommendations', 'select=symbol,fetched_at')).map(r => [r.symbol, Date.parse(r.fetched_at)]));
  const due = followed.filter(s => marketOf(s) === 'US' && !(have.get(s) > now.getTime() - DAY_MS));
  const rows = [];
  for (const sym of due) {
    const p = list.find(x => breaker.allowed(x.name));
    if (!p) { errors.push('recommendations: circuit open'); break; }
    if (!budget.take(p.name, 'eod', 1)) break;
    let r = null;
    try { r = await p.recommendation(sym); breaker.success(p.name); }
    catch (e) { breaker.failure(p.name, e.message); errors.push(`${p.name} recommendation ${sym}: ${e.message}`); }
    rows.push({ ...(r || { symbol: sym, status: 'none', buy: null, hold: null, sell: null, period: null, source: p.name, license: p.license }), fetched_at: startedAt });
  }
  if (rows.length) await db.upsert('market_recommendations', rows, { onConflict: 'symbol' });
  return rows.length;
}
