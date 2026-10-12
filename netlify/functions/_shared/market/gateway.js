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

// Default order per capability. A provider without a key is skipped; Alpha Vantage's
// 25 calls a day make it a last resort. Override with MARKET_ORDER_<CAPABILITY>, e.g.
// MARKET_ORDER_CHART=twelvedata,yahoo.
const PROVIDERS = {
  quote: [finnhub, twelvedata, fmp, alphavantage],
  profile: [finnhub, fmp, alphavantage],
  earnings: [finnhub, fmp],
  earningsHistory: [fmp],   // internal: past reports that enrich the earnings calendar
  chart: [yahoo, twelvedata],
  news: [finnhub], search: [finnhub], recommendation: [finnhub], earningsCalendar: [finnhub]
};
const BY_NAME = Object.fromEntries([finnhub, yahoo, twelvedata, fmp, alphavantage].map(p => [p.name, p]));
// Keys by provider, from the environment (never sent anywhere but the provider itself).
export const keysFromEnv = env => ({ finnhub: env.FINNHUB_KEY, twelvedata: env.TWELVEDATA_KEY, fmp: env.FMP_KEY, alphavantage: env.ALPHAVANTAGE_KEY });
const providersFor = (cap, ctx) => (ctx.order && ctx.order[cap]) || PROVIDERS[cap];
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
  '/calendar/earnings': 'earningsCalendar', '/stock/profile2': 'profile', '/chart': 'chart'
};
// Seconds an answer is fresh. Quotes go stale fast; company names hardly change.
const TTL = { quote: 30, news: 300, search: 300, recommendation: 3600, earnings: 3600, earningsCalendar: 3600, earningsHistory: 43200, profile: 86400, chart: 300 };
// How long past its TTL an answer may still be served when every provider is failing.
const STALE_FOR = { quote: 600 };
const STALE_DEFAULT = 86400;
// The CDN keys cached answers on these query parameters only.
const VARY = 'query=path|symbol|symbols|from|to|q|range|warm|limit';

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
    for (const p of providersFor(cap, ctx)) {
      const apiKey = p.needsKey ? ctx.keys[p.name] : null;
      if (p.needsKey && !apiKey) { unconfigured = true; continue; }
      if (breakerOpen(p.name) || !paceAllows(p)) { fail = { status: 429, error: 'rate limit exceeded' }; continue; }
      if (!(await dailyAllows(p, ctx))) { fail = { status: 429, error: 'daily quota reached' }; continue; }
      count(p.name, 'calls');
      const t0 = Date.now();
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

// Finnhub's free earnings calendar lists only upcoming reports. When it has no past report
// with a result, FMP's earnings history (cached 12 hours) adds the recent ones.
async function fetchEarningsCalendar(params, ctx) {
  const r = await fetchCapability('earningsCalendar', params, ctx);
  const rows = r.status === 200 && r.data && Array.isArray(r.data.earningsCalendar) ? r.data.earningsCalendar : null;
  if (!rows || rows.some(x => x && x.epsActual != null)) return r;
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

const defaultLog = process.env.NODE_TEST_CONTEXT ? () => {} : e => console.log(JSON.stringify(e));

// options: { apiKey (Finnhub), keys: { provider: key }, order (orderFromEnv), allowedOrigins, rateLimit, clientId, log,
//            usage (usage-store.js), waitUntil (keeps a flush alive after the response) }
export async function handleMarketRequest(request, options = {}) {
  if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405, { allow: 'GET' });
  if (!allowedOrigin(request, options.allowedOrigins)) return json({ error: 'origin not allowed' }, 403);
  if (!withinRateLimit(options.clientId, options.rateLimit)) return json({ error: 'rate limit exceeded' }, 429, { 'retry-after': '60' });

  const url = new URL(request.url);
  const cap = ROUTES[url.searchParams.get('path') || ''];
  if (!cap) return json({ error: 'path not allowed' }, 400);
  const parsed = parse(cap, url.searchParams);
  if (parsed.error) return json({ error: parsed.error }, 400);

  const ctx = { keys: { finnhub: options.apiKey, ...(options.keys || {}) }, log: options.log || defaultLog, usage: options.usage || null, order: options.order || null };
  const r = cap === 'quotes' ? await fetchQuotes(parsed.params.symbols, ctx)
    : cap === 'earningsCalendar' ? await fetchEarningsCalendar(parsed.params, ctx)
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
  cache.clear(); inflight.clear(); breakers.clear(); clients.clear(); minute.clear(); pending.clear(); totals.clear();
  lastFlush = Date.now(); sharedToday = { at: 0, day: '', rows: {} };
}
