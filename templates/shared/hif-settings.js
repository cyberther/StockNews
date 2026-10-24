// The reader's settings that follow the account (supabase/settings.sql), so they hold on every
// device and after the browser's storage is cleared: the theme, the lock timeout, the feed and
// portfolio views, and the chart's set-up, overall and per ticker (bar size, averages,
// indicators, automatic levels; chart type and log scale overall). Drawings are kept per ticker on their own
// (supabase/drawings.sql). Languages are kept with the account's profile (hif-auth.js prefs).
//
//   HIFSettings.pick(state)        -> the settings to save, from the app's state
//   HIFSettings.clean(saved)       -> the settings read back, checked one by one (anything
//                                     else, or of the wrong shape, is left out)
//   HIFSettings.withView(views, ticker, view) -> the per-ticker chart views with this one
//                                     updated (the most recent last, at most MAX_VIEWS)
(function () {
const MAX_VIEWS = 200;
const bool = v => typeof v === 'boolean';
const word = v => typeof v === 'string' && /^[A-Za-z0-9_.\-]{1,16}$/.test(v);
// { sma: true, rsi: false }: a few on/off switches.
const flags = v => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length <= 12 &&
  Object.keys(v).every(k => /^[a-z0-9_]{1,12}$/i.test(k) && bool(v[k]));
const TICKER = /^[A-Z0-9][A-Z0-9.\-]{0,14}$/;
const iv = v => typeof v === 'string' && /^\d{1,2}(m|d|wk|mo)$/.test(v);
function view(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  if (iv(v.iv)) out.iv = v.iv;
  if (flags(v.avg)) out.avg = v.avg;
  if (flags(v.ind)) out.ind = v.ind;
  if (bool(v.auto)) out.auto = v.auto;
  return Object.keys(out).length ? out : null;
}
function views(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out = {};
  Object.keys(v).filter(t => TICKER.test(t)).slice(-MAX_VIEWS).forEach(t => { const x = view(v[t]); if (x) out[t] = x; });
  return out;
}
const CHECK = {
  theme: v => ['dark', 'light', 'system'].indexOf(v) >= 0,
  timeoutMin: v => typeof v === 'number' && isFinite(v) && v >= 0 && v <= 1440,
  feedTab: word, screenFilter: word, chartRange: word, pfRange: word, filingsView: word,
  pfCur: v => typeof v === 'string' && /^[A-Z]{3}$/.test(v),
  overlays: flags, showOpinion: bool,
  lcIv: iv, lcAvg: flags, lcInd: flags, lcAuto: bool, lcLog: bool,
  lcType: v => ['candles', 'bars', 'line', 'area', 'heikin'].indexOf(v) >= 0,
  lcPen: v => typeof v === 'string' && /^[a-z]{2,10}$/.test(v),
};
const KEYS = Object.keys(CHECK).concat('lcView');

function clean(saved) {
  const out = {};
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return out;
  Object.keys(CHECK).forEach(k => { if (saved[k] !== undefined && CHECK[k](saved[k])) out[k] = saved[k]; });
  const v = views(saved.lcView);
  if (v) out.lcView = v;
  return out;
}
function pick(state) {
  const out = {};
  KEYS.forEach(k => { if (state && state[k] !== undefined && state[k] !== null) out[k] = state[k]; });
  return clean(out);
}
function withView(all, ticker, v) {
  const out = {};
  Object.keys(all || {}).forEach(t => { if (t !== ticker) out[t] = all[t]; });
  const x = view(v);
  if (x && TICKER.test(ticker || '')) out[ticker] = x;
  const keys = Object.keys(out);
  keys.slice(0, Math.max(0, keys.length - MAX_VIEWS)).forEach(t => delete out[t]);
  return out;
}

const api = { KEYS, MAX_VIEWS, pick, clean, withView };
if (typeof window !== 'undefined') window.HIFSettings = api;
if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
