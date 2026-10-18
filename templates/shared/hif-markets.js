// Exchange trading hours, shared by the apps (smart refresh, "live" or "as of") and the
// ingestion jobs (ingest/, which only ask for prices of markets that are trading).
//
// Regular sessions, Monday to Friday, in each exchange's own time zone, so daylight saving
// changes are handled by Intl. Public holidays are not modelled: on one, a job just finds
// no new prices.
(function(){
var SESSIONS = {
  BVB:   { tz: 'Europe/Bucharest', open: [10, 0], close: [17, 45] },
  XETRA: { tz: 'Europe/Berlin',    open: [9, 0],  close: [17, 30] },
  LSE:   { tz: 'Europe/London',    open: [8, 0],  close: [16, 30] },
  US:    { tz: 'America/New_York', open: [9, 30], close: [16, 0] }
};
var DAY = 86400000;
var fmts = {};
function fmt(tz){
  return fmts[tz] || (fmts[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' }));
}
// The wall clock in tz: { y, m, d, hh, mm, ss, wd } (wd 0 = Sunday).
function local(date, tz){
  var o = {};
  fmt(tz).formatToParts(date).forEach(function(p){ o[p.type] = p.value; });
  return { y: +o.year, m: +o.month, d: +o.day, hh: +o.hour, mm: +o.minute, ss: +o.second,
    wd: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(o.weekday) };
}
// The instant when the wall clock in tz shows y-m-d hh:mm.
function instant(y, m, d, hh, mm, tz){
  var guess = Date.UTC(y, m - 1, d, hh, mm);
  for (var i = 0; i < 2; i++) {
    var l = local(new Date(guess), tz);
    var shown = Date.UTC(l.y, l.m - 1, l.d, l.hh, l.mm);
    guess += Date.UTC(y, m - 1, d, hh, mm) - shown;
  }
  return new Date(guess);
}

function marketOf(symbol){
  var s = String(symbol || '').toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.\-]{0,11}$/.test(s)) return null;
  if (/\.RO$/.test(s)) return 'BVB';
  if (/\.DE$/.test(s)) return 'XETRA';
  if (/\.L$/.test(s)) return 'LSE';
  // US symbols, share classes included (BRK.B, BF-A).
  if (/^[A-Z]{1,5}([.\-][A-C])?$/.test(s)) return 'US';
  return null;
}
function isOpen(market, date){
  var S = SESSIONS[market];
  if (!S) return false;
  var l = local(date || new Date(), S.tz);
  if (l.wd === 0 || l.wd === 6) return false;
  var min = l.hh * 60 + l.mm, open = S.open[0] * 60 + S.open[1], close = S.close[0] * 60 + S.close[1];
  return min >= open && min < close;
}
// The latest session end at or before date.
function lastClose(market, date){
  var S = SESSIONS[market];
  if (!S) return null;
  var now = date || new Date();
  for (var back = 0; back < 8; back++) {
    var l = local(new Date(now.getTime() - back * DAY), S.tz);
    if (l.wd === 0 || l.wd === 6) continue;
    var c = instant(l.y, l.m, l.d, S.close[0], S.close[1], S.tz);
    if (c.getTime() <= now.getTime()) return c;
  }
  return null;
}
function anyOpen(symbols, date){
  return (symbols || []).some(function(s){ var m = marketOf(s); return !!m && isOpen(m, date); });
}
function openMarkets(date){
  return Object.keys(SESSIONS).filter(function(m){ return isOpen(m, date); });
}

var root = typeof window !== 'undefined' ? window : globalThis;
root.HIFMarkets = { SESSIONS: SESSIONS, marketOf: marketOf, isOpen: isOpen, lastClose: lastClose, anyOpen: anyOpen, openMarkets: openMarkets };
})();
