// Finnhub adapter for the Heard It First prototypes.
//
// Two ways in:
//   1. Proxy (preferred) — /api/finnhub?path=/quote&symbol=NVDA, key held in the Netlify env.
//   2. Direct — same endpoints on finnhub.io with a token passed from the page (dev only; the key is visible).
// The proxy is probed once; if it isn't there, calls fall back to direct. With neither, every
// function resolves to null and the templates keep rendering the demo data from hif-data.js.
//
// Free-tier endpoints only: /quote, /company-news, /search, /stock/recommendation.
(function(){
const DIRECT = 'https://finnhub.io/api/v1';
const PROXY = '/api/finnhub';
const cache = new Map();
const TTL = { quote: 60000, news: 300000, search: 300000, recs: 900000 };
let proxyState = 'unknown'; // 'unknown' | 'yes' | 'no'

function fresh(kind, arg){
  const hit = cache.get(kind + ':' + arg);
  return hit && (Date.now() - hit.at) < TTL[kind] ? hit.value : null;
}
function put(kind, arg, value){ cache.set(kind + ':' + arg, { at: Date.now(), value: value }); return value; }

function qs(params){
  return Object.keys(params).filter(k => params[k] != null && params[k] !== '')
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&');
}

async function callProxy(path, params){
  const res = await fetch(PROXY + '?' + qs(Object.assign({ path: path }, params)));
  if (res.status === 404 || res.status === 405) { proxyState = 'no'; return null; }
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
function stamp(sec){ const d = new Date(sec * 1000), p = n => String(n).padStart(2,'0'); return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }
function isoDay(off){ return new Date(Date.now() + off * 86400000).toISOString().slice(0,10); }

async function quote(symbol, token){
  if (!available(token)) return null;
  const hit = fresh('quote', symbol); if (hit) return hit;
  const j = await get('/quote', { symbol: symbol }, token);
  if (!j || j.c == null || j.c === 0) return put('quote', symbol, null);
  return put('quote', symbol, { price: fmtPrice(j.c), move: fmtPct(j.dp), up: Number(j.dp) >= 0, changeAbs: fmtPrice(j.d) });
}

async function news(symbol, token, limit){
  if (!available(token)) return null;
  const hit = fresh('news', symbol); if (hit) return hit.slice(0, limit || 8);
  const j = await get('/company-news', { symbol: symbol, from: isoDay(-2), to: isoDay(0) }, token);
  const rows = (Array.isArray(j) ? j : []).filter(n => n && n.headline)
    .sort((a,b) => b.datetime - a.datetime)
    .map(n => ({ headline: n.headline, source: n.source || '', stamp: stamp(n.datetime), ts: n.datetime, url: n.url || '',
      summary: (n.summary || '').replace(/\s+/g, ' ').trim().slice(0, 160) }));
  put('news', symbol, rows);
  return rows.slice(0, limit || 8);
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

async function search(q, token){
  if (!q || !available(token)) return null;
  const hit = fresh('search', q); if (hit) return hit;
  const j = await get('/search', { q: q }, token);
  const rows = ((j && j.result) || [])
    .filter(r => r.symbol && r.symbol.indexOf('.') < 0 && r.type !== 'Crypto')
    .slice(0, 12)
    .map(r => ({ ticker: r.symbol, name: r.description || r.displaySymbol || r.symbol }));
  return put('search', q, rows);
}

// Batched. { quotes, news, recs, errors, mode }
async function load(symbols, token, opts){
  const o = opts || {};
  const out = { quotes:{}, news:{}, recs:{}, errors:[], mode:'off' };
  if (!symbols || !symbols.length || !available(token)) return out;
  for (const sym of symbols) {
    try {
      const [q, n, r] = await Promise.all([
        quote(sym, token),
        o.news === false ? null : news(sym, token, 6),
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

window.HIFLive = { quote, news, recommendation, search, load,
  get mode(){ return proxyState === 'yes' ? 'proxy' : (proxyState === 'no' ? 'direct-or-off' : 'unknown'); },
  clearCache(){ cache.clear(); } };
})();
