// Heard It First — one small server with three jobs:
//   1. serve the built front-end out of ./public
//   2. proxy Finnhub, so the API token never reaches the browser
//   3. read and write each user's settings, authenticated by their Supabase session
//
// Security posture (see ../SECURITY.md for the full audit):
//   - every response carries CSP and the hardening headers; no third-party origins
//   - every /api route is rate limited per client IP with a token bucket
//   - upstream query strings are rebuilt from an allowlist, never forwarded
//   - state-changing requests must be same-origin and carry a Bearer token
//   - upstream and database errors never reach the client verbatim
//
// Start: npm install && npm start   (reads ./.env, or use systemd EnvironmentFile)
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Load .env without a dependency (systemd's EnvironmentFile does this too).
try {
  for (const line of readFileSync(join(here, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const PORT = Number(process.env.PORT || 8080);
const PROD = process.env.NODE_ENV === 'production';
const { SUPABASE_URL, SUPABASE_ANON_KEY, FINNHUB_TOKEN } = process.env;
// Comma-separated list of origins the browser may load this app from, e.g.
// "https://hif.example.com". Required in production: it is what makes the
// same-origin check on writes meaningful behind a reverse proxy.
const ORIGINS = String(process.env.PUBLIC_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
// Number of reverse proxies in front of this process. 0 = none (default):
// X-Forwarded-For is then ignored, so a client cannot spoof its rate-limit key.
const TRUST_PROXY = Number(process.env.TRUST_PROXY || 0);

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY — copy .env.example to .env first.');
  process.exit(1);
}
if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(SUPABASE_URL)) {
  console.error('SUPABASE_URL must be the https project URL, e.g. https://abcd.supabase.co');
  process.exit(1);
}
if (PROD && !ORIGINS.length) {
  console.error('Set PUBLIC_ORIGIN in production (e.g. https://hif.example.com).');
  process.exit(1);
}
if (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY) {
  console.error('Refusing to start: a service_role key is in the environment. This process must only ever hold the anon key.');
  process.exit(1);
}
// /api/config hands SUPABASE_ANON_KEY to every browser, so it must provably be the public
// key: a legacy JWT with role 'anon', or a new-style publishable key. A secret key pasted
// into the wrong variable would otherwise be published.
{
  const parts = SUPABASE_ANON_KEY.split('.');
  let role = null;
  try { if (parts.length === 3) role = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).role; } catch {}
  if (!/^sb_publishable_/.test(SUPABASE_ANON_KEY) && role !== 'anon') {
    console.error('Refusing to start: SUPABASE_ANON_KEY is not the public anon key (it would be served to browsers).');
    process.exit(1);
  }
}

const app = express();
app.disable('x-powered-by');
app.disable('etag');
app.set('trust proxy', TRUST_PROXY);
app.set('query parser', 'simple');

const SUPABASE_ORIGIN = new URL(SUPABASE_URL).origin;

// ---- operational counters ---------------------------------------------
// Read by the admin process over a loopback-only listener (see the bottom of
// this file). Counts only — no user ids, tokens, IPs or error details.
const stats = {
  startedAt: Date.now(),
  requests: { total: 0, s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0 },
  rateLimited: {},
  errors: { total: 0, recent: [] },
  finnhub: { upstream: 0, upstreamErrors: 0, cacheHits: 0, coalesced: 0, recent: [] },
  blocked: { suspended: 0, revoked: 0 }
};
app.use((_req, res, next) => {
  res.on('finish', () => {
    stats.requests.total++;
    const k = 's' + String(res.statusCode)[0] + 'xx';
    if (k in stats.requests) stats.requests[k]++;
  });
  next();
});

// ---- headers ----------------------------------------------------------
// One CSP for the whole app. connect-src has to include Supabase because
// sign-in talks to it straight from the browser; nothing else is allowed out.
// NOTE: the built front-end inlines its scripts and styles, so 'unsafe-inline'
// is still required for script-src. Moving to per-response nonces is the single
// biggest remaining hardening step — tracked in SECURITY.md.
const CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline' blob:",
  // The single-file bundle unpacks its assets into blob: URLs and the component
  // runtime compiles its templates at load, so blob: and 'unsafe-eval' are required.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
  `connect-src 'self' data: blob: ${SUPABASE_ORIGIN}`,
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  // Only over TLS: on plain-http LAN this would rewrite /api calls to https and break them.
  ...(PROD ? ["upgrade-insecure-requests"] : [])
].join('; ');

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Vary', 'Origin');
  // Only meaningful once TLS terminates in front of this process.
  if (PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// ---- rate limiting ----------------------------------------------------
// Token bucket per client IP per bucket name. In-memory on purpose: one
// process, one box. Behind several instances, move this to Redis.
const buckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now - b.seen > 600_000) buckets.delete(k);
}, 120_000).unref();

function clientIp(req) {
  // With trust proxy 0 this is the socket address — not attacker-controlled.
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function limit(name, perMinute, burst) {
  const capacity = burst || perMinute;
  const refill = perMinute / 60_000; // tokens per ms
  return (req, res, next) => {
    const key = name + '|' + clientIp(req);
    const now = Date.now();
    let b = buckets.get(key);
    if (!b) { b = { tokens: capacity, at: now, seen: now }; buckets.set(key, b); }
    b.tokens = Math.min(capacity, b.tokens + (now - b.at) * refill);
    b.at = now; b.seen = now;
    if (b.tokens < 1) {
      stats.rateLimited[name] = (stats.rateLimited[name] || 0) + 1;
      res.setHeader('Retry-After', Math.ceil((1 - b.tokens) / refill / 1000));
      return res.status(429).json({ error: 'rate_limited' });
    }
    b.tokens -= 1;
    next();
  };
}

// ---- request hygiene --------------------------------------------------
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'HEAD', 'PUT', 'POST'].includes(req.method)) return res.status(405).json({ error: 'method_not_allowed' });
  // Cross-site writes: the API is Bearer-authenticated, so a cookie-less CSRF
  // is already out of reach, but an origin check costs nothing and stops a
  // mis-configured page from driving the API on a user's behalf.
  if (req.method === 'PUT' || req.method === 'POST') {
    const origin = req.get('origin');
    if (origin) {
      const allowed = ORIGINS.length ? ORIGINS : [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];
      if (!allowed.includes(origin)) return res.status(403).json({ error: 'bad_origin' });
    } else if (PROD) {
      return res.status(403).json({ error: 'origin_required' });
    }
    const ct = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (ct !== 'application/json') return res.status(415).json({ error: 'expected_json' });
  }
  next();
});
app.use('/api', express.json({ limit: '32kb', strict: true }));
app.use('/api', (err, _req, res, _next) => {
  if (err) return res.status(err.type === 'entity.too.large' ? 413 : 400).json({ error: 'bad_body' });
});

// Never leak details of what went wrong internally; log once, answer generically.
let errSeq = 0;
function fail(res, status, code, detail) {
  const ref = (++errSeq).toString(36);
  stats.errors.total++;
  stats.errors.recent.unshift({ at: Date.now(), code, status, ref });
  stats.errors.recent.length = Math.min(stats.errors.recent.length, 20);
  if (detail) console.error(`[${new Date().toISOString()}] ${code} ref=${ref}:`, String(detail).slice(0, 300));
  res.status(status).json({ error: code, ref });
}

// The browser needs these two values to talk to Supabase directly for sign-in.
// Both are public by design; the anon key is safe here, the service_role key never is.
app.get('/api/config', limit('config', 60), (_req, res) => {
  const vapid = process.env.VAPID_PUBLIC_KEY || '';
  res.json({ supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON_KEY, liveData: !!FINNHUB_TOKEN,
    vapidPublicKey: /^[A-Za-z0-9_-]{87}$/.test(vapid) ? vapid : null });
});

app.get('/api/health', limit('health', 60), (_req, res) => res.json({ ok: true }));

// ---- auth -------------------------------------------------------------
// Every /api/settings call carries the user's access token. We hand it to
// Supabase to identify the caller, then let RLS enforce what they may touch.
// Verified tokens are memoised for 30s (keyed by hash, never by the token) so a
// busy client does not turn every request into a round trip to the auth server.
const verified = new Map();
const VERIFY_TTL = 30_000;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of verified) if (now - v.at > VERIFY_TTL) verified.delete(k);
}, 30_000).unref();

function bearer(req) {
  const auth = req.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  // A Supabase access token is a JWT: three dot-separated base64url segments.
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) || token.length > 4096) return null;
  return token;
}

function clientFor(token) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

// Issued-at of an access token Supabase has already verified (decoding only).
function tokenIat(token) {
  try { return Number(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).iat) || 0; }
  catch { return 0; }
}

// account_status is written only by the admin process. A suspended account, or
// a token issued before an admin forced a sign-out, is refused here. Because of
// the 30 s verify memo, either takes effect within 30 seconds.
async function accountBlock(db, user, token) {
  const { data, error } = await db.from('account_status').select('suspended, revoked_before, plan').eq('user_id', user.id).maybeSingle();
  // Before schema.sql's admin section has been applied the table does not exist;
  // nobody can be suspended yet, so carry on. Any other failure still blocks.
  if (error && (error.code === 'PGRST205' || error.code === '42P01')) return { account: { plan: 'free' } };
  if (error) return { status: 503, code: 'account_check_failed', detail: error.message };
  if (data?.suspended) { stats.blocked.suspended++; return { status: 403, code: 'account_suspended' }; }
  if (data?.revoked_before && tokenIat(token) * 1000 < Date.parse(data.revoked_before)) { stats.blocked.revoked++; return { status: 401, code: 'session_revoked' }; }
  return { account: { plan: data?.plan || 'free' } };
}

async function requireUser(req, res) {
  const token = bearer(req);
  if (!token) { res.status(401).json({ error: 'no_token' }); return null; }
  const key = createHash('sha256').update(token).digest('hex');
  const hit = verified.get(key);
  if (hit && Date.now() - hit.at < VERIFY_TTL) return { db: clientFor(token), user: hit.user, account: hit.account };
  const db = clientFor(token);
  const { data, error } = await db.auth.getUser();
  if (error || !data?.user) { res.status(401).json({ error: 'bad_token' }); return null; }
  const check = await accountBlock(db, data.user, token);
  if (!check.account) {
    if (check.detail) fail(res, check.status, check.code, check.detail);
    else res.status(check.status).json({ error: check.code });
    return null;
  }
  verified.set(key, { at: Date.now(), user: data.user, account: check.account });
  return { db, user: data.user, account: check.account };
}

// The server-owned plan. user_settings.plan is only the client's view toggle.
app.get('/api/account', limit('account_read', 60), async (req, res) => {
  const ctx = await requireUser(req, res); if (!ctx) return;
  res.json({ plan: ctx.account.plan, email: ctx.user.email || null });
});

// ---- editable content -------------------------------------------------
// Written by the admin process, read here with the anon key (the table is
// public by policy). Cached for 30 s; on any failure the client keeps the copy
// built into the page, so content is an enhancement, never a dependency.
const anonDb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
let contentCache = { at: 0, body: null };

app.get('/api/content', limit('content', 120, 30), async (_req, res) => {
  if (contentCache.body && Date.now() - contentCache.at < 30_000) return res.json(contentCache.body);
  const { data, error } = await anonDb.from('site_content').select('key, value');
  if (error) return fail(res, 503, 'content_unavailable', error.message);
  const body = {};
  for (const r of data) body[r.key] = r.value;
  contentCache = { at: Date.now(), body };
  res.json(body);
});

// ---- per-user settings ------------------------------------------------
// The client is free to keep its own UI state, but only these keys are ever
// accepted into the row: an allowlist is the only way to stop the settings
// blob becoming an untyped dumping ground (and with it, a storage-abuse hole).
const SETTINGS_KEYS = new Set([
  'plan', 'lang', 'appLang', 'follows', 'push', 'screenFilter', 'chartRange', 'overlays',
  'screen', 'feedTab', 'selected', 'twofa', 'loginAlerts', 'timeoutMin', 'revoked', 'links',
  'theme', 'alerts', 'positions', 'dismissed', 'stack', 'stackOpen', 'onboarded'
]);
const BANNED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_NODES = 2000, MAX_DEPTH = 6, MAX_STRING = 400;

// Rejects rather than sanitises: silently dropping a field hides client bugs.
function checkValue(v, depth, counter) {
  if (++counter.n > MAX_NODES) return 'too_many_nodes';
  if (depth > MAX_DEPTH) return 'too_deep';
  if (v === null) return null;
  const t = typeof v;
  if (t === 'string') return v.length > MAX_STRING ? 'string_too_long' : null;
  if (t === 'number') return Number.isFinite(v) ? null : 'bad_number';
  if (t === 'boolean') return null;
  if (Array.isArray(v)) {
    if (v.length > 200) return 'array_too_long';
    for (const item of v) { const e = checkValue(item, depth + 1, counter); if (e) return e; }
    return null;
  }
  if (t === 'object') {
    const keys = Object.keys(v);
    if (keys.length > 100) return 'too_many_keys';
    for (const k of keys) {
      if (BANNED_KEYS.has(k)) return 'banned_key';
      if (k.length > 64) return 'key_too_long';
      const e = checkValue(v[k], depth + 1, counter); if (e) return e;
    }
    return null;
  }
  return 'bad_type';
}

function validateSettings(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'expected_object' };
  const keys = Object.keys(body);
  if (keys.length > SETTINGS_KEYS.size) return { error: 'too_many_keys' };
  const unknown = keys.filter(k => !SETTINGS_KEYS.has(k));
  if (unknown.length) return { error: 'unknown_key' };
  const err = checkValue(body, 0, { n: 0 });
  if (err) return { error: err };
  return { value: body };
}

app.get('/api/settings', limit('settings_read', 120), async (req, res) => {
  const ctx = await requireUser(req, res); if (!ctx) return;
  const { data, error } = await ctx.db.from('user_settings').select('data').eq('user_id', ctx.user.id).maybeSingle();
  if (error) return fail(res, 500, 'settings_read_failed', error.message);
  res.json(data?.data ?? {});
});

app.put('/api/settings', limit('settings_write', 30, 10), async (req, res) => {
  const ctx = await requireUser(req, res); if (!ctx) return;
  const checked = validateSettings(req.body);
  if (checked.error) return res.status(400).json({ error: checked.error });
  const { error } = await ctx.db.from('user_settings')
    .upsert({ user_id: ctx.user.id, data: checked.value, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) return fail(res, 500, 'settings_write_failed', error.message);
  res.json({ ok: true });
});

// ---- security activity ------------------------------------------------
// The in-app audit trail. Append-only from the client's point of view: there is
// no update or delete policy on the table, and the server refuses anything but
// the four fields below.
const EVENT_KINDS = new Set(['signin', 'signout', 'signout_all', 'twofa_on', 'twofa_off', 'device_revoked', 'locked', 'unlock_failed', 'password_changed']);

app.get('/api/events', limit('events_read', 60), async (req, res) => {
  const ctx = await requireUser(req, res); if (!ctx) return;
  const { data, error } = await ctx.db.from('security_events')
    .select('kind, detail, created_at').eq('user_id', ctx.user.id)
    .order('created_at', { ascending: false }).limit(50);
  if (error) return fail(res, 500, 'events_read_failed', error.message);
  res.json(data ?? []);
});

app.post('/api/events', limit('events_write', 30, 10), async (req, res) => {
  const ctx = await requireUser(req, res); if (!ctx) return;
  const body = req.body || {};
  if (!EVENT_KINDS.has(body.kind)) return res.status(400).json({ error: 'bad_kind' });
  const detail = body.detail == null ? null : String(body.detail).slice(0, 120);
  const { error } = await ctx.db.from('security_events')
    .insert({ user_id: ctx.user.id, kind: body.kind, detail, ip: null });
  if (error) return fail(res, 500, 'events_write_failed', error.message);
  res.status(201).json({ ok: true });
});

// ---- Finnhub proxy ----------------------------------------------------
// The upstream query string is *rebuilt* from validated values — the client's
// own query object is never forwarded. That is what stops parameter smuggling
// (a second `token=`, a path traversal in `symbol`, an unbounded candle range).
const ALLOWED = {
  quote:    { path: 'quote',                  params: ['symbol'] },
  profile:  { path: 'stock/profile2',         params: ['symbol'] },
  candle:   { path: 'stock/candle',           params: ['symbol', 'resolution', 'from', 'to'] },
  news:     { path: 'company-news',           params: ['symbol', 'from', 'to'] },
  earnings: { path: 'stock/earnings',         params: ['symbol'] },
  reco:     { path: 'stock/recommendation',   params: ['symbol'] },
  search:   { path: 'search',                 params: ['q'] }
};
// The shared front-end (templates/shared/hif-live.js) calls the Netlify-style
// /api/finnhub?path=/quote&symbol=… ; these map that onto the kinds above.
const PATH_KINDS = {
  '/quote': 'quote', '/company-news': 'news', '/stock/recommendation': 'reco',
  '/stock/earnings': 'earnings', '/search': 'search', '/chart': 'chart'
};
// Price history comes from Yahoo's public chart endpoint (Finnhub's candles are
// not on the free tier). Range -> bar interval, same table as the Netlify function.
const CHART_RANGES = { '1d': '5m', '5d': '15m', '1mo': '60m', '6mo': '1d', ytd: '1d', '1y': '1d', '5y': '1wk' };
// With warm=1 the same bar size is fetched over a longer range, so moving averages
// and RSI have history before the first visible bar instead of starting mid-chart.
const CHART_WARM = { '1d': '5d', '5d': '1mo', '1mo': '3mo', '6mo': '1y', ytd: '2y', '1y': '2y', '5y': '10y' };
const SYMBOL_RE = /^[A-Z0-9][A-Z0-9.\-]{0,11}$/;
const RESOLUTIONS = new Set(['1', '5', '15', '30', '60', 'D', 'W', 'M']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NOW_S = () => Math.floor(Date.now() / 1000);

function validateUpstream(kind, query) {
  const spec = ALLOWED[kind];
  if (!spec) return { error: 'unknown_endpoint' };
  const out = new URLSearchParams();
  for (const name of spec.params) {
    const raw = query[name];
    if (raw === undefined) {
      if (name === 'symbol') return { error: 'symbol_required' };
      if (name === 'q') return { error: 'q_required' };
      continue;
    }
    if (typeof raw !== 'string') return { error: 'bad_' + name };
    if (name === 'q') {
      const q = raw.trim();
      if (!q || q.length > 64 || /[\u0000-\u001f]/.test(q)) return { error: 'bad_q' };
      out.set('q', q);
    } else if (name === 'symbol') {
      const sym = raw.toUpperCase();
      if (!SYMBOL_RE.test(sym)) return { error: 'bad_symbol' };
      out.set('symbol', sym);
    } else if (name === 'resolution') {
      if (!RESOLUTIONS.has(raw)) return { error: 'bad_resolution' };
      out.set('resolution', raw);
    } else if (name === 'from' || name === 'to') {
      if (DATE_RE.test(raw)) {
        const t = Date.parse(raw + 'T00:00:00Z');
        if (!Number.isFinite(t)) return { error: 'bad_' + name };
        out.set(name, raw);
      } else {
        const n = Number(raw);
        // Unix seconds, within ten years back and one day forward.
        if (!Number.isInteger(n) || n < NOW_S() - 10 * 365 * 86400 || n > NOW_S() + 86400) return { error: 'bad_' + name };
        out.set(name, String(n));
      }
    }
  }
  return { path: spec.path, params: out, key: kind + '?' + out.toString() };
}

// A 30-second cache keeps the free tier's 60 calls/minute comfortable even with
// several tabs open. Bounded, and errors are never cached.
const cache = new Map();
const TTL = 30_000, CACHE_MAX = 500;
function cacheSet(key, body) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), body });
}

// One upstream fetch per key at a time: a burst of tabs asking for the same
// symbol collapses into a single call instead of N.
const inflight = new Map();

// Yahoo chart, validated and cached like the Finnhub calls. No token involved.
function validateChart(query) {
  const sym = typeof query.symbol === 'string' ? query.symbol.toUpperCase() : '';
  const range = typeof query.range === 'string' ? query.range : '6mo';
  if (!SYMBOL_RE.test(sym)) return { error: 'bad_symbol' };
  if (!CHART_RANGES[range]) return { error: 'bad_range' };
  const warm = query.warm === '1';
  const params = new URLSearchParams({ range: warm ? CHART_WARM[range] : range, interval: CHART_RANGES[range], includePrePost: 'false' });
  return { url: `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?${params}`, key: 'chart?' + sym + '&' + range + (warm ? '&warm' : '') };
}

async function proxyMarket(kind, query, res) {
  let key, upstreamUrl, headers = { accept: 'application/json' };
  if (kind === 'chart') {
    const c = validateChart(query);
    if (c.error) return res.status(400).json({ error: c.error });
    key = c.key; upstreamUrl = c.url; headers['user-agent'] = 'Mozilla/5.0';
  } else {
    if (!FINNHUB_TOKEN) return res.status(503).json({ error: 'no_token_configured' });
    const v = validateUpstream(kind, query);
    if (v.error) return res.status(v.error === 'unknown_endpoint' ? 404 : 400).json({ error: v.error });
    const params = new URLSearchParams(v.params);
    params.set('token', FINNHUB_TOKEN);
    key = v.key; upstreamUrl = `https://finnhub.io/api/v1/${v.path}?${params}`;
  }

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) { stats.finnhub.cacheHits++; return res.json(hit.body); }

  if (inflight.has(key)) {
    stats.finnhub.coalesced++;
    try { return res.json(await inflight.get(key)); }
    catch { return fail(res, 504, 'upstream_unreachable'); }
  }

  stats.finnhub.upstream++;
  stats.finnhub.recent.push(Date.now());
  if (stats.finnhub.recent.length > 600) stats.finnhub.recent.splice(0, stats.finnhub.recent.length - 600);
  const job = (async () => {
    const r = await fetch(upstreamUrl, { signal: AbortSignal.timeout(8000), headers });
    if (!r.ok) throw new Error('upstream_' + r.status);
    const type = String(r.headers.get('content-type') || '');
    if (!type.includes('application/json')) throw new Error('upstream_not_json');
    const body = await r.json();
    cacheSet(key, body);
    return body;
  })();
  inflight.set(key, job);
  try {
    res.json(await job);
  } catch (e) {
    stats.finnhub.upstreamErrors++;
    // The upstream status is interesting to us, not to the client.
    const upstream = /^upstream_(\d{3})$/.exec(e.message);
    if (upstream) return fail(res, 502, 'upstream_error', e.message);
    return fail(res, 504, 'upstream_unreachable', e.message);
  } finally {
    inflight.delete(key);
  }
}

app.get('/api/finnhub/:kind', limit('finnhub', 60, 20), (req, res) => proxyMarket(req.params.kind, req.query, res));
app.get('/api/finnhub', limit('finnhub', 60, 20), (req, res) => {
  const kind = Object.hasOwn(PATH_KINDS, req.query.path) ? PATH_KINDS[req.query.path] : null;
  if (!kind) return res.status(400).json({ error: 'path_not_allowed' });
  proxyMarket(kind, req.query, res);
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));

// ---- static front-end -------------------------------------------------
// index.html is never cached (so a deploy is picked up immediately); everything
// else may sit in the browser for an hour. Dotfiles are refused outright.
app.use(express.static(join(here, 'public'), {
  extensions: ['html'],
  index: ['index.html'],
  dotfiles: 'deny',
  redirect: false,
  maxAge: '1h',
  setHeaders(res, path) {
    if (path.endsWith('index.html')) res.setHeader('Cache-Control', 'no-store');
  }
}));

// SPA fallback — GET/HEAD only, and never for a path that looks like a missing
// asset (a dot in the last segment), so a bad script URL 404s instead of
// silently returning HTML.
app.get('*', (req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) return res.status(405).end();
  const last = req.path.split('/').pop() || '';
  if (last.includes('.')) return res.status(404).type('text/plain').send('Not found');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(join(here, 'public', 'index.html'));
});

app.use((err, _req, res, _next) => fail(res, 500, 'server_error', err && err.message));

const server = app.listen(PORT, process.env.BIND || '0.0.0.0', () => {
  console.log(`Heard It First on http://${process.env.BIND || '0.0.0.0'}:${PORT} (${PROD ? 'production' : 'development'})`);
});
// Slowloris and half-open sockets.
server.headersTimeout = 15_000;
server.requestTimeout = 20_000;
server.keepAliveTimeout = 5_000;

// ---- stats listener ---------------------------------------------------
// A second, loopback-only port for the admin process. It is not routed by the
// reverse proxy (which only knows :PORT), and still demands a shared token.
const STATS_TOKEN = process.env.STATS_TOKEN || '';
const STATS_PORT = Number(process.env.STATS_PORT || 8082);
let statsServer = null;
if (STATS_TOKEN.length >= 32) {
  const want = createHash('sha256').update('Bearer ' + STATS_TOKEN).digest();
  statsServer = createServer((req, res) => {
    const got = createHash('sha256').update(String(req.headers.authorization || '')).digest();
    if (req.method !== 'GET' || req.url !== '/stats' || !timingSafeEqual(want, got)) { res.writeHead(404).end(); return; }
    const now = Date.now();
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({
      uptimeS: Math.round((now - stats.startedAt) / 1000),
      rssMb: Math.round(process.memoryUsage().rss / 1048576),
      node: process.version,
      production: PROD,
      liveData: !!FINNHUB_TOKEN,
      requests: stats.requests,
      rateLimited: stats.rateLimited,
      errors: stats.errors,
      blocked: stats.blocked,
      finnhub: {
        upstream: stats.finnhub.upstream, upstreamErrors: stats.finnhub.upstreamErrors,
        cacheHits: stats.finnhub.cacheHits, coalesced: stats.finnhub.coalesced,
        lastMinute: stats.finnhub.recent.filter(t => now - t < 60_000).length,
        quotaPerMinute: 60, cacheSize: cache.size
      }
    }));
  });
  statsServer.listen(STATS_PORT, '127.0.0.1');
} else if (STATS_TOKEN) {
  console.error('STATS_TOKEN is shorter than 32 characters; the stats listener is off.');
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { if (statsServer) statsServer.close(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); });
}
// Never let an unexpected rejection take the process down silently mid-request.
process.on('unhandledRejection', e => console.error('unhandledRejection:', e && e.message));

export { app, validateSettings, validateUpstream };
