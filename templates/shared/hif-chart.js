// Chart engine: synthetic price history, indicators, sampling and earnings markers.
// Pure functions on plain data — no DOM, no React, no app state. Consumed by both templates
// via window.HIFChart so chart behaviour is edited here, not inside a screen template.
(function(){
const SUB = 7;              // intraday bars per session in the backbone
const SESSIONS = 1300;      // ~5 years of sessions
const SEC_PER_SESSION = 86400 * 1.4;

function rng(key) {
  let seed = 7;
  for (let i = 0; i < key.length; i++) seed = (seed * 31 + key.charCodeAt(i)) % 99991;
  return () => { seed = (seed * 1103515 + 12345) % 2147483648; return seed / 2147483648; };
}

// One backbone per ticker: every range is a tail of the same history, so 1M nests inside
// 1Y nests inside 5Y. Two timescales — a fast AR(1) and a slow regime walk — so decimated
// long ranges keep their trends instead of collapsing into sawtooth noise.
const cache = {};
function backbone(ticker) {
  if (cache[ticker]) return cache[ticker];
  const rnd = rng(ticker + '|bb2');
  const gauss = () => (rnd() + rnd() + rnd() + rnd() - 2) / 1.15;
  const n = SESSIONS * SUB, out = [];
  let v = 1, fast = 0, slow = 0;
  for (let i = 0; i < n; i++) {
    fast = fast * 0.6 + gauss() * 0.0040;
    slow = slow * 0.997 + gauss() * 0.00016;
    v *= 1 + fast + slow;
    out.push(v);
  }
  const last = out[out.length - 1];
  return (cache[ticker] = out.map(x => x / last));
}

function ytdSessions() {
  const now = new Date(), jan = new Date(now.getFullYear(), 0, 1);
  return Math.max(10, Math.round((now - jan) / 86400000 * 252 / 365));
}

const SPAN = { '5d':5, '1mo':22, '6mo':126, '1y':252, '5y':1299 };

function seriesFor(ticker, range, priceStr, moveStr, cap) {
  const base = parseFloat(String(priceStr || '').replace(/[^0-9.]/g, '')) || 100;
  const mv = parseFloat(String(moveStr || '').replace('\u2212','-').replace(/[^0-9.\-]/g, ''));
  const dayMove = isFinite(mv) ? mv / 100 : 0;
  const maxN = Math.max(8, cap || 78);

  if (range === '1d') {
    // Intraday walk on the regular session grid, pinned to today's open and the live last price.
    const rnd = rng(ticker + '|1d');
    const gauss = () => (rnd() + rnd() + rnd() + rnd() - 2) / 1.15;
    const n = Math.min(78, maxN), step = 23400 / Math.max(n - 1, 1);
    const raw = []; let v = 1, drift = 0;
    for (let i = 0; i < n; i++) { drift = drift * 0.6 + gauss() * 0.0022; v *= 1 + drift; raw.push(v); }
    const open = (1 + dayMove) !== 0 ? base / (1 + dayMove) : base;
    const f0 = raw[0], sp = raw[n-1] - f0;
    const d = new Date(); d.setHours(9,30,0,0);
    const t0 = Math.floor(d.getTime() / 1000);
    return raw.map((x,i) => {
      const t = n > 1 ? i / (n - 1) : 1;
      return { ts: Math.round(t0 + i * step), close: +(open + (base - open) * t + (x - (f0 + sp * t)) * base).toFixed(2) };
    });
  }

  const bb = backbone(ticker);
  const sessions = range === 'ytd' ? ytdSessions() : (SPAN[range] || 126);
  const slice = bb.slice(Math.max(0, bb.length - 1 - sessions * SUB));
  const n = Math.max(2, Math.min(slice.length, maxN)); // never upsample: no duplicated vertices
  const stride = (slice.length - 1) / Math.max(n - 1, 1);
  const secPerBar = SEC_PER_SESSION / SUB;
  const now = Math.floor(Date.now() / 1000), out = [];
  for (let i = 0; i < n; i++) {
    const si = Math.round(i * stride);
    out.push({ ts: Math.round(now - (slice.length - 1 - si) * secPerBar), close: +(slice[si] * base).toFixed(2) });
  }
  return out;
}

function movingAverage(values, period) {
  return values.map((_, i) => i < period - 1 ? null : values.slice(i - period + 1, i + 1).reduce((a,b) => a + b, 0) / period);
}

function rsiSeries(values, period) {
  const out = values.map(() => null);
  if (values.length <= period) return out;
  for (let i = period; i < values.length; i++) {
    let g = 0, l = 0;
    for (let k = i - period + 1; k <= i; k++) { const d = values[k] - values[k-1]; if (d >= 0) g += d; else l -= d; }
    out[i] = l === 0 ? 100 : 100 - (100 / (1 + g / l));
  }
  return out;
}

function downsample(pts, cap) {
  if (!pts || pts.length <= cap) return pts || [];
  const out = [], stride = (pts.length - 1) / (cap - 1);
  for (let i = 0; i < cap; i++) out.push(pts[Math.round(i * stride)]);
  return out;
}

// Real earnings when the feed has them, otherwise quarters stepped back from `nextTs`.
// Thinned to stay legible: quarterly bars stop working once a quarter is a few pixels wide.
function earningsMarks(points, opts) {
  const o = opts || {};
  if (!points || !points.length) return [];
  const t0 = points[0].ts, t1 = points[points.length-1].ts;
  let list = (o.live || []).map(e => Object.assign({}, e, { ts: Date.parse(e.date) / 1000 })).filter(e => isFinite(e.ts));
  if (!list.length) {
    if (o.nextTs == null) return [];
    let ts = o.nextTs;
    for (let i = 0; i < 24 && ts > t0 - 86400; i++) {
      list.push({ date: new Date(ts * 1000).toLocaleDateString([], { month:'short', day:'numeric', year:'numeric' }), ts, estimated:true });
      ts -= 91 * 86400;
    }
  }
  let inRange = list.filter(e => e.ts >= t0 && e.ts <= t1).sort((a,b) => a.ts - b.ts);
  const perQuarter = points.length / Math.max((t1 - t0) / (91 * 86400), 1);
  if (perQuarter < 6) inRange = inRange.filter((_, i, a) => (a.length - 1 - i) % 4 === 0);
  if (inRange.length > 10) inRange = inRange.slice(-10);
  return inRange.map(e => {
    let idx = 0, best = Infinity;
    points.forEach((p,i) => { const d = Math.abs(p.ts - e.ts); if (d < best) { best = d; idx = i; } });
    return Object.assign({}, e, { idx });
  });
}

// Price at a point in the past, read off the same backbone the charts draw. Demo time is
// compressed (one backbone bar per DEMO_BAR seconds) so a skipped story develops an outcome
// in minutes rather than months; with a live feed this is replaced by real historical quotes.
const DEMO_BAR = 20;
function priceAt(ticker, secondsAgo, basePrice) {
  const base = parseFloat(String(basePrice || '').replace(/[^0-9.]/g, ''));
  if (!isFinite(base)) return null;
  const bb = backbone(ticker);
  const back = Math.round(Math.max(0, secondsAgo) / DEMO_BAR);
  const i = bb.length - 1 - back;
  if (i < 0) return null;
  return +(bb[i] * base).toFixed(2);
}

// Ranges wide enough for quarterly earnings bars to mean anything.
function supportsEarningsBars(range) { return range === '6mo' || range === 'ytd' || range === '1y' || range === '5y'; }

window.HIFChart = { rng, backbone, seriesFor, movingAverage, rsiSeries, downsample, earningsMarks, supportsEarningsBars, priceAt, SUB };
})();
