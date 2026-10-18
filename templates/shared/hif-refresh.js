// When the open app asks for fresh market data, and how it labels what it shows.
//
// The ingestion jobs write prices to Supabase every 15 minutes while a market trades, so the
// page only needs to look now and then, and only when someone is there to see it:
//   - never while the page is hidden;
//   - never after 15 minutes without a click, key or scroll (a browser pane left open all
//     night counts as "visible", which is what kept the old 5-minute poll running 24/7);
//   - at most every 5 minutes while one of the symbols' markets trades;
//   - with every market closed, once after the last close (closing prices), then not at all.
// Needs hif-markets.js.
(function(){
var MIN = 60000;
var IDLE_MS = 15 * MIN, MIN_INTERVAL_MS = 5 * MIN, LIVE_MAX_AGE_MS = 20 * MIN;
// The jobs run at :07 :22 :37 :52, so the last prices of a session land up to ~15 min after it.
var CLOSE_GRACE_MS = 20 * MIN;
function M(){ return (typeof window !== 'undefined' ? window : globalThis).HIFMarkets; }
function marketsOf(symbols){
  var out = [];
  (symbols || []).forEach(function(s){ var m = M().marketOf(s); if (m && out.indexOf(m) < 0) out.push(m); });
  return out;
}
function shouldRefresh(o){
  if (o.hidden) return false;
  var now = o.now || Date.now();
  if (now - (o.lastActivity || 0) > IDLE_MS) return false;
  if (!o.lastRefresh) return true;
  if (now - o.lastRefresh < MIN_INTERVAL_MS) return false;
  var mk = marketsOf(o.symbols), at = new Date(now);
  if (mk.some(function(m){ return M().isOpen(m, at); })) return true;
  // Closed: refresh only if the last look came before the latest close's prices were in.
  return mk.some(function(m){
    var c = M().lastClose(m, at);
    return c && o.lastRefresh < c.getTime() + CLOSE_GRACE_MS && now >= c.getTime() + CLOSE_GRACE_MS;
  });
}
// 'live' (recent, market trading), 'delayed' (trading but the data is older) or 'closed'.
function freshness(fetchedAtMs, symbols, now){
  var at = new Date(now || Date.now());
  var open = marketsOf(symbols).some(function(m){ return M().isOpen(m, at); });
  if (!open) return 'closed';
  return fetchedAtMs && at.getTime() - fetchedAtMs <= LIVE_MAX_AGE_MS ? 'live' : 'delayed';
}
var root = typeof window !== 'undefined' ? window : globalThis;
root.HIFRefresh = { IDLE_MS: IDLE_MS, MIN_INTERVAL_MS: MIN_INTERVAL_MS, LIVE_MAX_AGE_MS: LIVE_MAX_AGE_MS,
  shouldRefresh: shouldRefresh, freshness: freshness };
})();
