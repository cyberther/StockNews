import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUniverse, symbolsToFetch } from '../ingest/universe.mjs';
import { runIngest } from '../ingest/run.mjs';

const FLAGS = { following: true, bvb: true, portfolio: true, usMarket: false, euMarket: false, prefetchUnfollowedNews: false, commercialMode: false };
// Tuesday 2026-10-20 08:07Z: Bucharest, Frankfurt and London trade, New York doesn't.
const TUE_EU = new Date('2026-10-20T08:07:00Z');
const TUE_ALL = new Date('2026-10-20T14:07:00Z');
const SAT = new Date('2026-10-24T10:07:00Z');

test('the universe: watchlists, holdings and the top BVB names, once each, valid symbols only', () => {
  const u = buildUniverse({ watchlist: ['AAPL', 'snp.ro', 'AAPL', "x'; drop", 'FOO.XX'], holdings: ['SAP.DE', 'AAPL'], bvbTop: ['TLV.RO', 'SNP.RO'], flags: FLAGS });
  assert.deepEqual(u, ['AAPL', 'SAP.DE', 'SNP.RO', 'TLV.RO']);
  assert.deepEqual(buildUniverse({ watchlist: ['AAPL'], holdings: [], bvbTop: ['TLV.RO'], flags: { ...FLAGS, bvb: false } }), ['AAPL']);
  assert.deepEqual(buildUniverse({ watchlist: [], holdings: ['AAPL'], bvbTop: [], flags: { ...FLAGS, portfolio: false } }), []);
});

test('symbolsToFetch: intraday asks for open markets and ones that closed in the last 30 minutes; eod asks for all', () => {
  const u = ['AAPL', 'SAP.DE', 'SNP.RO'];
  assert.deepEqual(symbolsToFetch(u, 'intraday', TUE_EU), ['SAP.DE', 'SNP.RO']);
  assert.deepEqual(symbolsToFetch(u, 'intraday', new Date('2026-10-20T20:22:00Z')), ['AAPL']);  // 16:22 EDT, just closed
  assert.deepEqual(symbolsToFetch(u, 'intraday', SAT), []);
  assert.deepEqual(symbolsToFetch(u, 'eod', SAT), u);
});

// ---- runIngest with an in-memory database and fake providers
function fakeDb(tables) {
  const t = JSON.parse(JSON.stringify(tables));
  const writes = [];
  return {
    t, writes,
    async read(table) { return (t[table] || []).map(r => ({ ...r })); },
    async upsert(table, rows, opts = {}) {
      writes.push([table, rows]);
      const key = (opts.onConflict || 'id').split(',');
      t[table] = t[table] || [];
      const added = [];
      for (const r of rows) {
        const i = t[table].findIndex(x => key.every(k => x[k] === r[k]));
        if (i < 0) { t[table].push({ ...r }); added.push(r); }
        else if (!opts.ignoreDuplicates) t[table][i] = { ...t[table][i], ...r };
      }
      return opts.ignoreDuplicates ? added : rows;
    },
    async insert(table, rows) { writes.push([table, rows]); (t[table] = t[table] || []).push(...rows); return rows; }
  };
}
function fakeYahoo({ fail = false } = {}) {
  const calls = { quotes: [], recs: [] };
  return { calls, name: 'yahoo', license: 'dev_only', configured: true, supports: () => true,
    async quotes(symbols) { calls.quotes.push(symbols); if (fail) throw new Error('timeout');
      return symbols.map(s => ({ symbol: s, price: 10, change: 1, change_pct: 10, prev_close: 9, currency: 'USD', market_time: TUE_EU.toISOString(), source: 'yahoo', license: 'dev_only', name: s + ' Co' })); },
    async recommendation(sym) { calls.recs.push(sym); return sym === 'AAPL' ? { symbol: 'AAPL', status: 'ok', buy: 3, hold: 1, sell: 0, period: '0m', source: 'yahoo', license: 'dev_only' } : null; } };
}
const story = (related, id, h) => ({ id, related, headline: h || 'Story ' + id, source: 'ZF', url: 'https://zf.ro/' + id, summary: '', datetime: Date.parse('2026-10-20T07:30:00Z') / 1000 });
function fakeNews() {
  const calls = { ro: 0, us: [], eu: [] };
  return { calls, feedCount: { ro: 6, us: 10, eu: 9 },
    async ro() { calls.ro++; return [story('SNP.RO', 'a'), story('TLV.RO', 'b')]; },
    async us(names) { calls.us.push(names); return [story('AAPL', 'c'), story('NVDA', 'd')]; },
    async eu(sym, name) { calls.eu.push(sym); return sym === 'SAP.DE' ? [story('SAP.DE', 'e')] : []; } };
}
const LIMITS = { providers: { yahoo: { perDay: 400 }, feeds: { perDay: 2000 } }, jobs: { intraday: { perRun: 40 }, eod: { perRun: 120 } } };
const base = (o = {}) => {
  const db = o.db || fakeDb({ watchlist: [{ ticker: 'AAPL' }, { ticker: 'SAP.DE' }], holdings: [{ ticker: 'SNP.RO' }], ticker_names: [{ ticker: 'AAPL', name: 'Apple Inc.' }],
    ingest_provider_state: [], ingest_usage: [], market_recommendations: [], stories: [] });
  const yahoo = o.yahoo || fakeYahoo(), news = o.news || fakeNews(), alerts = [];
  return { db, yahoo, news, alerts, args: { job: 'intraday', now: TUE_EU, db, providers: [yahoo], news, flags: FLAGS, limits: LIMITS, bvbTop: ['TLV.RO'],
    meter: { counts: () => ({ yahoo: 3 }) }, alerts: async n => alerts.push(n), ...o.args } };
};

test('intraday with every market closed: no provider and no feed is called, and the run is recorded', async () => {
  const b = base({ args: { now: SAT } });
  const s = await runIngest(b.args);
  assert.equal(b.yahoo.calls.quotes.length, 0);
  assert.equal(b.news.calls.ro, 0);
  assert.equal(s.symbols, 0);
  assert.equal(b.db.t.ingest_runs.length, 1);
  assert.equal(b.db.t.ingest_runs[0].ok, true);
});

test('intraday: one batch for the open markets\' symbols, written with their licence', async () => {
  const b = base();
  const s = await runIngest(b.args);
  assert.deepEqual(b.yahoo.calls.quotes, [['SAP.DE', 'SNP.RO', 'TLV.RO']]);
  assert.deepEqual(b.db.t.market_quotes.map(q => [q.symbol, q.license]).sort(), [['SAP.DE', 'dev_only'], ['SNP.RO', 'dev_only'], ['TLV.RO', 'dev_only']]);
  assert.ok(b.db.t.market_quotes.every(q => q.fetched_at === TUE_EU.toISOString()));
  // The company name travels with the price, so the apps need no profile lookups.
  assert.equal(b.db.t.market_quotes.find(q => q.symbol === 'SAP.DE').name, 'SAP.DE Co');
  // Names learnt from the quotes go to ticker_names.
  assert.ok(b.db.t.ticker_names.some(r => r.ticker === 'SAP.DE' && r.name === 'SAP.DE Co'));
  assert.equal(s.quotes, 3);
  assert.deepEqual(b.db.t.ingest_runs[0].requests, { yahoo: 3 });
});

test('news: the BVB press, and followed companies only; the on-hold tab feeds are not stored', async () => {
  const b = base({ args: { now: TUE_ALL } });
  const s = await runIngest(b.args);
  const ids = b.db.t.stories.map(x => x.id).sort();
  // SNP.RO and TLV.RO from the BVB press; AAPL (followed) but not NVDA from the US press; SAP.DE followed.
  assert.deepEqual(ids, ['AAPL:c', 'SAP.DE:e', 'SNP.RO:a', 'TLV.RO:b']);
  assert.deepEqual(b.news.calls.us, [{ AAPL: 'Apple Inc.' }]);
  assert.deepEqual(b.news.calls.eu, ['SAP.DE']);
  assert.equal(s.newStories, 4);
  assert.deepEqual(b.alerts, [4]);
  // A second run finds nothing new and sends no alert.
  const again = await runIngest(b.args);
  assert.equal(again.newStories, 0);
  assert.deepEqual(b.alerts, [4]);
});

test('with the BVB module off, no Bucharest press feed is read', async () => {
  const b = base({ args: { flags: { ...FLAGS, bvb: false } } });
  await runIngest(b.args);
  assert.equal(b.news.calls.ro, 0);
});

test('a failing provider: the run finishes, the failure is counted, nothing is retried', async () => {
  const yahoo = fakeYahoo({ fail: true });
  const b = base({ yahoo });
  const s = await runIngest(b.args);
  assert.equal(yahoo.calls.quotes.length, 1);
  assert.equal(s.ok, false);
  assert.match(s.errors.join(), /yahoo.*timeout/);
  assert.equal(b.db.t.ingest_provider_state[0].fails, 1);
  // Stories still came in.
  assert.ok(b.db.t.stories.length > 0);
});

test('an open breaker skips the provider without calling it', async () => {
  const b = base();
  b.db.t.ingest_provider_state.push({ provider: 'yahoo', fails: 3, open_until: new Date(TUE_EU.getTime() + 600000).toISOString(), reason: 'timeout' });
  const s = await runIngest(b.args);
  assert.equal(b.yahoo.calls.quotes.length, 0);
  assert.match(s.errors.join(), /yahoo.*circuit open/);
});

test('eod: recommendations for US symbols only, none remembered for 24 hours, fresh ones not asked again', async () => {
  const db = fakeDb({ watchlist: [{ ticker: 'AAPL' }, { ticker: 'MSFT' }, { ticker: 'BMW.DE' }, { ticker: 'OKLO' }], holdings: [], ticker_names: [],
    ingest_provider_state: [], ingest_usage: [], stories: [],
    market_recommendations: [{ symbol: 'OKLO', status: 'none', fetched_at: new Date(SAT.getTime() - 3600000).toISOString(), source: 'yahoo', license: 'dev_only' }] });
  const b = base({ db, args: { job: 'eod', now: SAT } });
  await runIngest({ ...b.args, db });
  assert.deepEqual(b.yahoo.calls.recs.sort(), ['AAPL', 'MSFT']);
  const by = Object.fromEntries(db.t.market_recommendations.map(r => [r.symbol, r]));
  assert.equal(by.AAPL.status, 'ok');
  assert.equal(by.MSFT.status, 'none');
  assert.equal(by.MSFT.fetched_at, SAT.toISOString());
  assert.equal(by['BMW.DE'], undefined);
});

test('budgets: past the daily limit the provider is skipped and the run says why', async () => {
  const b = base();
  b.db.t.ingest_usage.push({ day: '2026-10-20', provider: 'yahoo', job: 'intraday', calls: 400 });
  const s = await runIngest(b.args);
  assert.equal(b.yahoo.calls.quotes.length, 0);
  assert.match(s.over.join(), /yahoo: 400\/day/);
  // This run's use is added to the day's count.
  const row = b.db.t.ingest_usage.find(r => r.provider === 'feeds');
  assert.ok(row && row.calls > 0);
});

test('commercial mode: dev_only providers are not used', async () => {
  const b = base({ args: { flags: { ...FLAGS, commercialMode: true } } });
  const s = await runIngest(b.args);
  assert.equal(b.yahoo.calls.quotes.length, 0);
  assert.match(s.errors.join(), /no licensed provider/);
});

test('news are read every other run (:07 and :37), not every 15 minutes', async () => {
  const b = base({ args: { now: new Date('2026-10-20T08:22:00Z') } });
  const s = await runIngest(b.args);
  assert.equal(b.news.calls.ro, 0);
  assert.deepEqual(b.news.calls.eu, []);
  assert.equal(s.quotes, 3);   // prices still every run
});

test('each region\'s press is read only while its market trades (or just closed)', async () => {
  // 08:07Z: Europe trades, New York doesn't: Bucharest and EU press, no US press.
  const b = base();
  await runIngest(b.args);
  assert.equal(b.news.calls.ro, 1);
  assert.deepEqual(b.news.calls.eu, ['SAP.DE']);
  assert.deepEqual(b.news.calls.us, []);
  // 20:07Z: only New York (closing at 20:00, just closed): US press only.
  const c = base({ args: { now: new Date('2026-10-20T20:07:00Z') } });
  await runIngest(c.args);
  assert.equal(c.news.calls.ro, 0);
  assert.deepEqual(c.news.calls.eu, []);
  assert.equal(c.news.calls.us.length, 1);
});

test('eod reads every region\'s press once', async () => {
  const b = base({ args: { job: 'eod', now: new Date('2026-10-20T21:40:00Z') } });
  await runIngest(b.args);
  assert.equal(b.news.calls.ro, 1);
  assert.equal(b.news.calls.us.length, 1);
  assert.deepEqual(b.news.calls.eu, ['SAP.DE']);
});
