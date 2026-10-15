#!/usr/bin/env node
// The live chart's second bars for US stocks: a relay on the PC (systemd user unit
// market-pulse-relay.service), reached by the browsers through Tailscale Funnel.
//
//   Finnhub WebSocket (one connection, the key stays here)
//     -> trades folded into 1-second bars per symbol, the last 3 hours kept in memory
//     -> GET /stream?symbol=NVDA&token=<Supabase access token>: Server-Sent Events,
//        "history" (the bars so far) then a "bars" event every second with what changed.
// Only approved accounts are served (the same check as the market data gateway). Symbols
// on any US watchlist or holding are listened to all the time, so their history is there
// when a chart opens; any other US symbol from the moment someone opens it, until nobody
// has watched it for two minutes. Finnhub's free plan allows 50 symbols at once.
//
// Settings: ~/.config/market-pulse/relay.env (chmod 600):  FINNHUB_KEY=...
//   and from ~/.config/market-pulse/summarizer.env: SUPABASE_URL, SUPABASE_ANON_KEY, SUMMARY_SECRET.
//   RELAY_PORT (8787), RELAY_ORIGINS (the app's origins, comma separated).
//   node tools/live-relay.mjs
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

for (const f of ['summarizer.env', 'relay.env']) {
  try {
    for (const line of readFileSync(join(homedir(), '.config/market-pulse', f), 'utf8').split('\n')) {
      const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {}
}
const env = process.env;
const PORT = Number(env.RELAY_PORT) || 8787;
const ORIGINS = String(env.RELAY_ORIGINS || 'https://aa-market-pulse.netlify.app,https://staging--aa-market-pulse.netlify.app').split(',').map(s => s.trim()).filter(Boolean);
const SUPA = (env.SUPABASE_URL || '').replace(/\/$/, ''), ANON = env.SUPABASE_ANON_KEY || '';
const KEEP_SEC = 3 * 3600;          // bars kept per symbol
const MAX_SYMBOLS = 48;             // under Finnhub's 50
const IDLE_MS = 120_000;            // an unwatched, non-watchlist symbol is dropped after this
const MAX_PER_IP = 12;
export const SYMBOL_RE = /^[A-Z][A-Z0-9]{0,5}(?:\.[A-Z])?$/;   // US tickers: NVDA, BRK.B
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ------------------------------------------------------------------ bars
// sym -> { bars: [{ t, o, h, l, c, v }], dirty: Set<t>, watchers: Set<res>, pinned, idleSince }
const syms = new Map();
export function addTrade(st, priceT, price, vol) {
  const t = Math.floor(priceT / 1000);
  const b = st.bars.length ? st.bars[st.bars.length - 1] : null;
  if (b && b.t === t) { b.h = Math.max(b.h, price); b.l = Math.min(b.l, price); b.c = price; b.v += vol || 0; }
  else if (!b || t > b.t) { st.bars.push({ t, o: price, h: price, l: price, c: price, v: vol || 0 }); }
  else {
    // A late trade for an earlier second: fold it into that second if still kept.
    const old = st.bars.find(x => x.t === t);
    if (!old) return;
    old.h = Math.max(old.h, price); old.l = Math.min(old.l, price); old.v += vol || 0;
  }
  st.dirty.add(t);
  const cut = t - KEEP_SEC;
  while (st.bars.length && st.bars[0].t < cut) st.bars.shift();
}
const stateFor = sym => {
  if (!syms.has(sym)) syms.set(sym, { bars: [], dirty: new Set(), watchers: new Set(), pinned: false, idleSince: Date.now() });
  return syms.get(sym);
};

// ------------------------------------------------------------------ Finnhub
let ws = null, wsOpen = false, retry = 1000;
const subscribed = new Set();
function send(msg) { if (ws && wsOpen) ws.send(JSON.stringify(msg)); }
function want(sym) { if (!subscribed.has(sym)) { subscribed.add(sym); send({ type: 'subscribe', symbol: sym }); } }
function unwant(sym) { if (subscribed.delete(sym)) send({ type: 'unsubscribe', symbol: sym }); }
function connect() {
  if (!env.FINNHUB_KEY) { log('FINNHUB_KEY is not set in ~/.config/market-pulse/relay.env'); return; }
  ws = new WebSocket('wss://ws.finnhub.io?token=' + encodeURIComponent(env.FINNHUB_KEY));
  ws.onopen = () => { wsOpen = true; retry = 1000; log('finnhub connected'); for (const s of subscribed) ws.send(JSON.stringify({ type: 'subscribe', symbol: s })); };
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type !== 'trade' || !Array.isArray(m.data)) return;
    for (const x of m.data) if (syms.has(x.s) && Number.isFinite(x.p) && Number.isFinite(x.t)) addTrade(syms.get(x.s), x.t, x.p, x.v);
  };
  ws.onclose = () => { wsOpen = false; log('finnhub closed; reconnecting in', retry / 1000, 's'); setTimeout(connect, retry); retry = Math.min(retry * 2, 60_000); };
  ws.onerror = () => {};
}

// ------------------------------------------------------------------ who may watch
const users = new Map(); // token -> { ok, until }
async function approved(token) {
  if (!token || token.length > 4096 || !SUPA || !ANON) return false;
  const hit = users.get(token), now = Date.now();
  if (hit && hit.until > now) return hit.ok;
  let ok = false;
  try {
    const h = { apikey: ANON, authorization: 'Bearer ' + token };
    const u = await fetch(SUPA + '/auth/v1/user', { headers: h, signal: AbortSignal.timeout(5000) });
    const user = u.ok ? await u.json() : null;
    if (user && user.id) {
      const r = await fetch(SUPA + '/rest/v1/account_status?select=approved,suspended&user_id=eq.' + encodeURIComponent(user.id), { headers: h, signal: AbortSignal.timeout(5000) });
      const rows = r.ok ? await r.json() : [];
      ok = !!(rows[0] && rows[0].approved && !rows[0].suspended);
    }
  } catch { return false; }
  if (users.size > 2000) users.clear();
  users.set(token, { ok, until: now + (ok ? 300_000 : 60_000) });
  return ok;
}

// The US symbols on anyone's watchlist or in anyone's holdings (supabase/approval.sql relay_symbols).
async function pinWatchlists() {
  if (!SUPA || !env.SUMMARY_SECRET) return;
  try {
    const r = await fetch(SUPA + '/rest/v1/rpc/relay_symbols', { method: 'POST',
      headers: { apikey: ANON, authorization: 'Bearer ' + ANON, 'content-type': 'application/json' },
      body: JSON.stringify({ p_secret: env.SUMMARY_SECRET }), signal: AbortSignal.timeout(10000) });
    const list = r.ok ? await r.json() : [];
    const pinned = new Set((Array.isArray(list) ? list : []).map(x => x.ticker || x).filter(s => SYMBOL_RE.test(s)).slice(0, MAX_SYMBOLS - 8));
    for (const [s, st] of syms) st.pinned = pinned.has(s);
    for (const s of pinned) { stateFor(s).pinned = true; want(s); }
  } catch (e) { log('watchlists:', e.message); }
}

// ------------------------------------------------------------------ HTTP (SSE)
const perIp = new Map();
const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://relay'), origin = req.headers.origin || '';
  const cors = ORIGINS.includes(origin) ? { 'access-control-allow-origin': origin, vary: 'origin' } : {};
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', ...cors });
    return res.end(JSON.stringify({ ok: true, finnhub: wsOpen, symbols: syms.size, watchers: [...syms.values()].reduce((n, s) => n + s.watchers.size, 0) }));
  }
  if (url.pathname !== '/stream' || req.method !== 'GET') { res.writeHead(404, cors); return res.end(); }
  if (origin && !cors['access-control-allow-origin']) { res.writeHead(403); return res.end(); }
  const sym = String(url.searchParams.get('symbol') || '').toUpperCase();
  if (!SYMBOL_RE.test(sym)) { res.writeHead(400, cors); return res.end('bad symbol'); }
  if (!(await approved(url.searchParams.get('token') || ''))) { res.writeHead(401, cors); return res.end('not allowed'); }
  // Behind Tailscale Funnel the client's address is in X-Forwarded-For.
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if ((perIp.get(ip) || 0) >= MAX_PER_IP) { res.writeHead(429, cors); return res.end(); }
  if (!syms.has(sym) && syms.size >= MAX_SYMBOLS) { res.writeHead(503, cors); return res.end('busy'); }
  const st = stateFor(sym);
  want(sym);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no', ...cors });
  res.write('retry: 3000\n\n');
  sse(res, 'history', { symbol: sym, bars: st.bars, live: wsOpen });
  st.watchers.add(res);
  perIp.set(ip, (perIp.get(ip) || 0) + 1);
  req.on('close', () => {
    st.watchers.delete(res); st.idleSince = Date.now();
    perIp.set(ip, Math.max(0, (perIp.get(ip) || 1) - 1));
  });
});

// Every second: what changed, to each symbol's watchers; idle symbols dropped.
function tick() {
  const now = Date.now();
  for (const [sym, st] of syms) {
    if (st.dirty.size && st.watchers.size) {
      const changed = st.bars.filter(b => st.dirty.has(b.t));
      for (const res of st.watchers) sse(res, 'bars', { bars: changed, live: wsOpen });
    }
    st.dirty.clear();
    if (!st.pinned && !st.watchers.size && now - st.idleSince > IDLE_MS) { unwant(sym); syms.delete(sym); }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, '127.0.0.1', () => log('relay on 127.0.0.1:' + PORT));
  setInterval(tick, 1000);
  // A comment line keeps idle connections open through proxies.
  setInterval(() => { for (const st of syms.values()) for (const res of st.watchers) res.write(': keep-alive\n\n'); }, 20_000);
  connect();
  pinWatchlists();
  setInterval(pinWatchlists, 15 * 60_000);
}
