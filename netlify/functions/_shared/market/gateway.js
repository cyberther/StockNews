// Market data gateway behind /api/finnhub (Netlify function and the local servers).
//
// A request names a capability (quote, news, chart, ...). For each capability there is an
// ordered list of providers; the first one that is configured, not cooling down and not
// failing answers. Around that:
//   - in-memory cache per capability, plus Netlify's CDN cache (keyed on the query);
//   - identical requests in flight share one upstream call;
//   - a provider that rate-limits us (429) or keeps failing is skipped for a while;
//   - when every provider fails, the last good answer is served, marked stale;
//   - /quotes?symbols=A,B,C answers many quotes in one request;
//   - each provider is paced under its per-minute limit, and with a shared usage store
//     (Supabase, see usage-store.js) under its daily cap across all instances.
// Replies keep each provider's own shape, which is what hif-live.js reads today.
// Keys come from the caller (env vars) and appear only on upstream URLs: never in cache
// keys, logs or responses.
import { finnhub } from './providers/finnhub.js';
import { yahoo, CHART_RANGES } from './providers/yahoo.js';
import { twelvedata } from './providers/twelvedata.js';
import { fmp } from './providers/fmp.js';
import { alphavantage } from './providers/alphavantage.js';
import { companyNews, marketNews } from './ro-news.js';
import { euCompanyNews, euMarketNews, isEu } from './eu-news.js';
import { usCompanyNews, usMarketNews } from './us-news.js';
import { roFilings } from './ro-filings.js';

// Romanian company news from the press's RSS feeds (ro-news.js); no upstream key.
const ronews = {
  name: 'ronews', needsKey: false, limits: {},
  supports: cap => cap === 'news' || cap === 'marketNewsRO',
  load: (cap, p, ctx) => cap === 'news' ? companyNews(p.symbol, p.from, p.to, ctx.log) : marketNews(100, ctx.log)
};
// German and British company news from the press's RSS feeds (eu-news.js); no upstream key.
const eunews = {
  name: 'eunews', needsKey: false, limits: {},
  supports: cap => cap === 'news' || cap === 'marketNewsEU',
  load: (cap, p, ctx) => cap === 'news' ? euCompanyNews(p.symbol, p.from, p.to, ctx.log) : euMarketNews(150, ctx.log)
};
// US press releases and financial press from RSS (us-news.js); no upstream key. Company
// news for one US ticker is added to Finnhub's in fetchUsNews().
const usnews = {
  name: 'usnews', needsKey: false, limits: {},
  supports: cap => cap === 'marketNewsUS',
  load: (cap, p, ctx) => usMarketNews(p.names, 150, ctx.log)
};
// Filings and management dealings of a .RO company, from its own site and the press
// (ro-filings.js); no upstream key.
const rofilings = {
  name: 'rofilings', needsKey: false, limits: {},
  supports: cap => cap === 'filingsRO',
  load: (cap, p, ctx) => roFilings(p.symbol, 30, ctx.log)
};

// Default order per capability. A provider without a key is skipped; Alpha Vantage's
// 25 calls a day make it a last resort. Override with MARKET_ORDER_<CAPABILITY>, e.g.
// MARKET_ORDER_CHART=twelvedata,yahoo.
const PROVIDERS = {
  quote: [finnhub, twelvedata, fmp, alphavantage],
  profile: [finnhub, fmp, alphavantage],
  earnings: [finnhub, fmp],
  earningsHistory: [fmp],   // internal: past reports that enrich the earnings calendar
  chart: [yahoo, twelvedata],
  marketNewsRO: [ronews],  // /ro-news: every story naming a BVB-listed company
  marketNewsEU: [eunews],  // /eu-news: every story naming a XETRA or London listed company
  marketNewsUS: [usnews],  // /us-news: US press releases, and press stories naming the companies given
  filingsRO: [rofilings],  // /filings for a .RO symbol
  insiderTx: [finnhub], secFilings: [finnhub], // /filings for a US symbol (fetchFilings)
  news: [finnhub], search: [finnhub], recommendation: [finnhub], earningsCalendar: [finnhub]
};
const BY_NAME = Object.fromEntries([finnhub, yahoo, twelvedata, fmp, alphavantage, ronews, eunews, usnews, rofilings].map(p => [p.name, p]));
// Keys by provider, from the environment (never sent anywhere but the provider itself).
export const keysFromEnv = env => ({ finnhub: env.FINNHUB_KEY, twelvedata: env.TWELVEDATA_KEY, fmp: env.FMP_KEY, alphavantage: env.ALPHAVANTAGE_KEY });
// Bucharest Stock Exchange listings (.RO): Yahoo has their prices and names, the Romanian
// press their news. The backup providers don't cover them, so they aren't asked (their
// small daily quotas would be spent on nothing).
const RO_ROUTES = {
  quote: [yahoo, finnhub], profile: [yahoo], chart: [yahoo], news: [ronews],
  earnings: [finnhub], earningsCalendar: [finnhub], recommendation: [finnhub]
};
// German (.DE) and London (.L) listings: Yahoo for prices, charts and names, the German and
// British press for news. Finnhub's free plan has neither.
const EU_ROUTES = {
  quote: [yahoo], profile: [yahoo], chart: [yahoo], news: [eunews],
  earnings: [finnhub], earningsCalendar: [finnhub], recommendation: [finnhub]
};
export const isBvb = symbol => /\.RO$/.test(String(symbol || ''));
// Listings outside the US, served by Yahoo and the press instead of the US providers.
const isLocal = symbol => isBvb(symbol) || isEu(symbol);
const providersFor = (cap, ctx, params) =>
  (params && isBvb(params.symbol) && RO_ROUTES[cap]) || (params && isEu(params.symbol) && EU_ROUTES[cap]) ||
  (ctx.order && ctx.order[cap]) || PROVIDERS[cap];
// { CHART: 'twelvedata,yahoo' } (from env MARKET_ORDER_*) -> { chart: [twelvedata, yahoo] }
export function orderFromEnv(env) {
  const out = {};
  Object.keys(PROVIDERS).forEach(cap => {
    const raw = env['MARKET_ORDER_' + cap.replace(/[A-Z]/g, c => '_' + c).toUpperCase()];
    if (!raw) return;
    const list = String(raw).split(',').map(s => BY_NAME[s.trim().toLowerCase()]).filter(p => p && p.supports(cap));
    if (list.length) out[cap] = list;
  });
  return out;
}
// The paths the apps already call, mapped to capabilities.
const ROUTES = {
  '/quote': 'quote', '/quotes': 'quotes', '/company-news': 'news', '/search': 'search',
  '/stock/recommendation': 'recommendation', '/stock/earnings': 'earnings',
  '/calendar/earnings': 'earningsCalendar', '/stock/profile2': 'profile', '/chart': 'chart', '/ro-news': 'marketNewsRO', '/eu-news': 'marketNewsEU', '/us-news': 'marketNewsUS',
  '/filings': 'filings'
};
// Seconds an answer is fresh. Quotes go stale fast; company names hardly change.
const TTL = { filings: 3600, filingsRO: 3600, insiderTx: 3600, secFilings: 3600, marketNewsRO: 600, marketNewsEU: 600, marketNewsUS: 600, quote: 30, news: 300, search: 300, recommendation: 3600, earnings: 3600, earningsCalendar: 3600, earningsHistory: 43200, profile: 86400, chart: 300 };
// How long past its TTL an answer may still be served when every provider is failing.
const STALE_FOR = { quote: 600 };
const STALE_DEFAULT = 86400;
// The CDN keys cached answers on these query parameters only.
const VARY = 'query=path|symbol|symbols|from|to|q|range|warm|limit|names';

const MAX_UPSTREAM_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 8000;
const MAX_BATCH = 50;
const BATCH_CONCURRENCY = 4;
const FAILS_TO_OPEN = 3;
const FAIL_COOLDOWN_MS = 30_000;
const WINDOW_MS = 60_000;

const cache = new Map();     // capability|params -> { data, at, ttl, source }
const inflight = new Map();  // capability|params -> Promise
const breakers = new Map();  // provider -> { until, fails, reason }
const minute = new Map();    // provider -> { started, count }: this instance's pace
const pending = new Map();   // provider -> { calls, rate_limited, errors } not yet in the shared store
const totals = new Map();    // provider -> the same, since this instance started
let lastFlush = Date.now();
let sharedToday = { at: 0, day: '', rows: {} }; // provider -> calls today, all instances
const clients = new Map();   // client -> { started, count }

const securityHeaders = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()'
};
const json = (data, status = 200, extra = {}) => Response.json(data, { status, headers: { ...securityHeaders, ...extra } });

const validSymbol = v => /^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(v);
const isoDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'));

// ------------------------------------------------------------------ request parsing
// Rebuilds the parameters from validated values only, so nothing the client adds (a second
// token=, a path in symbol) reaches a provider.
function parse(cap, q) {
  if (cap === 'marketNewsRO' || cap === 'marketNewsEU') return { params: {} };
  // names=OKLO:Oklo Inc|JPM:JPMorgan Chase & Co (the caller's names; nothing is looked up).
  if (cap === 'marketNewsUS') {
    const names = {};
    for (const pair of String(q.get('names') || '').split('|').filter(Boolean)) {
      const i = pair.indexOf(':'), sym = pair.slice(0, i).toUpperCase(), name = pair.slice(i + 1).trim();
      if (i < 1 || !validSymbol(sym) || !/^[\w .,&'()\-]{0,80}$/.test(name)) return { error: 'invalid names' };
      names[sym] = name;
    }
    if (Object.keys(names).length > 80) return { error: 'too many names' };
    return { params: { names } };
  }
  if (cap === 'quotes') {
    const symbols = [...new Set(String(q.get('symbols') || '').toUpperCase().split(',').map(s => s.trim()).filter(Boolean))].sort();
    if (!symbols.length || symbols.length > MAX_BATCH || !symbols.every(validSymbol)) return { error: 'invalid symbols' };
    return { params: { symbols } };
  }
  if (cap === 'search') {
    const query = (q.get('q') || '').trim();
    if (!query || query.length > 64) return { error: 'invalid search query' };
    return { params: { q: query } };
  }
  const symbol = (q.get('symbol') || '').toUpperCase();
  if (cap === 'chart') {
    const range = q.get('range') || '6mo';
    if (!validSymbol(symbol) || !CHART_RANGES.includes(range)) return { error: 'invalid chart request' };
    return { params: { symbol, range, warm: q.get('warm') === '1' } };
  }
  if (!validSymbol(symbol)) return { error: 'invalid symbol' };
  const params = { symbol };
  if (cap === 'news' || cap === 'earningsCalendar') {
    const from = q.get('from') || '', to = q.get('to') || '';
    if (!isoDate(from) || !isoDate(to) || from > to) return { error: 'invalid date range' };
    const days = (Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000;
    // News is fetched a month at a time; the earnings calendar spans the last and next report.
    if (days > (cap === 'news' ? 31 : 400)) return { error: 'date range too large' };
    params.from = from; params.to = to;
  }
  if (cap === 'earnings') {
    const limit = parseInt(q.get('limit') || '24', 10);
    params.limit = limit >= 1 && limit <= 24 ? limit : 24;
  }
  return { params };
}

const ttlFor = (cap, p) => cap === 'chart' && p.range === '1d' ? 60 : TTL[cap];

// ------------------------------------------------------------------ providers
function breakerOpen(name) {
  const b = breakers.get(name);
  return !!(b && b.until > Date.now());
}
function tripRateLimit(name, retryAfter, log) {
  // Free tiers count per minute: wait for Retry-After, or else the next minute.
  const secs = parseInt(retryAfter, 10);
  const wait = secs > 0 ? Math.min(secs, 3600) * 1000 : Math.max(5000, WINDOW_MS - (Date.now() % WINDOW_MS));
  breakers.set(name, { until: Date.now() + wait, fails: 0, reason: 'rate-limited' });
  log({ evt: 'market.breaker', provider: name, reason: 'rate-limited', ms: wait });
}
function recordFailure(name, log) {
  const b = breakers.get(name) || { until: 0, fails: 0 };
  b.fails += 1;
  if (b.fails >= FAILS_TO_OPEN) {
    b.until = Date.now() + FAIL_COOLDOWN_MS; b.fails = 0; b.reason = 'failing';
    log({ evt: 'market.breaker', provider: name, reason: 'failing', ms: FAIL_COOLDOWN_MS });
  }
  breakers.set(name, b);
}
const recordSuccess = name => { const b = breakers.get(name); if (b) { b.fails = 0; } };

// Stays a little under the provider's per-minute limit on this instance; the breaker
// covers the rest when several instances share a key.
function paceAllows(p) {
  const per = p.limits && p.limits.perMinute;
  if (!per) return true;
  const now = Date.now(), m = minute.get(p.name);
  if (!m || now - m.started >= WINDOW_MS) { minute.set(p.name, { started: now - (now % WINDOW_MS), count: 0 }); return true; }
  return m.count < Math.floor(per * 0.9);
}
function count(name, kind) {
  for (const map of [pending, totals]) {
    const c = map.get(name) || { calls: 0, rate_limited: 0, errors: 0 };
    c[kind] += 1; map.set(name, c);
  }
  if (kind === 'calls') { const m = minute.get(name); if (m) m.count += 1; }
}
const utcDay = () => new Date().toISOString().slice(0, 10);
// Calls made today by every instance, for providers with a daily cap. Read at most once a
// minute; this instance's own unflushed calls are added on top.
async function dailyAllows(p, ctx) {
  const per = p.limits && p.limits.perDay;
  if (!per || !ctx.usage) return true;
  const day = utcDay();
  if (sharedToday.day !== day || Date.now() - sharedToday.at > 60_000) {
    try {
      const rows = await ctx.usage.read(1);
      const byName = {};
      (rows || []).forEach(r => { if (r.day === day) byName[r.provider] = r.calls; });
      sharedToday = { at: Date.now(), day, rows: byName };
    } catch (e) { sharedToday.at = Date.now(); } // keep the last figures; try again in a minute
  }
  const used = (sharedToday.rows[p.name] || 0) + ((pending.get(p.name) || {}).calls || 0);
  return used < Math.floor(per * 0.95);
}
// Sends this instance's counts to the shared store every 30 seconds (or 25 calls), after
// the response has gone out.
function maybeFlush(ctx, force) {
  if (!ctx.usage || !pending.size) return null;
  const queued = [...pending.values()].reduce((a, c) => a + c.calls, 0);
  if (!force && Date.now() - lastFlush < 30_000 && queued < 25) return null;
  const rows = [...pending.entries()].map(([provider, c]) => ({ provider, ...c }));
  pending.clear(); lastFlush = Date.now();
  return ctx.usage.bump(rows).catch(e => {
    // Put the counts back for the next flush rather than losing them.
    rows.forEach(r => { const c = pending.get(r.provider) || { calls: 0, rate_limited: 0, errors: 0 };
      c.calls += r.calls; c.rate_limited += r.rate_limited; c.errors += r.errors; pending.set(r.provider, c); });
    ctx.log({ evt: 'market.usage', status: 'flush-failed', error: String(e && e.message || e) });
  });
}

async function fetchJson(target, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(target, { headers: { accept: 'application/json', 'user-agent': 'StockNews/0.3', ...(headers || {}) }, signal: controller.signal });
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > MAX_UPSTREAM_BYTES) throw new Error('response too large');
    const body = await res.text();
    if (Buffer.byteLength(body, 'utf8') > MAX_UPSTREAM_BYTES) throw new Error('response too large');
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { if (res.ok) throw new Error('invalid upstream response'); }
    return { status: res.status, parsed, retryAfter: res.headers.get('retry-after') };
  } finally {
    clearTimeout(timer);
  }
}

// One capability, through the cache and the provider list.
async function fetchCapability(cap, params, ctx) {
  const key = cap + '|' + JSON.stringify(params);
  const hit = cache.get(key), now = Date.now();
  if (hit && now - hit.at < hit.ttl * 1000) return { status: 200, data: hit.data, source: hit.source, cache: 'hit', ttl: hit.ttl };
  if (inflight.has(key)) {
    const r = await inflight.get(key);
    return r.cache === 'miss' ? { ...r, cache: 'coalesced' } : r;
  }
  const run = (async () => {
    // The most telling failure wins: one from a provider that was tried beats "not configured".
    let fail = null, unconfigured = false, emptyAnswer = null;
    for (const p of providersFor(cap, ctx, params)) {
      const apiKey = p.needsKey ? ctx.keys[p.name] : null;
      if (p.needsKey && !apiKey) { unconfigured = true; continue; }
      if (breakerOpen(p.name) || !paceAllows(p)) { fail = { status: 429, error: 'rate limit exceeded' }; continue; }
      if (!(await dailyAllows(p, ctx))) { fail = { status: 429, error: 'daily quota reached' }; continue; }
      count(p.name, 'calls');
      const t0 = Date.now();
      // A provider that reads its own sources (the RSS feeds) instead of one HTTP API.
      if (p.load) {
        try {
          const data = await p.load(cap, params, ctx);
          ctx.log({ evt: 'market.upstream', provider: p.name, cap, status: 200, ms: Date.now() - t0 });
          recordSuccess(p.name);
          return remember(key, cap, params, data, p.name);
        } catch (e) {
          ctx.log({ evt: 'market.upstream', provider: p.name, cap, status: 'error', ms: Date.now() - t0 });
          recordFailure(p.name, ctx.log); count(p.name, 'errors');
          fail = { status: 502, error: 'market data unavailable' };
          continue;
        }
      }
      let res;
      try {
        res = await fetchJson(p.url(cap, params, apiKey), p.headers);
      } catch (e) {
        const timeout = e && e.name === 'AbortError';
        ctx.log({ evt: 'market.upstream', provider: p.name, cap, status: timeout ? 'timeout' : 'error', ms: Date.now() - t0 });
        recordFailure(p.name, ctx.log); count(p.name, 'errors');
        fail = { status: 502, error: timeout ? 'market data timed out' : 'market data unavailable' };
        continue;
      }
      if (p.status) res.status = p.status(res);
      ctx.log({ evt: 'market.upstream', provider: p.name, cap, status: res.status, ms: Date.now() - t0 });
      if (res.status === 429) { count(p.name, 'rate_limited'); tripRateLimit(p.name, res.retryAfter, ctx.log); fail = { status: 429, error: 'rate limit exceeded' }; continue; }
      if (res.status >= 500 || res.parsed == null) { recordFailure(p.name, ctx.log); count(p.name, 'errors'); fail = { status: 502, error: 'market data unavailable' }; continue; }
      // A key or plan problem is this provider's; the next one may answer.
      if (res.status === 401 || res.status === 402 || res.status === 403) { count(p.name, 'errors'); fail = { status: 502, error: 'market data unavailable' }; continue; }
      // Any other client error (bad symbol) is the answer; another provider won't differ.
      if (res.status >= 400) return { status: res.status, data: res.parsed, source: p.name, cache: 'miss', ttl: 0 };
      recordSuccess(p.name);
      const data = await p.transform(cap, res.parsed, params, apiKey);
      // An empty answer lets the next provider try; if none does better, it stands.
      if (p.empty && p.empty(cap, data)) { if (!emptyAnswer) emptyAnswer = { data, source: p.name }; continue; }
      return remember(key, cap, params, data, p.name);
    }
    if (emptyAnswer) return remember(key, cap, params, emptyAnswer.data, emptyAnswer.source);
    const staleFor = STALE_FOR[cap] || STALE_DEFAULT;
    if (hit && Date.now() - hit.at < (hit.ttl + staleFor) * 1000) return { status: 200, data: hit.data, source: hit.source, cache: 'stale', ttl: 0 };
    if (!fail) fail = unconfigured ? { status: 503, error: 'market data is not configured' } : { status: 502, error: 'market data unavailable' };
    return { status: fail.status, data: { error: fail.error }, source: null, cache: 'miss', ttl: 0 };
  })();
  inflight.set(key, run);
  try { return await run; } finally { inflight.delete(key); }
}

function remember(key, cap, params, data, source) {
  const ttl = ttlFor(cap, params);
  cache.set(key, { data, at: Date.now(), ttl, source });
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  return { status: 200, data, source, cache: 'miss', ttl };
}

// A US ticker's news: Finnhub's, plus the company's press releases and the CNBC and
// MarketWatch stories that name it (us-news.js, by its name from the cached profile).
async function fetchUsNews(params, ctx) {
  const r = await fetchCapability('news', params, ctx);
  let name = '';
  try { const pr = await fetchCapability('profile', { symbol: params.symbol }, ctx); name = (pr.status === 200 && pr.data && pr.data.name) || ''; } catch {}
  let press = [];
  try { press = await usCompanyNews(params.symbol, name, params.from, params.to, ctx.log); } catch {}
  if (!press.length) return r;
  const rows = r.status === 200 && Array.isArray(r.data) ? r.data : [];
  if (r.status !== 200 && !rows.length && r.status !== 502 && r.status !== 429) return r;
  const seen = new Set(rows.map(x => String(x.url || '').replace(/[?#].*$/, '')));
  const merged = rows.concat(press.filter(x => !seen.has(x.url.replace(/[?#].*$/, '')))).sort((a, b) => b.datetime - a.datetime);
  return { ...r, status: 200, data: merged, source: [r.source, 'usnews'].filter(Boolean).join(','), ttl: r.ttl || 300 };
}

// The last 30 days of regulatory filings and insider dealings, as
// { items: [{ type: 'insider'|'filing', datetime, title, url, source, official, act, who, shares, value, form }], coverage }.
// .RO: the company's own announcements and the press (ro-filings.js). US: Finnhub's SEC
// filings and Form 4 open-market buys and sales. Other listings: none (coverage 'none').
const FILING_FORMS = /^(8-K|10-Q|10-K|6-K|20-F|40-F|S-1|S-3|S-4|F-1|F-3|DEF 14A|PRE 14A|SC 13D|SC 13G|SC 13D\/A|SC 13G\/A|SC TO-T|SC TO-I|424B\d)$/;
const nameCase = s => String(s || '').toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
async function fetchFilings(params, ctx) {
  const symbol = params.symbol;
  if (isBvb(symbol)) return fetchCapability('filingsRO', { symbol }, ctx);
  if (isLocal(symbol)) {
    return { status: 200, data: { items: [], coverage: 'none' }, source: null, cache: 'miss', ttl: TTL.filings };
  }
  const to = new Date().toISOString().slice(0, 10), from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const [ins, fil] = await Promise.all([
    fetchCapability('insiderTx', { symbol, from, to }, ctx), fetchCapability('secFilings', { symbol, from, to }, ctx)]);
  if (ins.status !== 200 && fil.status !== 200) return ins;
  const items = [];
  // Several rows per Form 4 (one per lot): one line per person, day and direction.
  const deals = new Map();
  for (const x of (ins.status === 200 && ins.data && Array.isArray(ins.data.data) ? ins.data.data : [])) {
    const act = x.transactionCode === 'P' ? 'buy' : x.transactionCode === 'S' ? 'sell' : '';
    const day = x.filingDate || x.transactionDate;
    if (!act || !day || !x.name) continue;
    const k = x.name + '|' + day + '|' + act, d = deals.get(k) || { name: x.name, day, act, shares: 0, value: 0 };
    const n = Math.abs(Number(x.change) || 0);
    d.shares += n; d.value += n * (Number(x.transactionPrice) || 0);
    deals.set(k, d);
  }
  for (const d of deals.values()) {
    const at = Date.parse(d.day + 'T21:00:00Z');
    if (!Number.isFinite(at) || !d.shares) continue;
    items.push({ type: 'insider', datetime: Math.floor(at / 1000), who: nameCase(d.name), act: d.act, shares: d.shares, value: Math.round(d.value),
      title: '', url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&type=4&CIK=' + encodeURIComponent(symbol), source: 'SEC', official: true });
  }
  for (const x of (fil.status === 200 && Array.isArray(fil.data) ? fil.data : [])) {
    const at = Date.parse(String(x.acceptedDate || x.filedDate || '').replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(x.acceptedDate || '') ? '' : 'Z'));
    if (!FILING_FORMS.test(String(x.form || '')) || !Number.isFinite(at)) continue;
    const url = String(x.reportUrl || x.filingUrl || '');
    items.push({ type: 'filing', datetime: Math.floor(at / 1000), form: x.form, title: '', source: 'SEC', official: true,
      url: /^https:\/\//.test(url) ? url : 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=' + encodeURIComponent(symbol) });
  }
  items.sort((a, b) => b.datetime - a.datetime);
  return { status: 200, data: { items: items.slice(0, 20), coverage: 'sec' }, source: 'finnhub',
    cache: ins.cache === 'hit' && fil.cache === 'hit' ? 'hit' : 'miss', ttl: TTL.filings };
}

// Finnhub's free earnings calendar lists only upcoming reports. When it has no past report
// with a result, FMP's earnings history (cached 12 hours) adds the recent ones.
async function fetchEarningsCalendar(params, ctx) {
  const r = await fetchCapability('earningsCalendar', params, ctx);
  const rows = r.status === 200 && r.data && Array.isArray(r.data.earningsCalendar) ? r.data.earningsCalendar : null;
  if (!rows || isLocal(params.symbol) || rows.some(x => x && x.epsActual != null)) return r;
  const h = await fetchCapability('earningsHistory', { symbol: params.symbol }, ctx);
  if (h.status !== 200 || !Array.isArray(h.data) || !h.data.length) return r;
  const have = new Set(rows.map(x => x.date));
  const extra = h.data.filter(x => x.date >= params.from && x.date <= params.to && !have.has(x.date));
  if (!extra.length) return r;
  return { ...r, data: { ...r.data, earningsCalendar: rows.concat(extra) }, source: r.source + ',' + h.source,
    cache: r.cache === 'hit' && h.cache === 'hit' ? 'hit' : 'miss' };
}

// Many quotes at once: each symbol goes through the same cache, a few upstream calls at a
// time. A symbol that fails comes back as null.
async function fetchQuotes(symbols, ctx) {
  const quotes = {}, sources = new Set(), queue = symbols.slice();
  let ok = 0, limited = 0, missed = false, stale = false;
  await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const s = queue.shift(), r = await fetchCapability('quote', { symbol: s }, ctx);
      if (r.status === 200) { quotes[s] = r.data; ok++; if (r.source) sources.add(r.source); }
      else { quotes[s] = null; if (r.status === 429) limited++; }
      if (r.cache !== 'hit') missed = true;
      if (r.cache === 'stale') stale = true;
    }
  }));
  const complete = ok === symbols.length;
  return {
    status: ok ? 200 : limited ? 429 : 502,
    data: ok ? { quotes } : { error: limited ? 'rate limit exceeded' : 'market data unavailable' },
    source: [...sources].join(',') || null,
    cache: stale ? 'stale' : missed ? 'miss' : 'hit',
    // Only a complete, fresh batch is worth caching as a whole.
    ttl: complete && !stale ? TTL.quote : 0
  };
}

// ------------------------------------------------------------------ HTTP
function allowedOrigin(request, configured) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  const extras = String(configured || '').split(',').map(x => x.trim()).filter(Boolean);
  return origin === new URL(request.url).origin || extras.includes(origin);
}

function withinRateLimit(clientId, rawLimit) {
  const limit = Math.max(1, Math.min(Number(rawLimit) || 60, 1200));
  const now = Date.now(), key = clientId || 'unknown', entry = clients.get(key);
  if (!entry || now - entry.started >= WINDOW_MS) {
    if (clients.size > 10_000) for (const [c, v] of clients) if (now - v.started >= WINDOW_MS) clients.delete(c);
    clients.set(key, { started: now, count: 1 });
    return true;
  }
  entry.count += 1;
  return entry.count <= limit;
}

// ------------------------------------------------------------------ who may ask
// Without an account, only what spends no paid quota: Romanian press stories (RSS) and the
// quotes the landing page shows. Everything else needs a signed-in user, checked against
// Supabase Auth (cached for 5 minutes). Answers already in the CDN cache are served to
// anyone without reaching this code, so only cache misses, which spend quota, are gated.
const PUBLIC_SYMBOLS = ['NVDA', 'AAPL', 'MSFT', 'TSLA', 'AMZN'];
const AUTH_TTL_MS = 5 * 60 * 1000;
const users = new Map(); // token -> { ok, until }
export function publicRequest(cap, params, extraSymbols) {
  const open = new Set(PUBLIC_SYMBOLS.concat(String(extraSymbols || '').toUpperCase().split(',').map(x => x.trim()).filter(Boolean)));
  if (cap === 'marketNewsRO' || cap === 'marketNewsEU' || cap === 'marketNewsUS') return true;
  // Press stories (Romanian, German, British) and the Romanian filings cost no quota.
  if (cap === 'news') return /\.(RO|DE|L)$/.test(params.symbol);
  if (cap === 'filings') return isLocal(params.symbol);
  if (cap === 'quotes') return params.symbols.length <= 8 && params.symbols.every(t => open.has(t));
  if (cap === 'quote') return open.has(params.symbol);
  return false;
}
// true for a valid session of an account the owner has approved (supabase/approval.sql),
// 'pending' for one still waiting, false otherwise. A refusal is remembered for a minute
// only, so an approval takes effect quickly.
const PENDING_TTL_MS = 60 * 1000;
async function signedIn(request, auth, fetchImpl) {
  const token = (request.headers.get('x-hif-auth') || '').trim();
  if (!token || token.length > 4096) return false;
  const now = Date.now(), hit = users.get(token);
  if (hit && hit.until > now) return hit.ok;
  const base = auth.supabaseUrl.replace(/\/$/, ''), f = fetchImpl || fetch;
  const headers = { apikey: auth.anonKey, authorization: 'Bearer ' + token };
  let ok = false;
  try {
    const res = await f(base + '/auth/v1/user', { headers, signal: AbortSignal.timeout(5000) });
    const user = res.ok ? await res.json() : null;
    if (user && user.id) {
      // The account's own row (row-level security); no row means not approved.
      const st = await f(base + '/rest/v1/account_status?select=approved,suspended&user_id=eq.' + encodeURIComponent(user.id),
        { headers: { ...headers, accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
      const rows = st.ok ? await st.json() : null;
      if (!st.ok) return false; // can't tell: refuse, but don't remember it
      ok = Array.isArray(rows) && !!rows[0] && rows[0].approved === true && !rows[0].suspended ? true : 'pending';
    }
  } catch { return false; } // Supabase unreachable: refuse, but don't remember it.
  if (users.size > 5000) for (const [k, v] of users) if (v.until <= now) users.delete(k);
  users.set(token, { ok, until: now + (ok === true ? AUTH_TTL_MS : PENDING_TTL_MS) });
  return ok;
}

const defaultLog = process.env.NODE_TEST_CONTEXT ? () => {} : e => console.log(JSON.stringify(e));

// options: { apiKey (Finnhub), keys: { provider: key }, order (orderFromEnv), allowedOrigins, rateLimit, clientId, log,
//            usage (usage-store.js), waitUntil (keeps a flush alive after the response),
//            auth: { supabaseUrl, anonKey, publicSymbols, fetch } (without it, nothing is gated: local use) }
export async function handleMarketRequest(request, options = {}) {
  if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405, { allow: 'GET' });
  if (!allowedOrigin(request, options.allowedOrigins)) return json({ error: 'origin not allowed' }, 403);
  if (!withinRateLimit(options.clientId, options.rateLimit)) return json({ error: 'rate limit exceeded' }, 429, { 'retry-after': '60' });

  const url = new URL(request.url);
  const cap = ROUTES[url.searchParams.get('path') || ''];
  if (!cap) return json({ error: 'path not allowed' }, 400);
  const parsed = parse(cap, url.searchParams);
  if (parsed.error) return json({ error: parsed.error }, 400);
  const auth = options.auth;
  if (auth && auth.supabaseUrl && auth.anonKey && !publicRequest(cap, parsed.params, auth.publicSymbols)) {
    const who = await signedIn(request, auth, auth.fetch);
    if (who === 'pending') return json({ error: 'account awaiting approval' }, 403, { 'cache-control': 'no-store' });
    if (who !== true) return json({ error: 'sign in required' }, 401, { 'cache-control': 'no-store' });
  }

  const ctx = { keys: { finnhub: options.apiKey, ...(options.keys || {}) }, log: options.log || defaultLog, usage: options.usage || null, order: options.order || null };
  const r = cap === 'quotes' ? await fetchQuotes(parsed.params.symbols, ctx)
    : cap === 'earningsCalendar' ? await fetchEarningsCalendar(parsed.params, ctx)
    : cap === 'news' && !isLocal(parsed.params.symbol) ? await fetchUsNews(parsed.params, ctx)
    : cap === 'filings' ? await fetchFilings(parsed.params, ctx)
    : await fetchCapability(cap, parsed.params, ctx);
  const flush = maybeFlush(ctx);
  if (flush && options.waitUntil) options.waitUntil(flush);
  const headers = { 'x-market-cache': r.cache, 'netlify-vary': VARY };
  if (r.source) headers['x-market-source'] = r.source;
  if (r.status === 200 && r.ttl > 0) {
    headers['cache-control'] = `public, max-age=${Math.min(r.ttl, 300)}`;
    headers['netlify-cdn-cache-control'] = `public, durable, max-age=${r.ttl}, stale-while-revalidate=${r.ttl}`;
  } else {
    headers['cache-control'] = r.status === 200 ? 'public, max-age=5' : 'no-store';
  }
  if (r.status === 429) headers['retry-after'] = '30';
  return json(r.data, r.status, headers);
}

const startedAt = Date.now();
const allProviders = () => [...new Set(Object.values(PROVIDERS).flat())];

// What this instance knows: breakers, cache size and its own call counts. Instances don't
// share memory, so the health page leans on the shared store for the overall picture.
export function gatewayStatus() {
  const now = Date.now();
  return {
    cached: cache.size,
    upSeconds: Math.round((now - startedAt) / 1000),
    providers: Object.fromEntries(allProviders().map(p => {
      const b = breakers.get(p.name);
      return [p.name, {
        breaker: b && b.until > now ? { open: true, reason: b.reason, secondsLeft: Math.ceil((b.until - now) / 1000) } : { open: false },
        thisInstance: totals.get(p.name) || { calls: 0, rate_limited: 0, errors: 0 }
      }];
    }))
  };
}

// Provider list for the health page: capabilities, limits and whether a key is set
// (never the key).
export function providerInfo(keys, order) {
  return allProviders().map(p => ({
    name: p.name,
    capabilities: Object.keys(PROVIDERS).filter(c => ((order && order[c]) || PROVIDERS[c]).includes(p)),
    limits: p.limits || {},
    configured: !p.needsKey || !!(keys && keys[p.name])
  }));
}

// Sends whatever this instance has counted to the shared store now.
export function flushUsage(usage) { return maybeFlush({ usage, log: defaultLog }, true) || Promise.resolve(); }

export function resetGatewayForTests() {
  cache.clear(); inflight.clear(); breakers.clear(); clients.clear(); minute.clear(); pending.clear(); totals.clear(); users.clear();
  lastFlush = Date.now(); sharedToday = { at: 0, day: '', rows: {} };
}
