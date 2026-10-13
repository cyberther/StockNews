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
// 10 minutes, since the job adds summaries a few minutes after each scan.
const summaryCache = new Map(); // id|lang -> { text, at }
const SUMMARY_ID = /^[A-Z0-9.\-]{1,12}:\d{1,20}$/;
async function loadSummaries(ids, lang) {
  const out = {};
  if (!live() || !lang) return out;
  const now = Date.now(), want = [];
  [...new Set(ids || [])].forEach(id => {
    if (!SUMMARY_ID.test(id)) return;
    const hit = summaryCache.get(id + '|' + lang);
    if (hit && (hit.text || now - hit.at < 600000)) { if (hit.text) out[id] = hit.text; }
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

window.HIFPush = { status, enable, disable, forget, syncWatchlist, loadWatchlist, syncHoldings, loadHoldings, loadSummaries, supported };
})();
