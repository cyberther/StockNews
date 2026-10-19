// Push alerts for the Market Pulse apps.
//
// Two jobs, both only for real (Supabase) accounts:
//   - keep the signed-in user's watchlist on the server (public.watchlist), where the scan
//     Edge Function (supabase/functions/scan) looks for new stories every 30 minutes;
//   - subscribe this browser to web push and store the subscription
//     (public.push_subscriptions), so the scan can alert it.
// Row-level security limits every call to the user's own rows.
//
//   HIFPush.status()            -> Promise<'on' | 'off' | 'denied' | 'unsupported' | 'ios-install' | 'unavailable'>
//   HIFPush.enable()            -> Promise<{ ok } | { error }>, asks for notification permission
//   HIFPush.disable()           -> Promise<{ ok }>
//   HIFPush.forget()            -> drop this device's subscription (called on sign-out)
//   HIFPush.syncWatchlist(follows, pushMap) -> mirror the watchlist (debounce in the caller)
//   HIFPush.loadWatchlist()     -> Promise<[{ ticker, push }] | null>
//   HIFPush.syncHoldings(positions) -> mirror the positions ({ TICKER: { shares, cost } })
//   HIFPush.loadHoldings()      -> Promise<[{ ticker, shares, avg_price }] | null>
//   HIFPush.loadSummaries(ids, lang) -> Promise<{ storyId: summary }> (AI summaries)
(function(){
if (window.HIFPush) return;
const SW = '/templates/shared/hif-sw.js', SCOPE = '/templates/shared/';

const auth = () => window.HIFAuth || null;
const vapidKey = () => { const c = auth() && auth().publicConfig && auth().publicConfig(); return c && c.vapidPublicKey; };
const live = () => !!(auth() && auth().enabled() && auth().session());

function b64uToBytes(s) {
  const pad = '='.repeat((4 - s.length % 4) % 4);
  const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
function supported() {
  return window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}
// iPhone and iPad only offer web push to sites added to the Home Screen.
function iosBrowserTab() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
  return ios && !standalone;
}

async function registration(create) {
  if (!supported()) return null;
  let reg = await navigator.serviceWorker.getRegistration(SCOPE);
  if (!reg && create) reg = await navigator.serviceWorker.register(SW, { scope: SCOPE });
  if (!reg) return null;
  // The app pages sit outside the worker's scope, so wait for activation directly
  // rather than on navigator.serviceWorker.ready.
  if (!reg.active) {
    const w = reg.installing || reg.waiting;
    if (w) await new Promise(res => { const on = () => { if (w.state === 'activated') { w.removeEventListener('statechange', on); res(); } }; w.addEventListener('statechange', on); on(); });
  }
  return reg;
}
async function currentSub() {
  const reg = await registration(false);
  return reg ? reg.pushManager.getSubscription() : null;
}

async function status() {
  await (auth() ? auth().ready : Promise.resolve());
  if (!live() || !vapidKey()) return 'unavailable';
  if (!supported()) return iosBrowserTab() ? 'ios-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return (await currentSub()) ? 'on' : 'off';
}

async function save(sub) {
  const j = sub.toJSON(), s = auth().session();
  return auth().rest('push_subscriptions?on_conflict=endpoint', {
    method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: { endpoint: j.endpoint, user_id: s.userId, p256dh: j.keys.p256dh, auth: j.keys.auth, user_agent: navigator.userAgent.slice(0, 200) }
  });
}

async function enable() {
  if (!supported()) return { error: iosBrowserTab() ? 'ios-install' : 'unsupported' };
  if (!live() || !vapidKey()) return { error: 'unavailable' };
  // Must run from the user's tap: browsers only show the prompt for a user gesture.
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return { error: perm === 'denied' ? 'denied' : 'dismissed' };
  try {
    const reg = await registration(true);
    const opts = { userVisibleOnly: true, applicationServerKey: b64uToBytes(vapidKey()) };
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe(opts);
    let r = await save(sub);
    // The endpoint can still belong to another account that used this browser before;
    // a fresh subscription gets a fresh endpoint.
    if (!r.ok && (r.status === 401 || r.status === 403 || r.status === 409)) {
      await sub.unsubscribe().catch(() => {});
      sub = await reg.pushManager.subscribe(opts);
      r = await save(sub);
    }
    return r.ok ? { ok: true } : { error: 'save_failed' };
  } catch (e) {
    return { error: 'subscribe_failed' };
  }
}

async function forget() {
  const sub = await currentSub().catch(() => null);
  if (!sub) return { ok: true };
  if (live()) await auth().rest('push_subscriptions?endpoint=eq.' + encodeURIComponent(sub.endpoint), { method: 'DELETE' }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
  return { ok: true };
}
const disable = forget;

// This device's "Policy alerts" switch (push_subscriptions.policy_alerts, supabase/impact.sql):
// read with no argument, set with true/false. null: no subscription here, or no such column yet.
async function policyAlerts(on) {
  const sub = await currentSub().catch(() => null);
  if (!sub || !live()) return null;
  const q = 'push_subscriptions?endpoint=eq.' + encodeURIComponent(sub.endpoint);
  if (on === undefined) {
    const r = await auth().rest(q + '&select=policy_alerts');
    return r.ok && Array.isArray(r.body) && r.body[0] && typeof r.body[0].policy_alerts === 'boolean' ? r.body[0].policy_alerts : null;
  }
  const r = await auth().rest(q, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: { policy_alerts: !!on } });
  return r.ok ? !!on : null;
}

let lastSync = '';
async function syncWatchlist(follows, pushMap) {
  if (!live()) return;
  const s = auth().session(), list = (follows || []).filter(t => /^[A-Z0-9][A-Z0-9.\-]{0,11}$/.test(t));
  const rows = list.map(t => ({ user_id: s.userId, ticker: t, push: (pushMap || {})[t] !== false }));
  const sig = s.userId + '|' + JSON.stringify(rows);
  if (sig === lastSync) return;
  const up = rows.length
    ? await auth().rest('watchlist?on_conflict=user_id,ticker', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: rows })
    : { ok: true };
  const keep = list.length ? '&ticker=not.in.(' + encodeURIComponent(list.map(t => '"' + t + '"').join(',')) + ')' : '';
  const del = await auth().rest('watchlist?user_id=eq.' + s.userId + keep, { method: 'DELETE' });
  if (up.ok && del.ok) lastSync = sig;
}

async function loadWatchlist() {
  if (!live()) return null;
  const r = await auth().rest('watchlist?select=ticker,push&order=added_at.asc');
  return r.ok && Array.isArray(r.body) ? r.body : null;
}

// Positions (public.holdings, supabase/holdings.sql). Until that table exists both calls
// fail quietly and positions stay on the device.
const TICKER = /^[A-Z0-9][A-Z0-9.\-]{0,11}$/;
let lastHold = '';
async function syncHoldings(positions) {
  if (!live()) return;
  const s = auth().session(), map = positions || {};
  const rows = Object.keys(map).filter(t => TICKER.test(t)).map(t => {
    const shares = parseFloat(map[t] && map[t].shares), avg = parseFloat(map[t] && map[t].cost);
    return { user_id: s.userId, ticker: t, shares, avg_price: isFinite(avg) && avg >= 0 ? avg : null };
  }).filter(r => isFinite(r.shares) && r.shares > 0);
  const sig = s.userId + '|' + JSON.stringify(rows);
  if (sig === lastHold) return;
  const up = rows.length
    ? await auth().rest('holdings?on_conflict=user_id,ticker', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: rows })
    : { ok: true };
  const keep = rows.length ? '&ticker=not.in.(' + encodeURIComponent(rows.map(r => '"' + r.ticker + '"').join(',')) + ')' : '';
  const del = await auth().rest('holdings?user_id=eq.' + s.userId + keep, { method: 'DELETE' });
  if (up.ok && del.ok) lastHold = sig;
}

async function loadHoldings() {
  if (!live()) return null;
  const r = await auth().rest('holdings?select=ticker,shares,avg_price&order=ticker.asc');
  return r.ok && Array.isArray(r.body) ? r.body : null;
}

// AI summaries written by the batch job (public.story_summaries, supabase/summaries.sql):
// { 'NVDA:123': 'text' } for the ids that have one in lang. Misses are asked again after
// 10 minutes, or after 2 for the ids in `recent` (stories the job may be writing now).
// With `since` (the feed's window), every summary written since then is read in bulk, then
// only the newer ones each time (at most every 90 seconds), and the ids are answered from that.
const summaryCache = new Map(); // id|lang -> { text, at }
const SUMMARY_ID = /^[A-Z0-9.\-]{1,12}:\d{1,20}$/;
const bulk = {}, bulkBusy = {}; // lang -> { since, cursor, at }; lang -> the read in flight
function bulkSummaries(lang, since) {
  if (!bulkBusy[lang]) bulkBusy[lang] = readBulk(lang, since).finally(() => { bulkBusy[lang] = null; });
  return bulkBusy[lang];
}
async function readBulk(lang, since) {
  const b = bulk[lang] && bulk[lang].since <= since ? bulk[lang] : { since, cursor: since, at: 0 };
  if (Date.now() - b.at < 90000) return true;
  let cursor = b.cursor;
  for (let off = 0; off < 10000; off += 1000) {
    const r = await auth().rest('story_summaries?select=story_id,summary,created_at&lang=eq.' + encodeURIComponent(lang) +
      '&created_at=gte.' + encodeURIComponent(b.cursor) + '&order=created_at.asc&limit=1000&offset=' + off);
    if (!r.ok || !Array.isArray(r.body)) return false;
    r.body.forEach(row => { summaryCache.set(row.story_id + '|' + lang, { text: row.summary, at: Date.now() }); if (row.created_at > cursor) cursor = row.created_at; });
    if (r.body.length < 1000) break;
  }
  bulk[lang] = { since: b.since, cursor, at: Date.now() };
  return true;
}
async function loadSummaries(ids, lang, recent, since) {
  const out = {};
  if (!live() || !lang) return out;
  if (since && await bulkSummaries(lang, since).catch(() => false)) {
    [...new Set(ids || [])].forEach(id => { const hit = summaryCache.get(id + '|' + lang); if (hit && hit.text) out[id] = hit.text; });
    return out;
  }
  const now = Date.now(), want = [], soon = new Set(recent || []);
  [...new Set(ids || [])].forEach(id => {
    if (!SUMMARY_ID.test(id)) return;
    const hit = summaryCache.get(id + '|' + lang);
    if (hit && (hit.text || now - hit.at < (soon.has(id) ? 120000 : 600000))) { if (hit.text) out[id] = hit.text; }
    else want.push(id);
  });
  for (let i = 0; i < want.length; i += 60) {
    const part = want.slice(i, i + 60);
    const r = await auth().rest('story_summaries?select=story_id,summary&lang=eq.' + encodeURIComponent(lang) +
      '&story_id=in.(' + encodeURIComponent(part.map(x => '"' + x + '"').join(',')) + ')');
    if (!r.ok || !Array.isArray(r.body)) continue;
    const found = {};
    r.body.forEach(row => { found[row.story_id] = row.summary; });
    part.forEach(id => { summaryCache.set(id + '|' + lang, { text: found[id] || '', at: now }); if (found[id]) out[id] = found[id]; });
  }
  return out;
}

// Stories the scan stored (public.stories) since an ISO time, newest first; `filter` is a
// PostgREST condition on the ticker. Up to 5000.
async function loadStories(filter, since) {
  if (!live()) return [];
  const out = [];
  for (let off = 0; off < 5000; off += 1000) {
    const r = await auth().rest('stories?select=id,ticker,headline,source,url,summary,published_at&published_at=gte.' + encodeURIComponent(since) +
      '&' + filter + '&order=published_at.desc&limit=1000&offset=' + off);
    if (!r.ok || !Array.isArray(r.body)) break;
    out.push(...r.body);
    if (r.body.length < 1000) break;
  }
  return out;
}

// The latest digest of a ticker's previous trading day in lang (supabase/digests.sql), or null.
async function loadDigest(ticker, lang) {
  if (!live() || !ticker || !lang) return null;
  const r = await auth().rest('ticker_digests?select=day,digest,stories&ticker=eq.' + encodeURIComponent(ticker) +
    '&lang=eq.' + encodeURIComponent(lang) + '&order=day.desc&limit=1');
  return r.ok && Array.isArray(r.body) && r.body[0] ? r.body[0] : null;
}

// A Bucharest listing's filings, kept for years (supabase/filings.sql), newest first, with
// the figures the local model read from them (data) when it has.
async function loadFilings(ticker) {
  if (!live() || !ticker) return null;
  const r = await auth().rest('filings?select=id,url,title,published_at,first_seen,kind,source,official,data,extract_status&ticker=eq.' +
    encodeURIComponent(ticker) + '&order=published_at.desc.nullslast,first_seen.desc&limit=1000');
  return r.ok && Array.isArray(r.body) ? r.body : null;
}

// A test alert to every device of the signed-in account (the scan function's test path):
// { sent, devices } | { error: 'wait' | 'failed' | ... }.
async function testAlert() {
  if (!live()) return { error: 'unavailable' };
  const t = await auth().token(), c = auth().publicConfig && auth().publicConfig();
  if (!t || !c || !c.supabaseUrl) return { error: 'failed' };
  try {
    const res = await fetch(c.supabaseUrl.replace(/\/$/, '') + '/functions/v1/scan', { method: 'POST', headers: { authorization: 'Bearer ' + t, 'x-hif-test': '1' } });
    const j = await res.json().catch(() => ({}));
    if (res.status === 429) return { error: 'wait' };
    return res.ok ? { sent: j.sent || 0, devices: j.devices || 0 } : { error: j.error || 'failed' };
  } catch (e) { return { error: 'failed' }; }
}

// The stories an alert was about (ids "TICKER:id", the scan's public.stories).
async function loadStoriesById(ids) {
  const list = [...new Set(ids || [])].filter(id => /^[A-Z0-9.\-]+:[^,()"]{1,200}$/.test(id)).slice(0, 20);
  if (!live() || !list.length) return [];
  const r = await auth().rest('stories?select=id,ticker,headline,source,url,summary,published_at&id=in.(' +
    list.map(id => encodeURIComponent('"' + id + '"')).join(',') + ')&order=published_at.desc');
  return r.ok && Array.isArray(r.body) ? r.body : [];
}

// A Bucharest listing's report dates, general meeting and dividend dates, from its
// financial calendar (supabase/calendar.sql), oldest first.
async function loadReportDates(ticker) {
  if (!live() || !ticker) return null;
  const r = await auth().rest('report_dates?select=kind,year,q,day,hour,label&ticker=eq.' + encodeURIComponent(ticker) + '&order=day.asc&limit=100');
  return r.ok && Array.isArray(r.body) ? r.body : null;
}

// The user's drawings on one ticker's chart (supabase/drawings.sql), [] when none.
async function loadDrawings(ticker) {
  if (!live() || !ticker) return [];
  const r = await auth().rest('chart_drawings?select=drawings&ticker=eq.' + encodeURIComponent(ticker) + '&limit=1');
  return r.ok && Array.isArray(r.body) && r.body[0] && Array.isArray(r.body[0].drawings) ? r.body[0].drawings : [];
}
async function saveDrawings(ticker, list) {
  if (!live() || !ticker) return false;
  const s = auth().session();
  if (!s) return false;
  const r = await auth().rest('chart_drawings?on_conflict=user_id,ticker', { method: 'POST',
    headers: { prefer: 'resolution=merge-duplicates,return=minimal', 'content-type': 'application/json' },
    body: [{ user_id: s.userId, ticker, drawings: (list || []).slice(0, 100), updated_at: new Date().toISOString() }] });
  if (!r.ok) throw new Error('save ' + r.status);
  return true;
}

window.HIFPush = { status, enable, disable, forget, policyAlerts, syncWatchlist, loadWatchlist, syncHoldings, loadHoldings, loadSummaries, loadStories, loadDigest, loadFilings, loadReportDates, loadStoriesById, testAlert, loadDrawings, saveDrawings, supported };
})();
