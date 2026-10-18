// Supabase Auth for the Heard It First / Market Pulse apps, without a client library.
//
// Talks to the project's GoTrue endpoints with the public anon key, which the page gets
// from /api/config (the Node server, or the Netlify function of the same path). When no
// config is available the apps keep their local demo sign-in, so a static preview still
// works. Only the anon key ever reaches the browser; row-level security in schema.sql is
// what limits each signed-in user to their own rows.
//
//   HIFAuth.ready            -> Promise<{ enabled, providers:{ google, apple }, confirmEmail }>
//   HIFAuth.session()        -> { userId, email, name, provider, since } | null
//   HIFAuth.signUp(email, password, name) -> { ok, confirm } | { error }
//   HIFAuth.signIn(email, password)       -> { ok } | { error }
//   HIFAuth.oauth('google' | 'apple')     -> leaves the page for the provider
//   HIFAuth.recover(email)  -> sends a password-reset link (always { ok } unless rate limited)
//   HIFAuth.updatePassword(password) -> { ok } | { error }, for the signed-in user
//   HIFAuth.info().recovery  -> true when the page was opened from a reset link
//   HIFAuth.signOut(everywhere)
//   HIFAuth.plan()           -> Promise<{ plan, suspended }>
//   HIFAuth.onChange(fn)     -> called with session() whenever it changes
//   HIFAuth.rest(path, opts) -> PostgREST call as the signed-in user ({ ok, status, body })
//   HIFAuth.mfa()            -> { enrolled, verified, needed, factorId } for the session
//   HIFAuth.mfaEnroll()      -> { factorId, qr, secret, uri } | { error }  (a new TOTP factor)
//   HIFAuth.mfaVerify(code, factorId?) -> { ok } | { error }  (the session becomes aal2)
//   HIFAuth.mfaUnenroll()    -> { ok } | { error }
//   HIFAuth.mfaFactors()     -> [{ id, name, created }] the account's authenticators
//   HIFAuth.mfaRemove(factorId, code) -> { ok } | { error }  (a current code first, from any of them)
//   HIFAuth.checkPassword(email, password) -> { ok } | { error }, the session unchanged
//   HIFAuth.deleteAccount()  -> { ok } | { error: 'mfa' | 'admin' | 'failed' }; signed out after
// Two-factor sign-in: a device asks for the code once, at sign-in; the session it gets is
// at level aal2 and stays so through refreshes, so the lock screen never asks again. The
// database refuses data to an enrolled account's aal1 session (supabase/mfa.sql).
(function(){
// The page runtime can evaluate this file more than once. A second copy would have its
// own session and listener list, so the app would listen to one copy while the buttons
// call the other. Keep the first.
if (window.HIFAuth) return;
const KEY = 'hif.auth.v1';
let cfg = null, info = null, current = null, refreshTimer = null;
const listeners = [];

function load() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
function save(s) { try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch (e) {} }
function emit() { const s = session(); listeners.forEach(fn => { try { fn(s); } catch (e) {} }); }

// The page the user should come back to after confirming an email or an OAuth hop.
function here() { return location.origin + location.pathname; }

async function call(path, opts) {
  const o = opts || {};
  const headers = Object.assign({ apikey: cfg.supabaseAnonKey, 'content-type': 'application/json' }, o.headers || {});
  const res = await fetch(cfg.supabaseUrl.replace(/\/$/, '') + path, { method: o.method || 'GET', headers, body: o.body ? JSON.stringify(o.body) : undefined });
  let body = null; try { body = await res.json(); } catch (e) {}
  return { status: res.status, ok: res.ok, body };
}

// GoTrue's messages are developer-facing; map the common ones to stable codes the apps
// translate. Anything unrecognised becomes 'failed' rather than leaking raw text.
function errorCode(r) {
  const b = r.body || {}, msg = String(b.msg || b.message || b.error_description || b.error || '').toLowerCase();
  const code = String(b.error_code || b.code || '').toLowerCase();
  if (r.status === 429 || code.indexOf('rate') >= 0) return 'rate_limited';
  if (code === 'invalid_credentials' || msg.indexOf('invalid login') >= 0) return 'bad_credentials';
  if (code === 'email_not_confirmed' || msg.indexOf('not confirmed') >= 0) return 'not_confirmed';
  if (code === 'user_already_exists' || msg.indexOf('already registered') >= 0) return 'exists';
  if (code === 'same_password' || msg.indexOf('different from the old') >= 0) return 'same_password';
  if (code === 'weak_password' || msg.indexOf('password') >= 0) return 'weak_password';
  if (code === 'signup_disabled' || msg.indexOf('signups not allowed') >= 0) return 'signup_disabled';
  if (code.indexOf('email') >= 0 || msg.indexOf('email') >= 0) return 'bad_email';
  return 'failed';
}

function fromTokens(t) {
  if (!t || !t.access_token || !t.refresh_token) return null;
  const u = t.user || {};
  return { access_token: t.access_token, refresh_token: t.refresh_token,
    expires_at: t.expires_at || Math.floor(Date.now() / 1000) + (Number(t.expires_in) || 3600), user: u };
}

function setSession(s) {
  current = s; save(s); schedule(); emit();
}

function schedule() {
  clearTimeout(refreshTimer);
  if (!current) return;
  const ms = Math.max(5000, (current.expires_at - 60) * 1000 - Date.now());
  refreshTimer = setTimeout(() => { refresh().catch(() => {}); }, ms);
}

async function refresh() {
  if (!current) return false;
  const r = await call('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: current.refresh_token } });
  if (r.ok && r.body) { setSession(fromTokens(r.body)); return true; }
  // A refresh token that the server rejects (revoked, expired, user deleted) ends the session.
  if (r.status >= 400 && r.status < 500) setSession(null);
  return false;
}

async function token() {
  if (!current) return null;
  if (current.expires_at * 1000 - Date.now() < 30000) await refresh();
  return current ? current.access_token : null;
}

// Tokens arrive in the URL fragment after an email confirmation link or an OAuth redirect.
function takeFragment() {
  if (!location.hash || location.hash.indexOf('access_token=') < 0 && location.hash.indexOf('error=') < 0) return null;
  const p = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname + location.search);
  if (p.get('error')) return { error: p.get('error_code') || p.get('error') };
  return { type: p.get('type') || '', tokens: { access_token: p.get('access_token'), refresh_token: p.get('refresh_token'),
    expires_at: Number(p.get('expires_at')) || 0, expires_in: Number(p.get('expires_in')) || 3600 } };
}

async function getConfig() {
  // config.json: written by the Cloudflare Pages build; /api/config: Netlify and the Node server.
  for (const url of ['/config.json', '/api/config']) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' }, credentials: 'same-origin' });
      if (!r.ok) continue;
      const j = await r.json();
      if (j && /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(j.supabaseUrl || '') && j.supabaseAnonKey) return j;
    } catch (e) {}
  }
  return null;
}

const ready = (async () => {
  cfg = await getConfig();
  if (!cfg) { info = { enabled: false, providers: {}, confirmEmail: false }; return info; }
  let settings = {};
  try { const r = await call('/auth/v1/settings'); if (r.ok) settings = r.body || {}; } catch (e) {}
  const ext = settings.external || {};
  info = { enabled: true, providers: { google: !!ext.google, apple: !!ext.apple },
    confirmEmail: !settings.mailer_autoconfirm, signupOpen: !settings.disable_signup, error: null };
  const frag = takeFragment();
  if (frag && frag.error) info.error = frag.error;
  if (frag && frag.tokens) {
    // The fragment carries no user object; fetch it with the new access token.
    const r = await call('/auth/v1/user', { headers: { authorization: 'Bearer ' + frag.tokens.access_token } });
    const s = fromTokens(Object.assign({}, frag.tokens, { user: r.ok ? r.body : {} }));
    if (s && r.ok) { current = s; save(s); }
    // A password-reset link signs the user in so they can choose a new password.
    if (s && r.ok && frag.type === 'recovery') info.recovery = true;
  } else {
    current = load();
    if (current && current.expires_at * 1000 - Date.now() < 30000) await refresh();
  }
  schedule();
  return info;
})();

function session() {
  if (!current || !current.user || !current.user.id) return null;
  const u = current.user, meta = u.user_metadata || {}, app = u.app_metadata || {};
  const provider = app.provider === 'google' ? 'Google' : app.provider === 'apple' ? 'iCloud' : 'Email';
  const lang = v => ['EN', 'RO', 'DE'].includes(v) ? v : null;
  return { userId: u.id, email: u.email || '', name: meta.full_name || meta.name || null, provider,
    since: Date.parse(u.last_sign_in_at || u.created_at || '') || Date.now(),
    // Language choices saved with the account, so they follow the user to every device.
    phone: typeof meta.phone_number === 'string' ? meta.phone_number : '',
    prefs: { contentLang: lang(meta.content_lang), appLang: lang(meta.app_lang) } };
}

async function signUp(email, password, name) {
  await ready; if (!cfg) return { error: 'unavailable' };
  const r = await call('/auth/v1/signup?redirect_to=' + encodeURIComponent(here()), { method: 'POST',
    body: { email, password, data: { full_name: name || null } } });
  if (!r.ok) return { error: errorCode(r) };
  const s = fromTokens(r.body);
  if (s) { setSession(s); return { ok: true, confirm: false }; }
  return { ok: true, confirm: true };
}

// The access token's claims (aal: 'aal1' | 'aal2').
function claims() {
  try {
    const p = current.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(escape(atob(p + '='.repeat((4 - p.length % 4) % 4)))));
  } catch (e) { return {}; }
}
function mfa() {
  const f = ((current && current.user && current.user.factors) || []).filter(x => x.factor_type === 'totp' && x.status === 'verified');
  const verified = !!current && claims().aal === 'aal2';
  return { enrolled: f.length > 0, verified, needed: f.length > 0 && !verified, factorId: f[0] ? f[0].id : null };
}
// The user object (with its factors) after a change.
async function reloadUser() {
  const t = await token(); if (!t) return;
  const r = await call('/auth/v1/user', { headers: { authorization: 'Bearer ' + t } });
  if (r.ok && r.body && r.body.id && current) { current.user = r.body; save(current); emit(); }
}
function mfaFactors() {
  return ((current && current.user && current.user.factors) || []).filter(x => x.factor_type === 'totp' && x.status === 'verified')
    .map(x => ({ id: x.id, name: x.friendly_name || 'Authenticator', created: x.created_at || '' }))
    .sort((a, b) => String(a.created).localeCompare(String(b.created)));
}
async function mfaEnroll(name) {
  const t = await token(); if (!t) return { error: 'failed' };
  // A setup that was started and never confirmed is dropped first.
  for (const f of ((current.user && current.user.factors) || []).filter(x => x.status !== 'verified')) {
    try { await call('/auth/v1/factors/' + encodeURIComponent(f.id), { method: 'DELETE', headers: { authorization: 'Bearer ' + t } }); } catch (e) {}
  }
  const r = await call('/auth/v1/factors', { method: 'POST', headers: { authorization: 'Bearer ' + t },
    // Names must differ between an account's authenticators.
    body: { factor_type: 'totp', friendly_name: (String(name || '').trim().slice(0, 40) || 'Authenticator') + ' · ' + new Date().toISOString().slice(0, 16).replace('T', ' ') } });
  if (!r.ok || !r.body || !r.body.totp) return { error: errorCode(r) };
  await reloadUser();
  // The QR code comes as SVG markup (older servers: already a data: address).
  const q = String(r.body.totp.qr_code || '');
  const qr = /^data:/.test(q) ? q : q ? 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(q) : '';
  return { factorId: r.body.id, qr, secret: r.body.totp.secret, uri: r.body.totp.uri };
}
async function mfaVerify(code, factorId) {
  const t = await token(); if (!t) return { error: 'failed' };
  const id = factorId || mfa().factorId;
  if (!id || !/^\d{6}$/.test(String(code || ''))) return { error: 'bad_code' };
  const h = { authorization: 'Bearer ' + t };
  const c = await call('/auth/v1/factors/' + encodeURIComponent(id) + '/challenge', { method: 'POST', headers: h, body: {} });
  if (!c.ok || !c.body || !c.body.id) return { error: c.status === 429 ? 'rate_limited' : 'failed' };
  const v = await call('/auth/v1/factors/' + encodeURIComponent(id) + '/verify', { method: 'POST', headers: h, body: { challenge_id: c.body.id, code: String(code) } });
  if (!v.ok) return { error: v.status === 429 ? 'rate_limited' : 'bad_code' };
  const s = fromTokens(v.body);
  if (s) { if (!s.user || !s.user.id) s.user = current.user; setSession(s); }
  await reloadUser();
  return { ok: true };
}
async function mfaUnenroll() {
  const t = await token(), id = mfa().factorId; if (!t || !id) return { error: 'failed' };
  const r = await call('/auth/v1/factors/' + encodeURIComponent(id), { method: 'DELETE', headers: { authorization: 'Bearer ' + t } });
  if (!r.ok) return { error: errorCode(r) };
  await refresh(); await reloadUser();
  return { ok: true };
}
// Removing an authenticator takes a current code first (from any of them), so an unlocked
// device left alone can't take two-factor off. The code makes a fresh aal2 session.
async function mfaRemove(factorId, code) {
  const list = mfaFactors(), target = list.find(f => f.id === factorId);
  if (!target) return { error: 'failed' };
  if (!/^\d{6}$/.test(String(code || ''))) return { error: 'bad_code' };
  // The code may come from any authenticator: the ones that stay first, so the fresh
  // session rests on one of them, then the one being removed.
  let ok = null;
  for (const f of list.filter(f => f.id !== factorId).concat([target])) {
    const r = await mfaVerify(code, f.id);
    if (r.ok) { ok = r; break; }
    if (r.error === 'rate_limited') return r;
  }
  if (!ok) return { error: 'bad_code' };
  const t = await token();
  const r = await call('/auth/v1/factors/' + encodeURIComponent(factorId), { method: 'DELETE', headers: { authorization: 'Bearer ' + t } });
  if (!r.ok) return { error: errorCode(r) };
  await refresh(); await reloadUser();
  return { ok: true };
}

// The lock screen: the password is checked by signing in once more, and that extra session
// is ended at once; the device keeps its own (aal2) session, so no code is asked again.
async function checkPassword(email, password) {
  await ready; if (!cfg) return { error: 'unavailable' };
  const r = await call('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
  if (!r.ok) return { error: errorCode(r) };
  if (r.body && r.body.access_token) {
    try { await call('/auth/v1/logout?scope=local', { method: 'POST', headers: { authorization: 'Bearer ' + r.body.access_token } }); } catch (e) {}
  }
  return { ok: true };
}

async function signIn(email, password) {
  await ready; if (!cfg) return { error: 'unavailable' };
  const r = await call('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
  if (!r.ok) return { error: errorCode(r) };
  setSession(fromTokens(r.body));
  return { ok: true };
}

async function resend(email) {
  await ready; if (!cfg) return { error: 'unavailable' };
  const r = await call('/auth/v1/resend?redirect_to=' + encodeURIComponent(here()), { method: 'POST', body: { type: 'signup', email } });
  return r.ok ? { ok: true } : { error: errorCode(r) };
}

// Supabase answers the same way whether or not the address has an account, so the
// UI never reveals who is registered.
async function recover(email) {
  await ready; if (!cfg) return { error: 'unavailable' };
  const r = await call('/auth/v1/recover?redirect_to=' + encodeURIComponent(here()), { method: 'POST', body: { email } });
  return r.ok ? { ok: true } : { error: errorCode(r) };
}

async function updatePassword(password) {
  const t = await token(); if (!t) return { error: 'failed' };
  const r = await call('/auth/v1/user', { method: 'PUT', headers: { authorization: 'Bearer ' + t }, body: { password } });
  if (!r.ok) return { error: errorCode(r) };
  if (info) info.recovery = false;
  if (r.body && r.body.id && current) { current.user = r.body; save(current); emit(); }
  return { ok: true };
}

// Saves preferences in the account's user metadata: { contentLang, appLang }.
async function updatePrefs(prefs) {
  const t = await token(); if (!t) return { error: 'failed' };
  const data = {};
  if (prefs.contentLang) data.content_lang = prefs.contentLang;
  if (prefs.appLang) data.app_lang = prefs.appLang;
  // The account's phone number ('' removes it), in international format.
  if (typeof prefs.phone === 'string') data.phone_number = prefs.phone;
  const r = await call('/auth/v1/user', { method: 'PUT', headers: { authorization: 'Bearer ' + t }, body: { data } });
  if (!r.ok) return { error: errorCode(r) };
  if (r.body && r.body.id && current) { current.user = r.body; save(current); }
  return { ok: true };
}

function oauth(provider) {
  if (!cfg) return;
  location.href = cfg.supabaseUrl.replace(/\/$/, '') + '/auth/v1/authorize?provider=' + encodeURIComponent(provider) +
    '&redirect_to=' + encodeURIComponent(here());
}

async function signOut(everywhere) {
  const t = current && current.access_token;
  // This device stops receiving the account's alerts (needs the token, so before it goes).
  if (t && window.HIFPush && window.HIFPush.forget) {
    try { await Promise.race([window.HIFPush.forget(), new Promise(r => setTimeout(r, 3000))]); } catch (e) {}
  }
  setSession(null);
  if (cfg && t) {
    try { await call('/auth/v1/logout?scope=' + (everywhere ? 'global' : 'local'), { method: 'POST', headers: { authorization: 'Bearer ' + t } }); } catch (e) {}
  }
}

// The server-owned plan from account_status (readable only for the caller's own row).
// No row, or the table not created yet, means the free plan. approved: false while the
// owner hasn't approved a new account (supabase/approval.sql); when the row can't be read
// it is assumed approved, and the server still refuses what an unapproved account asks for.
async function plan() {
  await ready;
  const t = await token(), s = session();
  if (!cfg || !t || !s) return { plan: 'free', suspended: false, approved: true, admin: false };
  const r = await call('/rest/v1/account_status?select=plan,suspended,approved,is_admin&user_id=eq.' + encodeURIComponent(s.userId),
    { headers: { authorization: 'Bearer ' + t, accept: 'application/json' } });
  if (!r.ok || !Array.isArray(r.body)) return { plan: 'free', suspended: false, approved: true, admin: false };
  const row = r.body[0] || null;
  return { plan: row && row.plan === 'pro' ? 'pro' : 'free', suspended: !!(row && row.suspended), approved: !!(row && row.approved !== false),
    admin: !!(row && row.is_admin) };
}

// Deletes the signed-in account and everything saved with it (supabase/account.sql), then
// forgets the session on this device. The caller checks the password first.
async function deleteAccount() {
  await ready;
  const t = await token();
  if (!cfg || !t) return { error: 'failed' };
  const r = await call('/rest/v1/rpc/delete_my_account', { method: 'POST', body: {}, headers: { authorization: 'Bearer ' + t } });
  if (!r.ok) {
    const msg = String((r.body && (r.body.message || r.body.msg)) || '');
    return { error: /two-factor/.test(msg) ? 'mfa' : /administrator/.test(msg) ? 'admin' : 'failed' };
  }
  // The server row went with the account; the browser still holds this device's alert
  // subscription until it is dropped here.
  if (window.HIFPush && window.HIFPush.forget) {
    try { await Promise.race([window.HIFPush.forget(), new Promise(r => setTimeout(r, 3000))]); } catch (e) {}
  }
  setSession(null);
  return { ok: true };
}

// PostgREST call as the signed-in user; row-level security limits it to their own rows.
async function rest(path, opts) {
  await ready;
  const t = await token();
  if (!cfg || !t) return { ok: false, status: 0, body: null };
  const o = opts || {};
  return call('/rest/v1/' + path, { method: o.method, body: o.body, headers: Object.assign({ authorization: 'Bearer ' + t }, o.headers || {}) });
}

function onChange(fn) { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; }

window.HIFAuth = { ready, session, signUp, signIn, resend, recover, updatePassword, updatePrefs, oauth, signOut, plan, token, onChange, rest,
  mfa, mfaEnroll, mfaVerify, mfaUnenroll, mfaFactors, mfaRemove, checkPassword, deleteAccount,
  enabled: () => !!(info && info.enabled), info: () => info,
  publicConfig: () => cfg ? { supabaseUrl: cfg.supabaseUrl, vapidPublicKey: cfg.vapidPublicKey || null } : null };
})();
