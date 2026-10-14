// Finnhub adapter for the Heard It First prototypes.
//
// Two ways in:
//   1. Proxy (preferred) — /api/finnhub?path=/quote&symbol=NVDA, key held in the Netlify env.
//   2. Direct — same endpoints on finnhub.io with a token passed from the page (dev only; the key is visible).
// The proxy is probed once; if it isn't there, calls fall back to direct. With neither, every
// function resolves to null and the templates keep rendering the demo data from hif-data.js.
//
// Free-tier endpoints only. /quotes (many symbols at once) exists only through the proxy.
(function(){
// The page runtime evaluates helmet scripts twice; a second copy would replace the
// adapter and throw away its response cache (so every refresh refetched everything).
if (window.HIFLive) return;
const DIRECT = 'https://finnhub.io/api/v1';
const PROXY = '/api/finnhub';
const cache = new Map();
const TTL = { ronews: 600000, profile: 24 * 3600000, quote: 60000, news: 300000, search: 300000, recs: 900000, chart: 300000, earnings: 900000, edates: 6 * 3600000 };
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
  if (res.status === 404 || res.status === 405) { proxyState = 'no'; return null; }
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
// Proxy first (unless known missing), then direct with the page token.
async function get(path, params, token){
  if (proxyState !== 'no') {
    try { const j = await callProxy(path, params); if (j) return j; }
    catch (e) { if (proxyState === 'unknown') proxyState = 'no'; else throw e; }
  }
  return callDirect(path, params, token);
}
function available(token){ return proxyState !== 'no' || !!token; }

function fmtPrice(v){ return v == null ? null : Number(v).toFixed(2); }
function fmtPct(v){ if (v == null) return null; const n = Number(v); return (n < 0 ? '−' : '+') + Math.abs(n).toFixed(1) + '%'; }
// When a story was published, in the reader's locale: "12 Oct · 10:24", with the year
// added for anything outside the current year.
function stamp(sec){
  const d = new Date(sec * 1000), p = n => String(n).padStart(2,'0');
  const opts = { day:'numeric', month:'short' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString([], opts) + ' · ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function isoDay(off){ return new Date(Date.now() + off * 86400000).toISOString().slice(0,10); }

async function quote(symbol, token){
  if (!available(token)) return null;
  const hit = fresh('quote', symbol); if (hit) return hit;
  const j = await get('/quote', { symbol: symbol }, token);
  return put('quote', symbol, shapeQuote(j));
}
// last/dp keep full precision for position maths; price/move are the display strings.
function shapeQuote(j){
  if (!j || j.c == null || j.c === 0) return null;
  return { price: fmtPrice(j.c), move: fmtPct(j.dp), up: Number(j.dp) >= 0, changeAbs: fmtPrice(j.d),
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
  need.sort();
  if (proxyState !== 'no' && batchQuotes) {
    try {
      const j = await callProxy('/quotes', { symbols: need.join(',') });
      if (j && j.quotes) {
        need.forEach(s => { const q = put('quote', s, shapeQuote(j.quotes[s])); if (q) out[s] = q; });
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
async function roNews(){
  const hit = fresh('ronews', 'all'); if (hit) return hit;
  if (proxyState === 'no') return null;
  const j = await callProxy('/ro-news', {});
  const rows = (Array.isArray(j) ? j : []).filter(n => n && n.headline && n.related).sort((a,b) => b.datetime - a.datetime).map(newsRow);
  return put('ronews', 'all', rows);
}

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
    return d.toLocaleDateString([], opts);
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
    const res = s == null ? '' : Math.abs(s) < 0.5 ? t.edInline : (s > 0 ? t.edBeat : t.edMiss) + ' ' + Math.abs(s).toFixed(1) + '%';
    const which = ed.last.date ? day(ed.last.date) : (ed.last.quarter && ed.last.year ? 'Q' + ed.last.quarter + ' FY' + ed.last.year : '');
    out.last = (t.edLast + ' ' + which).trim() + (res ? ' · ' + res : '');
  }
  return out;
}

// { buyPct, detail } from the most recent recommendation period, or null when the plan blocks it.
async function recommendation(symbol, token){
  if (!available(token)) return null;
  const hit = fresh('recs', symbol); if (hit) return hit;
  let j;
  try { j = await get('/stock/recommendation', { symbol: symbol }, token); }
  catch (e) { return put('recs', symbol, null); }
  const r = Array.isArray(j) && j.length ? j[0] : null;
  if (!r) return put('recs', symbol, null);
  const buy = (r.strongBuy || 0) + (r.buy || 0), hold = r.hold || 0, sell = (r.sell || 0) + (r.strongSell || 0);
  const total = buy + hold + sell;
  if (!total) return put('recs', symbol, null);
  return put('recs', symbol, { buyPct: Math.round(buy / total * 100) + '%', detail: buy + ' / ' + hold + ' / ' + sell, period: r.period || '' });
}

// Bucharest listings come from the local BVB catalog (hif-bvb.js), US ones from Finnhub;
// the catalog's matches go first when the query names a Romanian company or symbol.
async function search(q, token){
  // "NVDA.US" is how the apps show US listings; the providers know it as "NVDA".
  q = String(q || '').replace(/\.us$/i, '');
  if (!q) return null;
  const local = window.HIFBVB ? window.HIFBVB.search(q, 6).map(r => ({ ticker: r.ticker, name: r.name, exchange: r.exchange })) : [];
  if (!available(token)) return local.length ? local : null;
  const hit = fresh('search', q);
  let rows = hit;
  if (!rows) {
    let j = null;
    try { j = await get('/search', { q: q }, token); } catch (e) { if (!local.length) throw e; }
    rows = put('search', q, ((j && j.result) || [])
      .filter(r => r.symbol && r.symbol.indexOf('.') < 0 && r.type !== 'Crypto')
      .slice(0, 12)
      .map(r => ({ ticker: r.symbol, name: r.description || r.displaySymbol || r.symbol })));
  }
  return local.concat(rows.filter(r => !local.some(x => x.ticker === r.ticker)));
}

// Batched. { quotes, news, recs, errors, mode }
async function load(symbols, token, opts){
  const o = opts || {};
  const out = { quotes:{}, news:{}, recs:{}, errors:[], mode:'off' };
  if (!symbols || !symbols.length || !available(token)) return out;
  // Every quote in one request first; news and analysts are per symbol.
  try { out.quotes = await quotes(symbols, token); } catch (e) { out.errors.push('quotes: ' + e.message); }
  for (const sym of symbols) {
    try {
      const [q, n, r] = await Promise.all([
        out.quotes[sym] ? out.quotes[sym] : quote(sym, token),
        o.news === false ? null : news(sym, token, o.newsLimit || 10),
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
  return d.toLocaleDateString([], opts);
}

// The original article through Google Translate's web view, in the reader's language. The
// publisher's page is translated in the reader's browser; nothing is copied to this site.
// Paywalled articles stay paywalled.
function translatedUrl(url, lang){
  const tl = String(lang || '').toLowerCase();
  if (!/^https?:\/\//i.test(url || '') || !/^(ro|de)$/.test(tl)) return '';
  return 'https://translate.google.com/translate?sl=auto&tl=' + tl + '&hl=' + tl + '&u=' + encodeURIComponent(url);
}

window.HIFLive = { quote, quotes, roNews, translatedUrl, profile, news, dayHead, recommendation, search, chart, earnings, earningsDates, earningsText, load,
  get mode(){ return proxyState === 'yes' ? 'proxy' : (proxyState === 'no' ? 'direct-or-off' : 'unknown'); },
  clearCache(){ cache.clear(); } };
})();
