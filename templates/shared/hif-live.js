// Finnhub adapter for the Heard It First prototypes.
//
// Two ways in:
//   1. Proxy (preferred) — /api/finnhub?path=/quote&symbol=NVDA, key held in the Netlify env.
//   2. Direct — same endpoints on finnhub.io with a token passed from the page (dev only; the key is visible).
// The proxy is probed once; if it isn't there, calls fall back to direct. With neither, every
// function resolves to null and the templates keep rendering the demo data from hif-data.js.
//
// Free-tier endpoints only. /quotes (many symbols at once) exists only through the proxy.
//
// With the dataSource flag at 'supabase' (templates/shared/hif-flags.js) and Supabase set up,
// prices, company news and analyst counts come from the tables the ingestion jobs fill
// (supabase/market-data.sql): one request each per refresh, whatever the number of symbols,
// and never a call to a market data provider. Charts, search and company profiles still go
// through the proxy, on the reader's own action.
(function(){
// The page runtime evaluates helmet scripts twice; a second copy would replace the
// adapter and throw away its response cache (so every refresh refetched everything).
if (window.HIFLive) return;
const DIRECT = 'https://finnhub.io/api/v1';
const PROXY = '/api/finnhub';
const cache = new Map();
const TTL = { ronews: 600000, profile: 24 * 3600000, quote: 60000, news: 300000, search: 300000, recs: 900000, chart: 300000, earnings: 900000, edates: 6 * 3600000, filings: 1800000,
  // A recommendation the gateway failed to get is not asked for again for a day.
  recsfail: 24 * 3600000 };
let proxyState = 'unknown'; // 'unknown' | 'yes' | 'no'
let batchQuotes = true;      // false once the proxy has turned /quotes down (an older server)

function fresh(kind, arg){
  const hit = cache.get(kind + ':' + arg);
  return hit && (Date.now() - hit.at) < TTL[kind] ? hit.value : null;
}
function put(kind, arg, value){ cache.set(kind + ':' + arg, { at: Date.now(), value: value }); return value; }

function qs(params){
  return Object.keys(params).filter(k => params[k] != null && params[k] !== '')
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&');
}

// The gateway serves quota-spending requests only to signed-in users: the session token
// goes in x-hif-auth (not Authorization, so the CDN keeps caching the answers).
// Waits for the saved session to be restored first: calls made while the app starts would
// otherwise go out without the token and be refused.
async function authHeader(){
  try {
    const A = window.HIFAuth;
    if (A && A.ready) await A.ready;
    const t = A && A.session && A.session() && A.token ? await A.token() : null;
    return t ? { 'x-hif-auth': t } : {};
  } catch (e) { return {}; }
}
async function callProxy(path, params){
  const res = await fetch(PROXY + '?' + qs(Object.assign({ path: path }, params)), { headers: await authHeader() });
  // Only a missing function means no proxy: the gateway's own 404 (a symbol Yahoo doesn't
  // know) is JSON, and mustn't switch the proxy off for the rest of the visit.
  if ((res.status === 404 || res.status === 405) && !/json/.test(res.headers.get('content-type') || '')) { proxyState = 'no'; return null; }
  // Signed out (or the session not restored yet): the proxy exists, this call just isn't
  // allowed. An error, not an empty answer, so nothing empty is cached for after sign-in.
  if (res.status === 401) { proxyState = 'yes'; throw new Error('sign in required'); }
  if (!res.ok) throw new Error('proxy ' + res.status);
  proxyState = 'yes';
  return res.json();
}
async function callDirect(path, params, token){
  if (!token) return null;
  const res = await fetch(DIRECT + path + '?' + qs(Object.assign({}, params, { token: token })));
  if (res.status === 429) throw new Error('rate limited');
  if (res.status === 401 || res.status === 403) throw new Error('key rejected');
  if (!res.ok) throw new Error('finnhub ' + res.status);
  return res.json();
}
// Proxy first (unless known missing), then direct with the page token. The same request
// asked for again while it is still on its way (the watchlist, the feed and a ticker's page
// often want one symbol at once) shares the first one's answer instead of going out twice.
const inflight = new Map();
function get(path, params, token){
  const key = path + '?' + qs(params || {});
  if (inflight.has(key)) return inflight.get(key);
  const p = fetchOnce(path, params, token);
  inflight.set(key, p);
  const done = () => { if (inflight.get(key) === p) inflight.delete(key); };
  p.then(done, done);
  return p;
}
async function fetchOnce(path, params, token){
  if (proxyState !== 'no') {
    try { const j = await callProxy(path, params); if (j) return j; }
    catch (e) { if (proxyState === 'unknown') proxyState = 'no'; else throw e; }
  }
  return callDirect(path, params, token);
}
function available(token){ return sbWanted() || proxyState !== 'no' || !!token; }

// ---- Supabase (dataSource: 'supabase')
function sbWanted(){
  const F = window.HIFFlags, A = window.HIFAuth;
  return !!(F && F.get('dataSource') === 'supabase' && A && A.rest);
}
function sbMode(){ const A = window.HIFAuth; return sbWanted() && (!A.enabled || A.enabled()); }
// Whether Supabase is set up is known once the saved sign-in is restored: wait for it, so
// the first requests of a visit don't go to the gateway by mistake. Without Supabase (the
// demo), the gateway is used as before.
async function useSb(){
  if (!sbWanted()) return false;
  try { await window.HIFAuth.ready; } catch (e) {}
  return sbMode();
}
// PostgREST in() list; symbols contain dots, so each is quoted.
const inList = syms => encodeURIComponent('(' + syms.map(s => '"' + String(s).replace(/"/g, '') + '"').join(',') + ')');
async function sb(path){
  const r = await window.HIFAuth.rest(path);
  if (!r || !r.ok || !Array.isArray(r.body)) throw new Error('supabase ' + ((r && r.status) || 0));
  return r.body;
}
// Analyst counts exist for US listings only (Finnhub's free plan and Yahoo alike): nothing
// is asked for BMW.DE or SNP.RO.
function hasRecs(symbol){ const M = window.HIFMarkets; return M ? M.marketOf(symbol) === 'US' : !/\./.test(symbol); }
function sbQuote(r){
  if (!r || r.price == null) return null;
  const q = shapeQuote({ c: Number(r.price), dp: r.change_pct, d: r.change }, r.symbol);
  if (q) { q.asOf = Date.parse(r.market_time || r.fetched_at) || null; q.fetchedAt = Date.parse(r.fetched_at) || null; q.source = r.source || '';
    q.name = r.name || ''; q.currency = r.currency ? String(r.currency) : ''; }
  return q;
}
function storyRow(r){
  const i = String(r.id).indexOf(':');
  return newsRow({ id: String(r.id).slice(i + 1), related: r.ticker, headline: r.headline, source: r.source, url: r.url,
    summary: r.summary, datetime: Math.floor(Date.parse(r.published_at) / 1000) });
}
function recRow(r){
  const total = (r.buy || 0) + (r.hold || 0) + (r.sell || 0);
  return r.status === 'ok' && total ? { buyPct: Math.round((r.buy || 0) / total * 100) + '%', detail: (r.buy || 0) + ' / ' + (r.hold || 0) + ' / ' + (r.sell || 0), period: r.period || '' } : null;
}
async function sbQuotes(symbols){
  const out = {}, need = [];
  Array.from(new Set(symbols || [])).forEach(s => { const hit = fresh('quote', s); if (hit) out[s] = hit; else need.push(s); });
  if (!need.length) return out;
  const rows = await sb('market_quotes?select=symbol,name,price,change,change_pct,prev_close,currency,market_time,fetched_at,source&symbol=in.' + inList(need.sort()));
  rows.forEach(r => { const q = sbQuote(r); if (q) out[r.symbol] = put('quote', r.symbol, q); });
  return out;
}
// The last 30 days' stories of many symbols in one request: { SYMBOL: rows }.
async function sbNews(symbols){
  const out = {}, need = [];
  symbols.forEach(s => { const hit = fresh('news', s); if (hit) out[s] = hit; else need.push(s); });
  if (!need.length) return out;
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const rows = await sb('stories?select=id,ticker,headline,source,url,summary,published_at&ticker=in.' + inList(need) +
    '&published_at=gte.' + encodeURIComponent(since) + '&order=published_at.desc&limit=' + Math.min(2000, need.length * 60));
  const by = {};
  rows.forEach(r => { (by[r.ticker] = by[r.ticker] || []).push(storyRow(r)); });
  need.forEach(s => { out[s] = put('news', s, by[s] || []); });
  return out;
}
async function sbRecs(symbols){
  const out = {}, need = [];
  symbols.filter(hasRecs).forEach(s => { const hit = cache.get('recs:' + s); if (hit && Date.now() - hit.at < TTL.recs) { if (hit.value) out[s] = hit.value; } else need.push(s); });
  if (!need.length) return out;
  const rows = await sb('market_recommendations?select=symbol,status,buy,hold,sell,period&symbol=in.' + inList(need));
  const by = {};
  rows.forEach(r => { by[r.symbol] = recRow(r); });
  need.forEach(s => { const v = put('recs', s, by[s] || null); if (v) out[s] = v; });
  return out;
}

// Small prices keep their digits (0.9940, 4.125), so a quote under 10 isn't rounded away.
function fmtPrice(v){ if (v == null) return null; const n = Number(v), a = Math.abs(n); return n.toFixed(a < 1 ? 4 : a < 10 ? 3 : 2); }
// London listings are quoted in pence, as on the exchange: "99.40p".
const isPence = symbol => /\.L$/.test(String(symbol || ''));
function fmtPct(v){ if (v == null) return null; const n = Number(v); return (n < 0 ? '−' : '+') + Math.abs(n).toFixed(1) + '%'; }
// When a story was published, in the reader's locale: "12 Oct · 10:24", with the year
// added for anything outside the current year.
function stamp(sec){
  const d = new Date(sec * 1000), p = n => String(n).padStart(2,'0');
  const opts = { day:'numeric', month:'short' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(window.HIF_LOCALE || [], opts) + ' · ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function isoDay(off){ return new Date(Date.now() + off * 86400000).toISOString().slice(0,10); }

async function quote(symbol, token){
  if (!available(token)) return null;
  const hit = fresh('quote', symbol); if (hit) return hit;
  if (await useSb()) {
    let q = null;
    try { q = (await sbQuotes([symbol]))[symbol] || null; } catch (e) {}
    // A ticker nobody follows has no row (the ingestion reads only followed and held ones):
    // the reader opened it, so ask the gateway, as before Supabase.
    return q || gatewayQuote(symbol);
  }
  const j = await get('/quote', { symbol: symbol }, token);
  return put('quote', symbol, shapeQuote(j, symbol));
}
// The gateway's /quote, else the price in its day chart (Yahoo's meta): on Cloudflare there is
// no quote provider for US listings, but their charts work. null when neither answers.
async function gatewayQuote(symbol){
  try { const q = shapeQuote(await callProxy('/quote', { symbol: symbol }), symbol); if (q) return put('quote', symbol, q); } catch (e) {}
  try { const q = quoteFromChart(await callProxy('/chart', { symbol: symbol, range: '1d' }), symbol); if (q) return put('quote', symbol, q); } catch (e) {}
  return null;
}
function quoteFromChart(j, symbol){
  const m = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
  if (!m || !(Number(m.regularMarketPrice) > 0)) return null;
  const c = Number(m.regularMarketPrice), pc = Number(m.chartPreviousClose || m.previousClose);
  const d = pc > 0 ? c - pc : null, dp = pc > 0 ? Math.round((c - pc) / pc * 10000) / 100 : null;
  const q = shapeQuote({ c: c, d: d, dp: dp }, symbol);
  if (q && m.regularMarketTime) q.asOf = Number(m.regularMarketTime) * 1000;
  return q;
}
// last/dp keep full precision for position maths; price/move are the display strings.
function shapeQuote(j, symbol){
  if (!j || j.c == null || j.c === 0) return null;
  const unit = isPence(symbol) ? 'p' : '', f = v => { const t = fmtPrice(v); return t == null ? null : t + unit; };
  return { price: f(j.c), move: fmtPct(j.dp), up: Number(j.dp) >= 0, changeAbs: f(j.d),
    last: Number(j.c), dp: j.dp == null ? null : Number(j.dp) };
}

// Many quotes in one request: { SYMBOL: quote }. The gateway answers /quotes from its
// per-symbol cache; without it (direct mode, an older server) this falls back to one call
// per symbol. Symbols are sorted so the same set shares one CDN cache entry.
async function quotes(symbols, token){
  const out = {};
  if (!available(token)) return out;
  const need = [];
  Array.from(new Set(symbols || [])).forEach(s => { const hit = fresh('quote', s); if (hit) out[s] = hit; else need.push(s); });
  if (!need.length) return out;
  if (await useSb()) { try { return Object.assign(out, await sbQuotes(need)); } catch (e) { return out; } }
  need.sort();
  if (proxyState !== 'no' && batchQuotes) {
    try {
      const j = await callProxy('/quotes', { symbols: need.join(',') });
      if (j && j.quotes) {
        need.forEach(s => { const q = put('quote', s, shapeQuote(j.quotes[s], s)); if (q) out[s] = q; });
        return out;
      }
    } catch (e) { if (/proxy 400/.test(e.message)) batchQuotes = false; }
  }
  for (const s of need) { try { const q = await quote(s, token); if (q) out[s] = q; } catch (e) {} }
  return out;
}

// { name, currency } from /stock/profile2, for positions and tickers missing from the demo data.
async function profile(symbol, token){
  if (!available(token)) return null;
  const hit = fresh('profile', symbol); if (hit) return hit;
  const j = await get('/stock/profile2', { symbol: symbol }, token);
  return put('profile', symbol, j && j.name ? { name: String(j.name), currency: String(j.currency || 'USD').toUpperCase() } : null);
}

async function news(symbol, token, limit){
  if (!available(token)) return null;
  const hit = fresh('news', symbol); if (hit) return hit.slice(0, limit || 8);
  if (await useSb()) return ((await sbNews([symbol]))[symbol] || []).slice(0, limit || 5);
  const j = await get('/company-news', { symbol: symbol, from: isoDay(-30), to: isoDay(0) }, token);
  const rows = (Array.isArray(j) ? j : []).filter(n => n && n.headline)
    .sort((a,b) => b.datetime - a.datetime)
    .map(newsRow);
  put('news', symbol, rows);
  return rows.slice(0, limit || 5);
}
function newsRow(n){
  return { id: n.id, related: n.related || '', headline: n.headline, source: n.source || '', stamp: stamp(n.datetime), ts: n.datetime,
    url: n.url || '', summary: (n.summary || '').replace(/\s+/g, ' ').trim().slice(0, 160) };
}
// Romanian press stories about any company listed in Bucharest (the BVB feed tab), each
// with the .RO symbol it is about in `related`. Proxy only.
async function pressNews(path, kind){
  const hit = fresh(kind, 'all'); if (hit) return hit;
  if (proxyState === 'no') return null;
  const j = await callProxy(path, {});
  const rows = (Array.isArray(j) ? j : []).filter(n => n && n.headline && n.related).sort((a,b) => b.datetime - a.datetime).map(newsRow);
  return put(kind, 'all', rows);
}
async function roNews(){
  if (!(await useSb())) return pressNews('/ro-news', 'ronews');
  const hit = fresh('ronews', 'all'); if (hit) return hit;
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  return sb('stories?select=id,ticker,headline,source,url,summary,published_at&ticker=like.*.RO&published_at=gte.' + encodeURIComponent(since) + '&order=published_at.desc&limit=300')
    .then(rows => put('ronews', 'all', rows.map(storyRow)));
}
// German and British press stories about XETRA and London listings (the EU Market tab).
function euNews(){ return pressNews('/eu-news', 'eunews'); }

// First visible bar of a warm (longer) series: the window the plain range would
// have returned, computed in the exchange's own timezone.
function windowStart(rows, range, gmtoffset){
  if (!rows.length) return 0;
  const off = (gmtoffset || 0) * 1000;
  const day = r => new Date(r.ts * 1000 + off).toISOString().slice(0, 10);
  const lastMs = rows[rows.length - 1].ts * 1000 + off;
  let cutoff;
  if (range === '1d' || range === '5d') {
    const days = range === '1d' ? 1 : 5, seen = [];
    for (let i = rows.length - 1; i >= 0; i--) {
      const d = day(rows[i]);
      if (seen.indexOf(d) < 0) { if (seen.length === days) return i + 1; seen.push(d); }
    }
    return 0;
  }
  const d = new Date(lastMs);
  if (range === 'ytd') cutoff = Date.UTC(d.getUTCFullYear(), 0, 1);
  else {
    const months = { '1mo': 1, '6mo': 6, '1y': 12, '5y': 60 }[range];
    if (!months) return 0;
    cutoff = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - months, d.getUTCDate());
  }
  for (let i = 0; i < rows.length; i++) if (rows[i].ts * 1000 + off >= cutoff) return i;
  return rows.length;
}

// { points, lead, currency }: points is the visible range; lead holds the bars just
// before it, for indicators only. An older proxy ignores warm=1 and lead stays short.
async function chart(symbol, range){
  const key = symbol + ':' + range;
  const hit = fresh('chart', key); if (hit) return hit;
  const j = await callProxy('/chart', { symbol: symbol, range: range, warm: 1 });
  const result = j && j.chart && j.chart.result && j.chart.result[0];
  if (!result) return put('chart', key, null);
  const timestamps = result.timestamp || [];
  const quote = result.indicators && result.indicators.quote && result.indicators.quote[0];
  const closes = quote && quote.close || [];
  // Yahoo marks missing bars with null, and Number(null) is 0 — drop them before converting.
  const rows = timestamps.map((ts, i) => ({ ts: ts, close: closes[i] == null ? NaN : Number(closes[i]) }))
    .filter(p => Number.isFinite(p.close) && p.close > 0);
  const meta = result.meta || {};
  const start = Math.min(windowStart(rows, range, meta.gmtoffset), Math.max(rows.length - 2, 0));
  return put('chart', key, { points: rows.slice(start), lead: rows.slice(Math.max(0, start - 60), start), currency: meta.currency || 'USD' });
}

async function earnings(symbol, token){
  if (!available(token)) return null;
  const hit = fresh('earnings', symbol); if (hit) return hit;
  let j;
  try { j = await get('/stock/earnings', { symbol: symbol, limit: 24 }, token); }
  catch (e) { return put('earnings', symbol, []); }
  const rows = (Array.isArray(j) ? j : []).filter(x => x && x.period).map(x => ({
    date: x.period, actual: x.actual, estimate: x.estimate,
    surprise: x.surprise, surprisePercent: x.surprisePercent
  }));
  return put('earnings', symbol, rows);
}

// The last and next earnings reports. next comes from Finnhub's earnings calendar (the
// day results will be published). The free plan's calendar has no history, so last comes
// from the calendar when it has a reported row, else from /stock/earnings, which knows the
// fiscal quarter but not the publication day (date is then null).
//   { last: { date|null, quarter, year, hour, epsActual, epsEstimate, surprisePct } | null,
//     next: { date, hour, epsEstimate } | null }
// hour: 'bmo' (before the open), 'amc' (after the close), 'dmh' (during market hours) or ''.
async function earningsDates(symbol, token){
  if (!available(token)) return null;
  const key = 'edates:' + symbol, hit = cache.get(key);
  if (hit && (Date.now() - hit.at) < TTL.edates) return hit.value;
  let j;
  try { j = await get('/calendar/earnings', { symbol: symbol, from: isoDay(-200), to: isoDay(200) }, token); }
  catch (e) { return null; }
  const rows = (j && Array.isArray(j.earningsCalendar) ? j.earningsCalendar : [])
    .filter(r => r && /^\d{4}-\d{2}-\d{2}$/.test(r.date || '')).sort((a,b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  const today = isoDay(0);
  const reported = rows.filter(r => r.epsActual != null && r.date <= today);
  const l = reported[reported.length - 1] || null;
  const n = rows.find(r => r.date >= today && r.epsActual == null) || null;
  const num = v => v == null || !isFinite(Number(v)) ? null : Number(v);
  let last = l ? { date: l.date, quarter: l.quarter || null, year: l.year || null, hour: l.hour || '', epsActual: num(l.epsActual), epsEstimate: num(l.epsEstimate),
    surprisePct: num(l.epsEstimate) ? (num(l.epsActual) - num(l.epsEstimate)) / Math.abs(num(l.epsEstimate)) * 100 : null } : null;
  if (!last) {
    let hist = [];
    try { hist = await get('/stock/earnings', { symbol: symbol, limit: 4 }, token); } catch (e) {}
    const h = (Array.isArray(hist) ? hist : []).filter(x => x && x.actual != null && x.period).sort((a,b) => a.period < b.period ? 1 : -1)[0];
    if (h) last = { date: null, quarter: h.quarter || null, year: h.year || null, hour: '', epsActual: num(h.actual), epsEstimate: num(h.estimate),
      surprisePct: num(h.surprisePercent) };
  }
  const next = n ? { date: n.date, hour: n.hour || '', epsEstimate: num(n.epsEstimate) } : null;
  return put('edates', symbol, { last, next });
}

// Display strings for earningsDates() in the given UI copy (falls back to English):
//   { days: '24d' | 'today' | '—', date: 'Nov 19 · after close', last: 'Last Aug 27 · beat by 3.8%' }
function earningsText(ed, u){
  const t = Object.assign({ edToday:'today', edBmo:'before open', edAmc:'after close', edDmh:'during market', edNext:'Next',
    edLast:'Last', edBeat:'beat by', edMiss:'missed by', edInline:'in line', edTba:'next date not announced yet' }, u || {});
  const day = iso => {
    const d = new Date(iso + 'T12:00:00Z'), opts = { month:'short', day:'numeric', timeZone:'UTC' };
    if (d.getUTCFullYear() !== new Date().getUTCFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString(window.HIF_LOCALE || [], opts);
  };
  const when = h => ({ bmo:t.edBmo, amc:t.edAmc, dmh:t.edDmh })[h] || '';
  const out = { days:'—', date: ed && ed.last ? t.edTba : '—', last:'' };
  if (ed && ed.next) {
    const n = Math.round((Date.parse(ed.next.date + 'T00:00:00Z') - Date.parse(isoDay(0) + 'T00:00:00Z')) / 86400000);
    out.days = n <= 0 ? t.edToday : n + 'd';
    out.date = t.edNext + ' ' + day(ed.next.date) + (when(ed.next.hour) ? ' · ' + when(ed.next.hour) : '');
  }
  if (ed && ed.last) {
    const s = ed.last.surprisePct;
    const res = s == null ? '' : Math.abs(s) < 0.5 ? t.edInline : (s > 0 ? t.edBeat : t.edMiss) + ' ' + Math.abs(s).toLocaleString(window.HIF_LOCALE || [], { minimumFractionDigits:1, maximumFractionDigits:1 }) + '%';
    const which = ed.last.date ? day(ed.last.date) : (ed.last.quarter && ed.last.year ? 'Q' + ed.last.quarter + ' FY' + ed.last.year : '');
    out.last = (t.edLast + ' ' + which).trim() + (res ? ' · ' + res : '');
  }
  return out;
}

// Candles for the live chart page (the gateway's /candles): { t, o, h, l, c, v, currency,
// tz, delay, price, prevClose, exchange, marketTime }. tail: today's bars only (a refresh).
// Not cached here: the gateway and the CDN keep them for a few seconds.
async function candles(symbol, interval, tail){
  if (proxyState === 'no') return null;
  const j = await callProxy('/candles', tail ? { symbol: symbol, interval: interval, tail: '1' } : { symbol: symbol, interval: interval });
  if (!j || !Array.isArray(j.t)) return null;
  return j;
}

// The last 30 days of filings and insider dealings (the gateway's /filings):
//   { items: [{ type:'insider'|'filing', datetime, title, url, source, official, act, who, shares, value, form }],
//     coverage: 'issuer'|'press'|'sec'|'none' }
// null when it couldn't be read (no proxy, signed out for a US ticker, an error).
async function filings(symbol){
  if (proxyState === 'no') return null;
  const hit = fresh('filings', symbol); if (hit) return hit;
  let j;
  try { j = await callProxy('/filings', { symbol: symbol }); } catch (e) { return null; }
  if (!j || !Array.isArray(j.items)) return null;
  return put('filings', symbol, { items: j.items.filter(x => x && (x.type === 'insider' || x.type === 'filing') && x.datetime), coverage: j.coverage || 'none' });
}

// { buyPct, detail } from the most recent recommendation period, or null when the plan blocks it.
async function recommendation(symbol, token){
  if (!available(token) || !hasRecs(symbol)) return null;
  const hit = fresh('recs', symbol); if (hit) return hit;
  if (await useSb()) { try { return (await sbRecs([symbol]))[symbol] || null; } catch (e) { return null; } }
  if (fresh('recsfail', symbol)) return null;
  let j;
  // A failed call (busy, rate limited, a plan without this market) is not asked again for a
  // day: before, BMW.DE's always-refused request went out on every 5-minute refresh.
  try { j = await get('/stock/recommendation', { symbol: symbol }, token); }
  catch (e) { put('recsfail', symbol, true); return null; }
  const r = Array.isArray(j) && j.length ? j[0] : null;
  if (!r) return put('recs', symbol, null);
  const buy = (r.strongBuy || 0) + (r.buy || 0), hold = r.hold || 0, sell = (r.sell || 0) + (r.strongSell || 0);
  const total = buy + hold + sell;
  if (!total) return put('recs', symbol, null);
  return put('recs', symbol, { buyPct: Math.round(buy / total * 100) + '%', detail: buy + ' / ' + hold + ' / ' + sell, period: r.period || '' });
}

// US listings: the SEC's public list of Nasdaq, NYSE and Cboe tickers (us-tickers.json, written by
// tools/update-us-catalog.mjs), read once, on the first search. The Cloudflare gateway has no US
// search (Finnhub is not used there), so without it US shares could not be found (2026-10-24).
let usList = null;
function usCatalog(){
  if (!usList) usList = fetch(new URL('../shared/us-tickers.json', location.href).toString())
    .then(r => r.ok ? r.json() : null).then(j => (j && Array.isArray(j.rows) ? j.rows : []))
    .catch(() => { usList = null; return []; });
  return usList;
}
// The same ranking as the European catalog: exact symbol or name, symbol start, name start, a
// word of the name, then (3+ letters) anywhere in the name.
function usSearch(rows, q, limit){
  const f = String(q || '').toUpperCase().trim();
  if (!f) return [];
  const hits = [];
  for (const r of rows) {
    const sym = r[0], name = String(r[1]).toUpperCase();
    const rank = sym === f || name === f ? 0 : sym.startsWith(f) ? 1 : name.startsWith(f) ? 2 : name.indexOf(' ' + f) >= 0 ? 3 : f.length >= 3 && name.indexOf(f) >= 0 ? 4 : -1;
    if (rank >= 0) hits.push([rank, r]);
  }
  return hits.sort((a, b) => a[0] - b[0] || a[1][0].localeCompare(b[1][0])).slice(0, limit || 8)
    .map(h => ({ ticker: h[1][0], name: h[1][1], exchange: h[1][2] }));
}

// Bucharest, XETRA and London listings come from the local catalogs (hif-bvb.js, hif-eu.js),
// US ones from the SEC list above (and Finnhub, where a gateway still has it); the catalogs'
// matches go first.
async function search(q, token){
  // "NVDA.US" is how the apps show US listings; the providers know it as "NVDA".
  q = String(q || '').replace(/\.us$/i, '');
  if (!q) return null;
  const us = /\.(ro|de|l)$/i.test(q) ? [] : usSearch(await usCatalog(), q, 8);
  const local = (window.HIFBVB ? window.HIFBVB.search(q, 6) : []).concat(window.HIFEU ? window.HIFEU.search(q, 6) : [])
    .map(r => ({ ticker: r.ticker, name: r.name, exchange: r.exchange })).concat(us);
  if (!available(token)) return local.length ? local : null;
  // The SEC list answered: no gateway call (it would spend quota, or fail on Cloudflare).
  if (us.length) return local;
  // An exact Bucharest, London or Frankfurt symbol outside the catalog (PZC.L): offered when
  // the market data knows it, under its own name.
  const exact = /^[A-Za-z0-9][A-Za-z0-9-]{0,9}\.(l|de|ro)$/i.exec(q);
  if (exact && !local.some(r => r.ticker.toUpperCase() === q.toUpperCase())) {
    const sym = q.toUpperCase();
    try { const p = await profile(sym, token); if (p && p.name) local.unshift({ ticker: sym, name: p.name, exchange: /\.L$/.test(sym) ? 'LSE' : /\.RO$/.test(sym) ? 'BVB' : 'XETRA' }); } catch (e) {}
  }
  const hit = fresh('search', q);
  let rows = hit, failed = null;
  if (!rows) {
    // A failed US search (busy, rate limited) isn't remembered, and doesn't stop the
    // London, Frankfurt and Bucharest tries below, which come from other market data.
    let j = null;
    try { j = await get('/search', { q: q }, token); } catch (e) { failed = e; }
    const found = ((j && j.result) || [])
      // US listings: plain symbols and share classes (BRK.B, BF.A); other exchanges' listings
      // ("BMW.DE") come from the catalogs above.
      .filter(r => r.symbol && (r.symbol.indexOf('.') < 0 || /^[A-Z]{1,5}\.[A-C]$/.test(r.symbol)) && r.type !== 'Crypto')
      .slice(0, 12)
      .map(r => ({ ticker: r.symbol, name: r.description || r.displaySymbol || r.symbol }));
    rows = failed ? found : put('search', q, found);
  }
  const all = local.concat(rows.filter(r => !local.some(x => x.ticker === r.ticker)));
  // A bare symbol ("pzc") that matches nothing exactly: the same symbol in London,
  // Frankfurt and Bucharest, where the market data knows it (PZC -> PZC.L).
  const bare = /^[A-Za-z0-9]{2,6}$/.test(q) ? q.toUpperCase() : '';
  if (bare && !all.some(r => r.ticker.toUpperCase() === bare || r.ticker.toUpperCase().split('.')[0] === bare)) {
    const tries = [['.L', 'LSE'], ['.DE', 'XETRA'], ['.RO', 'BVB']].map(([suf, ex]) =>
      profile(bare + suf, token).then(p => p && p.name ? { ticker: bare + suf, name: p.name, exchange: ex } : null).catch(() => null));
    (await Promise.all(tries)).filter(Boolean).forEach(r => all.unshift(r));
  }
  if (!all.length && failed) throw failed;
  return all;
}

// Batched. { quotes, news, recs, errors, mode }
async function load(symbols, token, opts){
  const o = opts || {};
  const out = { quotes:{}, news:{}, recs:{}, errors:[], mode:'off' };
  if (!symbols || !symbols.length || !available(token)) return out;
  if (await useSb()) {
    // Three requests, whatever the number of symbols.
    const [q, n, r] = await Promise.all([
      sbQuotes(symbols).catch(e => { out.errors.push('quotes: ' + e.message); return {}; }),
      o.news === false ? {} : sbNews(symbols).catch(e => { out.errors.push('news: ' + e.message); return {}; }),
      o.recs === false ? {} : sbRecs(symbols).catch(e => { out.errors.push('recs: ' + e.message); return {}; })
    ]);
    const lim = o.newsLimit || 300;
    Object.keys(n).forEach(s => { n[s] = n[s].slice(0, lim); });
    return Object.assign(out, { quotes: q, news: n, recs: r, mode: 'supabase' });
  }
  // Every quote in one request first; news and analysts are per symbol.
  try { out.quotes = await quotes(symbols, token); } catch (e) { out.errors.push('quotes: ' + e.message); }
  for (const sym of symbols) {
    try {
      const [q, n, r] = await Promise.all([
        out.quotes[sym] ? out.quotes[sym] : quote(sym, token),
        o.news === false ? null : news(sym, token, o.newsLimit || 300),
        o.recs === false ? null : recommendation(sym, token)
      ]);
      if (q) out.quotes[sym] = q;
      if (n) out.news[sym] = n;
      if (r) out.recs[sym] = r;
    } catch (e) { out.errors.push(sym + ': ' + e.message); }
  }
  out.mode = proxyState === 'yes' ? 'proxy' : (token ? 'direct' : 'off');
  return out;
}

// Feed day headers: "Today", "Yesterday", or "Fri, 10 Oct" (with the year outside this one).
function dayHead(sec, u){
  const d = new Date(sec * 1000), now = new Date(), day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return (u && u.dayToday) || 'Today';
  if (diff === 1) return (u && u.dayYesterday) || 'Yesterday';
  const opts = { weekday:'short', day:'numeric', month:'short' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(window.HIF_LOCALE || [], opts);
}

// The original article through Google Translate's web view, in the reader's language. The
// publisher's page is translated in the reader's browser; nothing is copied to this site.
// Paywalled articles stay paywalled.
function translatedUrl(url, lang){
  const tl = String(lang || '').toLowerCase();
  if (!/^https?:\/\//i.test(url || '') || !/^(ro|de)$/.test(tl)) return '';
  return 'https://translate.google.com/translate?sl=auto&tl=' + tl + '&hl=' + tl + '&u=' + encodeURIComponent(url);
}

window.HIFLive = { usesSupabase: useSb, usSearch, candles, filings, quote, quotes, roNews, euNews, translatedUrl, profile, news, dayHead, recommendation, search, chart, earnings, earningsDates, earningsText, load,
  get mode(){ return sbMode() ? 'supabase' : proxyState === 'yes' ? 'proxy' : (proxyState === 'no' ? 'direct-or-off' : 'unknown'); },
  clearCache(){ cache.clear(); } };
})();
