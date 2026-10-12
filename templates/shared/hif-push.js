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

window.HIFPush = { status, enable, disable, forget, syncWatchlist, loadWatchlist, supported };
})();
