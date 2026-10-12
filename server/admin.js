// Market Pulse admin — a second, separate process for operators.
//
// Why separate: managing accounts needs the Supabase service_role key, which
// bypasses every RLS policy. The public server (server.js) refuses to start
// with that key in its environment; this process holds it instead, and only
// ever listens on loopback. Reach it through an SSH tunnel:
//
//     ssh -L 8081:127.0.0.1:8081 you@server   then open http://127.0.0.1:8081
//
// Security posture:
//   - binds to 127.0.0.1 / ::1 only, and rejects any other Host header (DNS rebinding)
//   - its own login: scrypt password + TOTP, lockout after repeated failures
//   - server-side sessions in an HttpOnly SameSite=Strict cookie, idle + absolute expiry
//   - every state change is same-origin, JSON, and written to admin_audit (append only)
//   - strict CSP with no inline script or style
//
// Start: node admin.js   (reads ./admin.env — never the public server's .env)
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DUMMY_HASH, assertTotpKey, checkTotp, openSecret, verifyPassword } from './admin-auth.js';
import { CONTENT_KEYS, validateContent } from './content.js';

const here = dirname(fileURLToPath(import.meta.url));

try {
  for (const line of readFileSync(join(here, 'admin.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const PORT = Number(process.env.ADMIN_PORT || 8081);
const BIND = process.env.ADMIN_BIND || '127.0.0.1';
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
const STATS_URL = process.env.STATS_URL || 'http://127.0.0.1:8082/stats';
const STATS_TOKEN = process.env.STATS_TOKEN || '';
const SECURE_COOKIE = process.env.ADMIN_COOKIE_SECURE === '1';

function die(msg) { console.error(msg); process.exit(1); }
if (!['127.0.0.1', '::1', 'localhost'].includes(BIND)) die('ADMIN_BIND must be a loopback address; reach the panel through an SSH tunnel.');
if (!SUPABASE_URL || !/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(SUPABASE_URL)) die('Set SUPABASE_URL in admin.env (https://<ref>.supabase.co).');
if (!SUPABASE_SERVICE_ROLE_KEY) die('Set SUPABASE_SERVICE_ROLE_KEY in admin.env.');
try { assertTotpKey(); } catch (e) { die(e.message); }

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const app = express();
app.disable('x-powered-by');
app.disable('etag');
app.set('query parser', 'simple');

// ---- headers and host pinning ------------------------------------------
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
const CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'"
].join('; ');

app.use((req, res, next) => {
  // A page on any website can point a hostname at 127.0.0.1 (DNS rebinding);
  // its requests then arrive here with that foreign Host. Refuse them.
  if (!HOSTS.has(String(req.get('host') || '').toLowerCase())) return res.status(421).type('text/plain').send('Misdirected request');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=(), usb=()');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// ---- rate limiting (same token bucket as server.js) ---------------------
const buckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now - b.seen > 600_000) buckets.delete(k);
}, 120_000).unref();

function limit(name, perMinute, burst) {
  const capacity = burst || perMinute, refill = perMinute / 60_000;
  return (req, res, next) => {
    const key = name + '|' + (req.socket.remoteAddress || '?');
    const now = Date.now();
    let b = buckets.get(key);
    if (!b) { b = { tokens: capacity, at: now, seen: now }; buckets.set(key, b); }
    b.tokens = Math.min(capacity, b.tokens + (now - b.at) * refill);
    b.at = now; b.seen = now;
    if (b.tokens < 1) {
      res.setHeader('Retry-After', Math.ceil((1 - b.tokens) / refill / 1000));
      return res.status(429).json({ error: 'rate_limited' });
    }
    b.tokens -= 1;
    next();
  };
}

// ---- request hygiene ---------------------------------------------------
app.use('/admin/api', (req, res, next) => {
  if (!['GET', 'HEAD', 'POST', 'PUT', 'DELETE'].includes(req.method)) return res.status(405).json({ error: 'method_not_allowed' });
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.get('origin');
    if (!origin || !HOSTS.has(origin.replace(/^http:\/\//, ''))) return res.status(403).json({ error: 'bad_origin' });
    if (req.method !== 'DELETE') {
      const ct = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (ct !== 'application/json') return res.status(415).json({ error: 'expected_json' });
    }
  }
  next();
});
app.use('/admin/api', express.json({ limit: '64kb', strict: true }));
app.use('/admin/api', (err, _req, res, _next) => {
  if (err) return res.status(err.type === 'entity.too.large' ? 413 : 400).json({ error: 'bad_body' });
});

let errSeq = 0;
function fail(res, status, code, detail) {
  const ref = (++errSeq).toString(36);
  if (detail) console.error(`[${new Date().toISOString()}] ${code} ref=${ref}:`, String(detail).slice(0, 300));
  res.status(status).json({ error: code, ref });
}

// ---- audit -------------------------------------------------------------
async function audit(req, action, target, detail) {
  const { error } = await db.from('admin_audit').insert({
    admin: req.admin ? req.admin.username : (detail && detail.username) || '?',
    action, target: target || null, detail: detail || null,
    ip: req.socket.remoteAddress || null
  });
  if (error) console.error('audit write failed:', error.message);
}

// ---- sessions ----------------------------------------------------------
// In memory on purpose: one process, one operator or two. A restart signs
// everyone out, which is the safe direction to fail.
const COOKIE = 'mp_admin';
const IDLE = 30 * 60_000, ABSOLUTE = 8 * 60 * 60_000;
const sessions = new Map(); // sha256(sid) -> { id, username, created, seen }
setInterval(() => {
  const now = Date.now();
  for (const [k, s] of sessions) if (now - s.seen > IDLE || now - s.created > ABSOLUTE) sessions.delete(k);
}, 60_000).unref();

const sidHash = sid => createHash('sha256').update(sid).digest('hex');

function readCookie(req) {
  for (const part of String(req.get('cookie') || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return null;
}

function setCookie(res, value, maxAgeS) {
  res.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${SECURE_COOKIE ? '; Secure' : ''}`);
}

function requireAdmin(req, res, next) {
  const sid = readCookie(req);
  const s = sid && /^[A-Za-z0-9_-]{43}$/.test(sid) ? sessions.get(sidHash(sid)) : null;
  const now = Date.now();
  if (!s || now - s.seen > IDLE || now - s.created > ABSOLUTE) {
    if (s) sessions.delete(sidHash(sid));
    return res.status(401).json({ error: 'signed_out' });
  }
  s.seen = now;
  req.admin = s;
  next();
}

// ---- login -------------------------------------------------------------
const MAX_FAILS = 5, LOCK_MS = 15 * 60_000;

app.post('/admin/api/login', limit('login', 10, 5), async (req, res) => {
  const { username, password, code } = req.body || {};
  const name = typeof username === 'string' ? username.trim().toLowerCase() : '';
  const generic = () => res.status(401).json({ error: 'invalid_login' });
  if (!/^[a-z0-9_.-]{3,32}$/.test(name) || typeof password !== 'string' || password.length > 256) {
    await verifyPassword('x', DUMMY_HASH);
    return generic();
  }

  const { data: row, error } = await db.from('admin_users').select('*').eq('username', name).maybeSingle();
  if (error) return fail(res, 500, 'login_failed', error.message);

  // Always run scrypt, so timing does not reveal whether the account exists.
  const pwOk = await verifyPassword(password, row ? row.pw_hash : DUMMY_HASH);
  if (!row || row.disabled) { await audit(req, 'login_failed', name, { username: name, why: 'unknown_or_disabled' }); return generic(); }

  const locked = row.locked_until && Date.parse(row.locked_until) > Date.now();
  let step = null;
  if (pwOk && !locked) {
    try { step = checkTotp(openSecret(row.totp_secret_enc), code); } catch (e) { return fail(res, 500, 'login_failed', e.message); }
    if (step !== null && step <= Number(row.totp_last_step)) step = null; // replayed code
  }

  if (!pwOk || locked || step === null) {
    const fails = locked ? row.failed_count : row.failed_count + 1;
    const patch = fails >= MAX_FAILS
      ? { failed_count: 0, locked_until: new Date(Date.now() + LOCK_MS).toISOString() }
      : { failed_count: fails };
    if (!locked) await db.from('admin_users').update(patch).eq('id', row.id);
    await audit(req, 'login_failed', name, { username: name, why: locked ? 'locked' : !pwOk ? 'password' : 'code', locked_now: !!patch.locked_until });
    return generic();
  }

  // Claim the TOTP step atomically: a second login racing with the same code loses.
  const { data: claimed, error: claimErr } = await db.from('admin_users')
    .update({ totp_last_step: step, failed_count: 0, locked_until: null, last_login_at: new Date().toISOString() })
    .eq('id', row.id).lt('totp_last_step', step).select('id');
  if (claimErr) return fail(res, 500, 'login_failed', claimErr.message);
  if (!claimed || !claimed.length) return generic();

  const sid = randomBytes(32).toString('base64url');
  const now = Date.now();
  sessions.set(sidHash(sid), { id: row.id, username: row.username, created: now, seen: now });
  setCookie(res, sid, ABSOLUTE / 1000);
  req.admin = { username: row.username };
  await audit(req, 'login', row.username);
  res.json({ username: row.username, idleMinutes: IDLE / 60_000 });
});

app.post('/admin/api/logout', (req, res) => {
  const sid = readCookie(req);
  if (sid) sessions.delete(sidHash(sid));
  setCookie(res, '', 0);
  res.json({ ok: true });
});

app.get('/admin/api/me', requireAdmin, (req, res) => {
  res.json({ username: req.admin.username, idleMinutes: IDLE / 60_000, expiresAt: req.admin.created + ABSOLUTE });
});

// Everything below needs a signed-in admin.
app.use('/admin/api', requireAdmin, limit('admin_api', 240, 60));

// ---- users -------------------------------------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let userCache = { at: 0, users: [] };

async function allUsers(force) {
  if (!force && Date.now() - userCache.at < 30_000) return userCache.users;
  const users = [];
  for (let page = 1; page <= 25; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    users.push(...data.users);
    if (data.users.length < 200) break;
  }
  userCache = { at: Date.now(), users };
  return users;
}

async function statusMap() {
  const [st, se] = await Promise.all([
    db.from('account_status').select('*'),
    db.from('user_settings').select('user_id, updated_at')
  ]);
  if (st.error) throw st.error;
  if (se.error) throw se.error;
  const status = new Map(st.data.map(r => [r.user_id, r]));
  const active = new Map(se.data.map(r => [r.user_id, r.updated_at]));
  return { status, active };
}

function userRow(u, status, active) {
  const s = status.get(u.id) || {};
  return {
    id: u.id,
    email: u.email || u.phone || '—',
    providers: (u.app_metadata && u.app_metadata.providers) || [],
    createdAt: u.created_at,
    lastSignIn: u.last_sign_in_at || null,
    lastActive: active.get(u.id) || null,
    confirmed: !!(u.email_confirmed_at || u.phone_confirmed_at),
    plan: s.plan || 'free',
    suspended: !!s.suspended,
    reason: s.suspended_reason || '',
    bannedUntil: u.banned_until || null
  };
}

app.get('/admin/api/users', async (req, res) => {
  try {
    const [users, maps] = await Promise.all([allUsers(req.query.fresh === '1'), statusMap()]);
    let rows = users.map(u => userRow(u, maps.status, maps.active));
    const week = Date.now() - 7 * 86400_000;
    const summary = {
      total: rows.length,
      pro: rows.filter(r => r.plan === 'pro').length,
      suspended: rows.filter(r => r.suspended).length,
      active7d: rows.filter(r => r.lastActive && Date.parse(r.lastActive) > week).length
    };
    const q = String(req.query.q || '').trim().toLowerCase().slice(0, 100);
    if (q) rows = rows.filter(r => r.email.toLowerCase().includes(q) || r.id.startsWith(q));
    const filter = String(req.query.filter || 'all');
    if (filter === 'pro') rows = rows.filter(r => r.plan === 'pro');
    else if (filter === 'free') rows = rows.filter(r => r.plan === 'free');
    else if (filter === 'suspended') rows = rows.filter(r => r.suspended);
    rows.sort((a, b) => Date.parse(b.lastActive || b.lastSignIn || b.createdAt) - Date.parse(a.lastActive || a.lastSignIn || a.createdAt));
    const per = 50, page = Math.max(1, Math.min(1000, Number(req.query.page) || 1));
    res.json({ summary, total: rows.length, page, pages: Math.max(1, Math.ceil(rows.length / per)), rows: rows.slice((page - 1) * per, page * per) });
  } catch (e) { fail(res, 500, 'users_read_failed', e.message); }
});

async function findUser(id) {
  if (!UUID_RE.test(id)) return null;
  const { data, error } = await db.auth.admin.getUserById(id);
  return error || !data || !data.user ? null : data.user;
}

app.get('/admin/api/users/:id', async (req, res) => {
  try {
    const u = await findUser(req.params.id);
    if (!u) return res.status(404).json({ error: 'not_found' });
    const [maps, ev] = await Promise.all([
      statusMap(),
      db.from('security_events').select('id, kind, detail, ip, created_at').eq('user_id', u.id).order('id', { ascending: false }).limit(20)
    ]);
    if (ev.error) throw ev.error;
    res.json({ user: userRow(u, maps.status, maps.active), events: ev.data });
  } catch (e) { fail(res, 500, 'user_read_failed', e.message); }
});

async function setStatus(req, id, patch) {
  const { error } = await db.from('account_status').upsert(
    { user_id: id, ...patch, updated_at: new Date().toISOString(), updated_by: req.admin.username },
    { onConflict: 'user_id' });
  if (error) throw error;
  userCache.at = 0;
}

async function endSessions(id) {
  const { error } = await db.rpc('admin_revoke_sessions', { target: id });
  if (error) throw error;
}

app.post('/admin/api/users/:id/plan', async (req, res) => {
  const plan = (req.body || {}).plan;
  if (!['free', 'pro'].includes(plan)) return res.status(400).json({ error: 'bad_plan' });
  try {
    const u = await findUser(req.params.id);
    if (!u) return res.status(404).json({ error: 'not_found' });
    await setStatus(req, u.id, { plan });
    await audit(req, 'user_plan', u.id, { email: u.email, plan });
    res.json({ ok: true });
  } catch (e) { fail(res, 500, 'plan_failed', e.message); }
});

app.post('/admin/api/users/:id/suspend', async (req, res) => {
  const { suspended, reason } = req.body || {};
  if (typeof suspended !== 'boolean') return res.status(400).json({ error: 'bad_body' });
  if (reason != null && (typeof reason !== 'string' || reason.length > 200)) return res.status(400).json({ error: 'bad_reason' });
  try {
    const u = await findUser(req.params.id);
    if (!u) return res.status(404).json({ error: 'not_found' });
    // Our flag stops the app API; the Supabase ban stops new sign-ins and refreshes.
    const { error } = await db.auth.admin.updateUserById(u.id, { ban_duration: suspended ? '876000h' : 'none' });
    if (error) throw error;
    await setStatus(req, u.id, suspended
      ? { suspended: true, suspended_reason: reason || null, revoked_before: new Date().toISOString() }
      : { suspended: false, suspended_reason: null });
    if (suspended) await endSessions(u.id);
    await audit(req, suspended ? 'user_suspend' : 'user_unsuspend', u.id, { email: u.email, reason: reason || null });
    res.json({ ok: true });
  } catch (e) { fail(res, 500, 'suspend_failed', e.message); }
});

app.post('/admin/api/users/:id/signout', async (req, res) => {
  try {
    const u = await findUser(req.params.id);
    if (!u) return res.status(404).json({ error: 'not_found' });
    await setStatus(req, u.id, { revoked_before: new Date().toISOString() });
    await endSessions(u.id);
    await audit(req, 'user_signout', u.id, { email: u.email });
    res.json({ ok: true });
  } catch (e) { fail(res, 500, 'signout_failed', e.message); }
});

app.post('/admin/api/users/:id/delete', async (req, res) => {
  try {
    const u = await findUser(req.params.id);
    if (!u) return res.status(404).json({ error: 'not_found' });
    // Typed confirmation: the operator must name the account they are deleting.
    if (String((req.body || {}).confirm || '').trim().toLowerCase() !== String(u.email || u.id).toLowerCase()) {
      return res.status(400).json({ error: 'confirm_mismatch' });
    }
    const { error } = await db.auth.admin.deleteUser(u.id);
    if (error) throw error;
    userCache.at = 0;
    await audit(req, 'user_delete', u.id, { email: u.email });
    res.json({ ok: true });
  } catch (e) { fail(res, 500, 'delete_failed', e.message); }
});

// ---- security log ------------------------------------------------------
const EVENT_KINDS = ['signin', 'signout', 'signout_all', 'twofa_on', 'twofa_off', 'device_revoked', 'locked', 'unlock_failed', 'password_changed'];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

async function eventQuery(q, max) {
  let query = db.from('security_events').select('id, user_id, kind, detail, ip, created_at').order('id', { ascending: false }).limit(max);
  if (q.kind) { if (!EVENT_KINDS.includes(q.kind)) return { error: 'bad_kind' }; query = query.eq('kind', q.kind); }
  if (q.from) { if (!DAY_RE.test(q.from)) return { error: 'bad_from' }; query = query.gte('created_at', q.from + 'T00:00:00Z'); }
  if (q.to) { if (!DAY_RE.test(q.to)) return { error: 'bad_to' }; query = query.lt('created_at', new Date(Date.parse(q.to + 'T00:00:00Z') + 86400_000).toISOString()); }
  if (q.before) { const n = Number(q.before); if (!Number.isInteger(n) || n < 1) return { error: 'bad_before' }; query = query.lt('id', n); }
  const users = await allUsers();
  const email = new Map(users.map(u => [u.id, u.email || u.id]));
  if (q.user) {
    const needle = String(q.user).trim().toLowerCase().slice(0, 100);
    const ids = UUID_RE.test(needle) ? [needle] : users.filter(u => (u.email || '').toLowerCase().includes(needle)).map(u => u.id).slice(0, 200);
    if (!ids.length) return { rows: [] };
    query = query.in('user_id', ids);
  }
  const { data, error } = await query;
  if (error) throw error;
  return { rows: data.map(r => ({ ...r, email: email.get(r.user_id) || '(deleted)' })) };
}

app.get('/admin/api/events', async (req, res) => {
  try {
    const out = await eventQuery(req.query, 100);
    if (out.error) return res.status(400).json({ error: out.error });
    res.json({ rows: out.rows, kinds: EVENT_KINDS, more: out.rows.length === 100 });
  } catch (e) { fail(res, 500, 'events_read_failed', e.message); }
});

// Spreadsheet apps execute cells that start with = + - @; prefix them so an
// attacker-chosen "detail" cannot become a formula on the operator's machine.
const csvCell = v => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

app.get('/admin/api/events.csv', async (req, res) => {
  try {
    const out = await eventQuery(req.query, 5000);
    if (out.error) return res.status(400).json({ error: out.error });
    const lines = [['id', 'time', 'email', 'user_id', 'kind', 'detail', 'ip'].join(',')]
      .concat(out.rows.map(r => [r.id, r.created_at, r.email, r.user_id, r.kind, r.detail, r.ip].map(csvCell).join(',')));
    await audit(req, 'events_export', null, { rows: out.rows.length, filters: { kind: req.query.kind || null, user: req.query.user || null, from: req.query.from || null, to: req.query.to || null } });
    res.setHeader('Content-Disposition', `attachment; filename="security-events-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.type('text/csv').send(lines.join('\r\n') + '\r\n');
  } catch (e) { fail(res, 500, 'events_export_failed', e.message); }
});

app.get('/admin/api/audit', async (req, res) => {
  try {
    let query = db.from('admin_audit').select('*').order('id', { ascending: false }).limit(100);
    if (req.query.before) { const n = Number(req.query.before); if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: 'bad_before' }); query = query.lt('id', n); }
    const { data, error } = await query;
    if (error) throw error;
    res.json({ rows: data, more: data.length === 100 });
  } catch (e) { fail(res, 500, 'audit_read_failed', e.message); }
});

// ---- system health -----------------------------------------------------
const startedAt = Date.now();

app.get('/admin/api/health', async (_req, res) => {
  const out = { checkedAt: new Date().toISOString(), admin: { uptimeS: Math.round((Date.now() - startedAt) / 1000), rssMb: Math.round(process.memoryUsage().rss / 1048576), node: process.version } };
  const t0 = Date.now();
  const probe = await db.from('site_content').select('key', { count: 'exact', head: true });
  out.database = probe.error ? { ok: false, error: 'unreachable' } : { ok: true, ms: Date.now() - t0 };
  if (probe.error) console.error('health db probe:', probe.error.message);
  if (!STATS_TOKEN) out.app = { ok: false, error: 'STATS_TOKEN not set in admin.env' };
  else {
    try {
      const r = await fetch(STATS_URL, { headers: { authorization: 'Bearer ' + STATS_TOKEN }, signal: AbortSignal.timeout(3000) });
      out.app = r.ok ? { ok: true, ...(await r.json()) } : { ok: false, error: 'stats_http_' + r.status };
    } catch { out.app = { ok: false, error: 'unreachable' }; }
  }
  res.json(out);
});

// ---- content -----------------------------------------------------------
app.get('/admin/api/content', async (_req, res) => {
  const { data, error } = await db.from('site_content').select('*');
  if (error) return fail(res, 500, 'content_read_failed', error.message);
  const out = {};
  for (const k of CONTENT_KEYS) out[k] = null;
  for (const r of data) out[r.key] = { value: r.value, updatedAt: r.updated_at, updatedBy: r.updated_by };
  res.json(out);
});

app.put('/admin/api/content/:key', async (req, res) => {
  const key = req.params.key;
  const value = (req.body || {}).value;
  const problem = validateContent(key, value);
  if (problem) return res.status(400).json({ error: 'invalid_content', message: problem });
  const { error } = await db.from('site_content').upsert(
    { key, value, updated_at: new Date().toISOString(), updated_by: req.admin.username }, { onConflict: 'key' });
  if (error) return fail(res, 500, 'content_write_failed', error.message);
  await audit(req, 'content_save', key, { bytes: JSON.stringify(value).length });
  res.json({ ok: true });
});

app.delete('/admin/api/content/:key', async (req, res) => {
  const key = req.params.key;
  if (!CONTENT_KEYS.includes(key)) return res.status(404).json({ error: 'not_found' });
  const { error } = await db.from('site_content').delete().eq('key', key);
  if (error) return fail(res, 500, 'content_reset_failed', error.message);
  await audit(req, 'content_reset', key);
  res.json({ ok: true });
});

app.use('/admin/api', (_req, res) => res.status(404).json({ error: 'not_found' }));

// ---- panel -------------------------------------------------------------
app.use(express.static(join(here, 'admin-public'), { index: ['index.html'], dotfiles: 'deny', redirect: false }));
app.use((_req, res) => res.status(404).type('text/plain').send('Not found'));
app.use((err, _req, res, _next) => fail(res, 500, 'server_error', err && err.message));

const server = app.listen(PORT, BIND, () => console.log(`Market Pulse admin on http://${BIND}:${PORT} (loopback only)`));
server.headersTimeout = 15_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 5_000;

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); });
}
process.on('unhandledRejection', e => console.error('unhandledRejection:', e && e.message));

export { app };
