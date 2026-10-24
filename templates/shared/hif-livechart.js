// The live chart page's chart: candles, volume and optional moving averages, drawn by
// TradingView Lightweight Charts (vendor/lightweight-charts.standalone.production.js, loaded
// the first time the page opens). The app owns the data and the refresh; this only draws.
//
//   const c = await HIFLiveChart.create(el, { tz: 'America/New_York', locale: 'ro-RO', intraday: true, onHover })
//   c.setBars([{ t, o, h, l, c, v }, ...])   all bars (a new symbol or bar size)
//   c.mergeBars([...])                       the latest bars (a refresh): updates the last, adds new ones
//   c.zoom(0.7) / c.zoom(1.4) / c.reset()    narrower / wider / the last ~150 bars
//   c.setAverages({ sma20: true, sma200: true, ema9: false })  (AVERAGES)
//   c.setIndicators({ macd: true, dmi: false, rsi: true })    each in its own pane under the
//                                                             chart, in this order
//   c.setTheme()   c.destroy()
// Drawing (support and resistance, trends): c.setTool('hline' | 'trend' | 'zone' | 'fib' |
// 'measure' | null), c.setDrawings(list), c.removeDrawing(id), c.clearDrawings(),
// c.setAutoLevels(true), c.setPen('blue'); onDraw(list) is called when the user adds one.
// A drawing keeps real times and prices and its colour ({ id, type, c, a: { t, p },
// b: { t, p } }), so it stays in place when the bar size changes.
// Colours come from the page's --lc-<name> variables (one set for dark, one for light), so
// lines stay clear on either theme.
// Times are shown in the exchange's time zone (tz), as trading platforms do.
(function () {
  let lib = null;
  function loadLib() {
    if (window.LightweightCharts) return Promise.resolve(window.LightweightCharts);
    if (!lib) lib = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = new URL('../shared/vendor/lightweight-charts.standalone.production.js', location.href).toString();
      s.onload = () => window.LightweightCharts ? resolve(window.LightweightCharts) : reject(new Error('chart library missing'));
      s.onerror = () => { lib = null; reject(new Error('chart library not loaded')); };
      document.head.appendChild(s);
    });
    return lib;
  }

  // Seconds east of UTC in a time zone at an instant (cached per hour).
  const offsets = new Map();
  function offsetAt(tz, sec) {
    if (!tz) return 0;
    const key = tz + '|' + Math.floor(sec / 3600);
    if (offsets.has(key)) return offsets.get(key);
    let off = 0;
    try {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(sec * 1000)).map(x => [x.type, x.value]));
      off = Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) / 1000) - sec);
    } catch (e) {}
    if (offsets.size > 20000) offsets.clear();
    offsets.set(key, off);
    return off;
  }

  const css = (el, name, fallback) => (getComputedStyle(el).getPropertyValue(name) || '').trim() || fallback;
  const fade = (hex, a) => {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    return m ? `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})` : hex;
  };
  // ---- indicators: arrays of numbers in, arrays (null where not yet defined) out ----------
  function smaOf(v, n) {
    const out = new Array(v.length).fill(null); let sum = 0;
    v.forEach((x, i) => { sum += x; if (i >= n) sum -= v[i - n]; if (i >= n - 1) out[i] = sum / n; });
    return out;
  }
  // Exponential, started from the simple average of the first n values (nulls skipped).
  function emaOf(v, n) {
    const out = new Array(v.length).fill(null), a = 2 / (n + 1);
    let prev = null, seed = [], i0 = v.findIndex(x => x != null);
    if (i0 < 0) return out;
    for (let i = i0; i < v.length; i++) {
      if (prev == null) { seed.push(v[i]); if (seed.length === n) { prev = seed.reduce((x, y) => x + y, 0) / n; out[i] = prev; } continue; }
      prev = v[i] * a + prev * (1 - a); out[i] = prev;
    }
    return out;
  }
  // Wilder's smoothing (RSI, DMI): the first value is the average of n, then (prev*(n-1)+x)/n.
  function wilder(v, n, from) {
    const out = new Array(v.length).fill(null);
    if (v.length < from + n) return out;
    let prev = 0;
    for (let i = from; i < from + n; i++) prev += v[i];
    prev /= n; out[from + n - 1] = prev;
    for (let i = from + n; i < v.length; i++) { prev = (prev * (n - 1) + v[i]) / n; out[i] = prev; }
    return out;
  }
  function rsiOf(c, n) {
    const up = c.map((x, i) => i ? Math.max(0, x - c[i - 1]) : 0), dn = c.map((x, i) => i ? Math.max(0, c[i - 1] - x) : 0);
    const au = wilder(up, n, 1), ad = wilder(dn, n, 1);
    return au.map((u, i) => u == null ? null : ad[i] === 0 ? 100 : 100 - 100 / (1 + u / ad[i]));
  }
  function macdOf(c, f, sl, sig) {
    const a = emaOf(c, f), b = emaOf(c, sl), line = a.map((x, i) => x == null || b[i] == null ? null : x - b[i]);
    const signal = emaOf(line, sig);
    return { line, signal, hist: line.map((x, i) => x == null || signal[i] == null ? null : x - signal[i]) };
  }
  function dmiOf(bars, n) {
    const tr = [0], pdm = [0], mdm = [0];
    for (let i = 1; i < bars.length; i++) {
      const b = bars[i], p = bars[i - 1], up = b.high - p.high, dn = p.low - b.low;
      tr.push(Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)));
      pdm.push(up > dn && up > 0 ? up : 0); mdm.push(dn > up && dn > 0 ? dn : 0);
    }
    const str = wilder(tr, n, 1), sp = wilder(pdm, n, 1), sm = wilder(mdm, n, 1);
    const plus = str.map((t, i) => t == null || !t ? null : 100 * sp[i] / t), minus = str.map((t, i) => t == null || !t ? null : 100 * sm[i] / t);
    const dx = plus.map((p, i) => p == null ? null : (p + minus[i]) ? 100 * Math.abs(p - minus[i]) / (p + minus[i]) : 0);
    const from = dx.findIndex(x => x != null);
    const adx = from < 0 ? dx.map(() => null) : wilder(dx.map(x => x || 0), n, from);
    return { plus, minus, adx };
  }
  // Bars below are { high, low, close, volume } (as the chart keeps them).
  const trOf = bars => bars.map((b, i) => i ? Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)) : b.high - b.low);
  // Bollinger bands: the n-bar average and k standard deviations (of the population) around it.
  function bollingerOf(c, n, k) {
    const mid = smaOf(c, n), up = mid.slice(), lo = mid.slice();
    mid.forEach((m, i) => {
      if (m == null) return;
      let s = 0; for (let j = i - n + 1; j <= i; j++) s += (c[j] - m) ** 2;
      const sd = Math.sqrt(s / n); up[i] = m + k * sd; lo[i] = m - k * sd;
    });
    return { mid, up, lo };
  }
  // Stochastic %K (n bars, smoothed over sk) and %D (its sd-bar average).
  function stochOf(bars, n, sk, sd) {
    const raw = bars.map((b, i) => {
      if (i < n - 1) return null;
      let hi = -Infinity, lo = Infinity;
      for (let j = i - n + 1; j <= i; j++) { hi = Math.max(hi, bars[j].high); lo = Math.min(lo, bars[j].low); }
      return hi === lo ? 50 : 100 * (b.close - lo) / (hi - lo);
    });
    const avg = (v, m) => v.map((x, i) => { if (i < m - 1) return null; let s = 0; for (let j = i - m + 1; j <= i; j++) { if (v[j] == null) return null; s += v[j]; } return s / m; });
    const k = avg(raw, sk);
    return { k, d: avg(k, sd) };
  }
  // Average true range, Wilder-smoothed.
  const atrOf = (bars, n) => wilder(trOf(bars), n, 1);
  // On-balance volume: the volume added on an up close, taken away on a down one.
  function obvOf(bars) {
    let s = 0;
    return bars.map((b, i) => { if (i) s += b.close > bars[i - 1].close ? (b.volume || 0) : b.close < bars[i - 1].close ? -(b.volume || 0) : 0; return s; });
  }
  // Commodity channel index: the typical price's distance from its n-bar average, in mean deviations.
  function cciOf(bars, n) {
    const tp = bars.map(b => (b.high + b.low + b.close) / 3), m = smaOf(tp, n);
    return tp.map((x, i) => {
      if (m[i] == null) return null;
      let md = 0; for (let j = i - n + 1; j <= i; j++) md += Math.abs(tp[j] - m[i]);
      md /= n;
      return md ? (x - m[i]) / (0.015 * md) : 0;
    });
  }
  // Williams %R: where the close sits in the n-bar range, 0 at the top and -100 at the bottom.
  function willrOf(bars, n) {
    return bars.map((b, i) => {
      if (i < n - 1) return null;
      let hi = -Infinity, lo = Infinity;
      for (let j = i - n + 1; j <= i; j++) { hi = Math.max(hi, bars[j].high); lo = Math.min(lo, bars[j].low); }
      return hi === lo ? -50 : -100 * (hi - b.close) / (hi - lo);
    });
  }
  // Volume-weighted average price, started again at each session (dayOf(i) changes).
  function vwapOf(bars, dayOf) {
    let pv = 0, vol = 0, day = null;
    return bars.map((b, i) => {
      const d = dayOf(i);
      if (d !== day) { day = d; pv = 0; vol = 0; }
      const v = b.volume || 0; pv += (b.high + b.low + b.close) / 3 * v; vol += v;
      return vol ? pv / vol : null;
    });
  }
  // Ichimoku (9, 26, 52). spanA and spanB are drawn 26 bars ahead, lagging 26 bars behind:
  // the arrays are per bar, the shift is the drawing's.
  function ichimokuOf(bars, a, b, c) {
    const mid = n => bars.map((x, i) => {
      if (i < n - 1) return null;
      let hi = -Infinity, lo = Infinity;
      for (let j = i - n + 1; j <= i; j++) { hi = Math.max(hi, bars[j].high); lo = Math.min(lo, bars[j].low); }
      return (hi + lo) / 2;
    });
    const tenkan = mid(a), kijun = mid(b), spanB = mid(c);
    const spanA = tenkan.map((t, i) => t == null || kijun[i] == null ? null : (t + kijun[i]) / 2);
    return { tenkan, kijun, spanA, spanB, lagging: bars.map(x => x.close), shift: b };
  }
  // Heikin Ashi bars from ordinary ones.
  function heikinAshi(bars) {
    const out = [];
    bars.forEach((b, i) => {
      const close = (b.open + b.high + b.low + b.close) / 4;
      const open = i ? (out[i - 1].open + out[i - 1].close) / 2 : (b.open + b.close) / 2;
      out.push(Object.assign({}, b, { open, close, high: Math.max(b.high, open, close), low: Math.min(b.low, open, close) }));
    });
    return out;
  }
  // Volume by price over some bars: rows of equal height between their low and high, each bar's
  // volume spread evenly over the rows it covers. poc: the row with the most.
  function volumeProfile(bars, rows) {
    if (!bars.length) return null;
    const lo = Math.min(...bars.map(b => b.low)), hi = Math.max(...bars.map(b => b.high));
    if (!(hi > lo)) return null;
    const h = (hi - lo) / rows, vol = new Array(rows).fill(0);
    bars.forEach(b => {
      const r0 = Math.min(rows - 1, Math.floor((b.low - lo) / h)), r1 = Math.min(rows - 1, Math.floor((b.high - lo) / h)), n = r1 - r0 + 1;
      for (let r = r0; r <= r1; r++) vol[r] += (b.volume || 0) / n;
    });
    let poc = 0; vol.forEach((v, i) => { if (v > vol[poc]) poc = i; });
    return { lo, hi, h, vol, poc };
  }

  const AVERAGES = [['sma20', 'SMA 20', 'blue'], ['sma50', 'SMA 50', 'orange'], ['sma100', 'SMA 100', 'purple'], ['sma200', 'SMA 200', 'pink'],
    ['ema9', 'EMA 9', 'teal'], ['ema21', 'EMA 21', 'yellow']];
  // Drawn over the price: Bollinger, VWAP (bars shorter than a day), Ichimoku, volume profile.
  const OVERLAYS = [['bb', 'Bollinger 20 2', 'teal'], ['vwap', 'VWAP', 'yellow'], ['ichimoku', 'Ichimoku', 'purple'], ['vprofile', 'Volume profile', 'blue']];
  const INDICATORS = [['macd', 'MACD'], ['dmi', 'DMI'], ['rsi', 'RSI'], ['stoch', 'Stoch'], ['atr', 'ATR'], ['obv', 'OBV'], ['cci', 'CCI'], ['willr', '%R']];
  const TYPES = ['candles', 'bars', 'line', 'area', 'heikin'];
  // How many clicks each drawing takes.
  const POINTS = { hline: 1, hray: 1, vline: 1, text: 1, trend: 2, ext: 2, arrow: 2, zone: 2, rect: 2, fib: 2, measure: 2, channel: 3, fibext: 3, pitchfork: 3 };
  const FIBEXT = [0, 0.618, 1, 1.618, 2.618];
  const PENS = ['blue', 'orange', 'green', 'red', 'purple', 'yellow'];
  // A drawing saved before it had a colour.
  const PEN_OF = { hline: 'blue', trend: 'orange', zone: 'teal', fib: 'purple' };
  const DARK = { blue: '#5AA9FF', orange: '#FF9F43', green: '#3DDC84', red: '#FF5C6C', purple: '#C08CFF', teal: '#2ED1C1', pink: '#FF7AB6', yellow: '#FFD54A' };

  // Support and resistance from the bars (the last 400): swing highs and lows (a bar higher or
  // lower than the 5 before and the 3 after it; 3 and 2 for weekly and monthly bars, so a
  // recent pullback counts), grouped into bands
  // of +/- tol around the busiest price first, so a band never creeps along the chart. tol is
  // 0.6 of the average true range (at least 0.15% of the price). Each band's level is the
  // median of its swings; touches is how many swings it has. Above the last close are
  // resistances, below supports: the 3 closest each within 8 average ranges of the price,
  // preferring bands touched twice or more and keeping them at least 1.5 tol apart.
  // A swing must be strictly beyond the bars after it, so a run of equal prices (a quiet
  // Bucharest share trading at one tick) counts once, not once per bar.
  function autoLevels(all, long) {
    const bars = all.slice(-400), n = bars.length, w = long ? 3 : 5, wr = long ? 2 : 3;
    if (n < w + wr + 10) return [];
    const last = bars[n - 1].close;
    let atr = 0, m = 0;
    for (let i = Math.max(1, n - 100); i < n; i++, m++) {
      const b = bars[i], pc = bars[i - 1].close;
      atr += Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
    }
    atr = m ? atr / m : 0;
    const tol = Math.max(atr * 0.6, last * 0.0015);
    const pts = [];
    for (let i = w; i < n - wr; i++) {
      let hi = true, lo = true;
      for (let j = i - w; j <= i + wr; j++) {
        if (j === i) continue;
        if (j < i ? bars[j].high > bars[i].high : bars[j].high >= bars[i].high) hi = false;
        if (j < i ? bars[j].low < bars[i].low : bars[j].low <= bars[i].low) lo = false;
      }
      if (hi) pts.push(bars[i].high);
      if (lo) pts.push(bars[i].low);
    }
    pts.sort((a, b) => a - b);
    const bands = [];
    let left = pts.slice();
    while (left.length) {
      // The point with the most others within tol of it.
      let best = 0, bestN = 0;
      for (let a = 0, b = 0, c = 0; c < left.length; c++) {
        while (left[c] - left[a] > tol) a++;
        while (b < left.length && left[b] - left[c] <= tol) b++;
        if (b - a > bestN) { bestN = b - a; best = c; }
      }
      const lo = left[best] - tol, hi = left[best] + tol;
      const inBand = left.filter(p => p >= lo && p <= hi);
      bands.push({ p: inBand[Math.floor(inBand.length / 2)], touches: inBand.length });
      left = left.filter(p => p < lo || p > hi);
    }
    const pick = side => {
      const near = side.filter(x => Math.abs(x.p - last) <= Math.max(atr * 8, tol * 3)).sort((a, b) => Math.abs(a.p - last) - Math.abs(b.p - last)), out = [];
      const add = x => { if (out.length < 3 && out.every(y => Math.abs(y.p - x.p) >= tol * 1.5)) out.push(x); };
      near.filter(x => x.touches >= 2).forEach(add);
      near.filter(x => x.touches < 2).forEach(add);
      return out.sort((a, b) => Math.abs(a.p - last) - Math.abs(b.p - last));
    };
    const above = pick(bands.filter(x => x.p > last)).map((x, i) => Object.assign(x, { label: 'R' + (i + 1) }));
    const below = pick(bands.filter(x => x.p <= last)).map((x, i) => Object.assign(x, { label: 'S' + (i + 1) }));
    return above.concat(below);
  }
  const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

  async function create(el, opts) {
    const LWC = await loadLib();
    const o = Object.assign({ tz: '', locale: undefined, intraday: true, seconds: false, onHover: null, onDraw: null, step: 60, askText: null }, opts || {});
    const colors = () => Object.assign({ bg: css(el, '--s-bg', '#121212'), ink: css(el, '--s-ink', '#F5F5F7'), mute: css(el, '--s-mute', '#A0A0A0'),
      rule: css(el, '--s-rule', '#333333'), accent: css(el, '--color-accent', '#D4AF37') },
      Object.fromEntries(Object.keys(DARK).map(n => [n, css(el, '--lc-' + n, DARK[n])])));
    const penOf = d => k[d.c] || k[PEN_OF[d.type]] || k.blue;
    let k = colors();
    const chart = LWC.createChart(el, {
      autoSize: true,
      layout: { background: { type: 'solid', color: 'transparent' }, textColor: k.mute, fontFamily: getComputedStyle(el).fontFamily, attributionLogo: true },
      grid: { vertLines: { color: fade(k.rule, 0.35) }, horzLines: { color: fade(k.rule, 0.35) } },
      rightPriceScale: { borderColor: k.rule },
      timeScale: { borderColor: k.rule, timeVisible: o.intraday, secondsVisible: o.seconds, rightOffset: 6, minBarSpacing: 1 },
      crosshair: { mode: LWC.CrosshairMode.Normal },
      localization: { locale: o.locale }
    });
    const candles = chart.addSeries(LWC.CandlestickSeries, {
      upColor: k.ink, downColor: k.accent, borderUpColor: k.ink, borderDownColor: k.accent, wickUpColor: k.ink, wickDownColor: k.accent });
    const volume = chart.addSeries(LWC.HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    candles.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.24 } });
    const avgSeries = {};
    let avgOn = {}, indOn = {}, indSeries = [], bars = [], pen = 'blue', type = 'candles', logScale = false, alt = null, cmp = null, cmpLabel = '';
    // Other chart types draw over the candles, which stay (see-through) as the series the
    // drawings, levels and price scale are tied to.
    const candleColors = () => type === 'candles' || type === 'heikin'
      ? { upColor: k.ink, downColor: k.accent, borderUpColor: k.ink, borderDownColor: k.accent, wickUpColor: k.ink, wickDownColor: k.accent, lastValueVisible: true, priceLineVisible: true }
      : { upColor: 'transparent', downColor: 'transparent', borderUpColor: 'transparent', borderDownColor: 'transparent', wickUpColor: 'transparent', wickDownColor: 'transparent', lastValueVisible: false, priceLineVisible: false };
    function drawMain() {
      candles.applyOptions(candleColors());
      candles.setData(type === 'heikin' ? heikinAshi(bars) : bars);
      const want = type === 'bars' ? 'bars' : type === 'line' ? 'line' : type === 'area' ? 'area' : null;
      if (alt && alt.kind !== want) { chart.removeSeries(alt.s); alt = null; }
      if (want && !alt) alt = { kind: want, s: want === 'bars' ? chart.addSeries(LWC.BarSeries, { upColor: k.ink, downColor: k.accent, thinBars: false })
        : want === 'line' ? chart.addSeries(LWC.LineSeries, { color: k.ink, lineWidth: 2, crosshairMarkerVisible: true })
        : chart.addSeries(LWC.AreaSeries, { lineColor: k.accent, topColor: fade(k.accent, 0.35), bottomColor: fade(k.accent, 0.02), lineWidth: 2 }) };
      if (alt) alt.s.setData(want === 'bars' ? bars.map(b => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close })) : bars.map(b => ({ time: b.time, value: b.close })));
    }
    function scaleMode() {
      candles.priceScale().applyOptions({ mode: cmp ? LWC.PriceScaleMode.Percentage : logScale ? LWC.PriceScaleMode.Logarithmic : LWC.PriceScaleMode.Normal });
    }
    // Bollinger and VWAP are lines over the price; Ichimoku's cloud and the volume profile are
    // painted under it (the under layer).
    const ovSeries = {};
    function drawOverlays() {
      const want = [];
      if (avgOn.bb) want.push(['bb_up', k.teal, 1], ['bb_mid', k.teal, 1, LWC.LineStyle.Dashed], ['bb_lo', k.teal, 1]);
      if (avgOn.vwap && o.intraday) want.push(['vwap', k.yellow, 2]);
      Object.keys(ovSeries).forEach(id => { if (!want.some(w => w[0] === id)) { chart.removeSeries(ovSeries[id]); delete ovSeries[id]; } });
      want.forEach(([id, color, w, style]) => { if (!ovSeries[id]) ovSeries[id] = chart.addSeries(LWC.LineSeries, { color, lineWidth: w, lineStyle: style || 0,
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }); });
      if (bars.length && ovSeries.bb_up) { const b = bollingerOf(bars.map(x => x.close), 20, 2); ovSeries.bb_up.setData(points(b.up)); ovSeries.bb_mid.setData(points(b.mid)); ovSeries.bb_lo.setData(points(b.lo)); }
      if (bars.length && ovSeries.vwap) {
        const day = i => new Date((bars[i].time) * 1000).toISOString().slice(0, 10);
        ovSeries.vwap.setData(points(vwapOf(bars, day)));
      }
      redraw();
    }

    // ---- drawings ----------------------------------------------------------------------
    let drawings = [], tool = null, pts = [], hover = null, autoOn = false, autoLines = [];
    const hLines = new Map(); // drawing id -> price line
    // Real time <-> position on the time axis (fractional; past the last bar by bar size).
    function logicalOf(t) {
      const n = bars.length;
      if (!n) return null;
      const T = i => bars[i].raw.t;
      if (t >= T(n - 1)) return n - 1 + (t - T(n - 1)) / o.step;
      if (t <= T(0)) return (t - T(0)) / o.step;
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (T(mid) <= t) lo = mid; else hi = mid; }
      return lo + (t - T(lo)) / Math.max(1, T(hi) - T(lo));
    }
    function timeOf(l) {
      const n = bars.length;
      if (!n || l == null) return null;
      const T = i => bars[i].raw.t;
      if (l >= n - 1) return Math.round(T(n - 1) + (l - (n - 1)) * o.step);
      if (l <= 0) return Math.round(T(0) + l * o.step);
      const i = Math.floor(l);
      return Math.round(T(i) + (l - i) * (T(i + 1) - T(i)));
    }
    const fmtP = v => Number(v).toLocaleString(o.locale, { maximumFractionDigits: v < 10 ? 4 : 2, minimumFractionDigits: v < 10 ? 3 : 2 });
    const layer = {
      _req: null,
      attached(p) { this._req = p.requestUpdate; },
      detached() { this._req = null; },
      updateAllViews() {},
      paneViews() { return [{ zOrder: () => 'top', renderer: () => ({ draw: target => target.useMediaCoordinateSpace(sc => paint(sc.context, sc.mediaSize)) }) }]; }
    };
    const xy = pt => {
      const l = logicalOf(pt.t), x = l == null ? null : chart.timeScale().logicalToCoordinate(l), y = candles.priceToCoordinate(pt.p);
      return x == null || y == null ? null : { x, y };
    };
    // The drawing being made: the points clicked so far, then the pointer.
    function pending() {
      if (!tool || !pts.length || !hover) return null;
      const n = POINTS[tool] || 2;
      if (n === 3 && pts.length === 1) return { type: 'trend', a: pts[0], b: hover, temp: true, seg: true, c: pen };
      return { type: tool, a: pts[0], b: pts[1] || hover, m: n === 3 ? hover : null, temp: true, c: pen };
    }
    function paint(ctx, size) {
      const list = drawings.filter(d => d.type !== 'hline');
      const tmp = pending();
      if (tmp && tmp.type !== 'hline') list.push(tmp);
      ctx.save();
      ctx.font = '11px ' + (getComputedStyle(el).fontFamily || 'sans-serif');
      const W = size.width, H = chart.panes()[0] ? chart.panes()[0].getHeight() : size.height;
      const seg = (A, B) => { ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke(); };
      // The line through A and B, run on to the right edge (and the left one, both).
      const run = (A, B, both) => {
        const dx = B.x - A.x, dy = B.y - A.y;
        if (Math.abs(dx) < 0.5) return seg({ x: A.x, y: 0 }, { x: A.x, y: H });
        const at = x => ({ x, y: A.y + dy * (x - A.x) / dx });
        const right = dx > 0 ? at(W) : at(0);
        seg(both ? (dx > 0 ? at(0) : at(W)) : A, right);
      };
      const dot = (P, col) => { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(P.x, P.y, 3.5, 0, 7); ctx.fill(); };
      const tag = (txt, x, y, col) => {
        const tw = ctx.measureText(txt).width + 10, tx = Math.min(Math.max(x, 2), W - tw - 2);
        ctx.fillStyle = k.bg; ctx.fillRect(tx, y - 13, tw, 17); ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.strokeRect(tx, y - 13, tw, 17);
        ctx.fillStyle = col; ctx.fillText(txt, tx + 5, y);
      };
      for (const d of list) {
        const A = xy(d.a), B = xy(d.b), M = d.m ? xy(d.m) : null;
        if (!A || !B) continue;
        ctx.globalAlpha = d.temp ? 0.7 : 1;
        const col = penOf(d);
        ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.setLineDash([]);
        if (d.type === 'trend') {
          // A trend line runs on to the right edge, as a ray.
          if (d.temp) seg(A, B); else run(A, B);
          [A, B].forEach(P => dot(P, col));
        } else if (d.type === 'ext') {
          run(A, B, true); [A, B].forEach(P => dot(P, col));
        } else if (d.type === 'hray') {
          seg(A, { x: W, y: A.y }); dot(A, col); tag(fmtP(d.a.p), W - 70, A.y - 4, col);
        } else if (d.type === 'vline') {
          seg({ x: A.x, y: 0 }, { x: A.x, y: H });
        } else if (d.type === 'arrow') {
          seg(A, B);
          const ang = Math.atan2(B.y - A.y, B.x - A.x), L = 12;
          ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(B.x, B.y);
          ctx.lineTo(B.x - L * Math.cos(ang - 0.4), B.y - L * Math.sin(ang - 0.4)); ctx.lineTo(B.x - L * Math.cos(ang + 0.4), B.y - L * Math.sin(ang + 0.4));
          ctx.closePath(); ctx.fill();
        } else if (d.type === 'text') {
          ctx.font = '600 13px ' + (getComputedStyle(el).fontFamily || 'sans-serif');
          tag(String(d.text || ''), A.x, A.y, col);
          ctx.font = '11px ' + (getComputedStyle(el).fontFamily || 'sans-serif');
        } else if (d.type === 'zone' || d.type === 'rect') {
          // A zone runs on to the right edge; a rectangle stays between its corners.
          const x = Math.min(A.x, B.x), y = Math.min(A.y, B.y), w = d.type === 'zone' && !d.temp ? Math.max(W - x, Math.abs(B.x - A.x)) : Math.abs(B.x - A.x), h = Math.abs(B.y - A.y);
          ctx.fillStyle = fade(col, 0.18); ctx.fillRect(x, y, w, h);
          ctx.lineWidth = 1.5; ctx.strokeRect(x, y, w, h);
        } else if (d.type === 'channel') {
          seg(A, B);
          if (M) {
            // The parallel line through the third point, and the middle one dashed.
            const off = M.y - (A.y + (B.y - A.y) * (Math.abs(B.x - A.x) < 0.5 ? 0 : (M.x - A.x) / (B.x - A.x)));
            const A2 = { x: A.x, y: A.y + off }, B2 = { x: B.x, y: B.y + off };
            ctx.fillStyle = fade(col, 0.12); ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.lineTo(B2.x, B2.y); ctx.lineTo(A2.x, A2.y); ctx.closePath(); ctx.fill();
            seg(A2, B2);
            ctx.lineWidth = 1; ctx.setLineDash([5, 4]); seg({ x: A.x, y: A.y + off / 2 }, { x: B.x, y: B.y + off / 2 }); ctx.setLineDash([]);
          }
          [A, B].forEach(P => dot(P, col));
        } else if (d.type === 'pitchfork') {
          // Andrews' pitchfork: the median line from the first point through the middle of the
          // other two, and its parallels through them, all run on to the right edge.
          dot(A, col); dot(B, col);
          if (M) {
            dot(M, col); seg(B, M);
            const mid = { x: (B.x + M.x) / 2, y: (B.y + M.y) / 2 };
            run(A, mid);
            const dx = mid.x - A.x, dy = mid.y - A.y;
            if (Math.abs(dx) > 0.5) [B, M].forEach(P => { ctx.lineWidth = 1.5; run(P, { x: P.x + dx, y: P.y + dy }); });
          } else seg(A, B);
        } else if (d.type === 'fib' || d.type === 'fibext') {
          // Retracement: levels between the two points. Extension: the first move's size, from
          // the third point.
          const ext = d.type === 'fibext';
          if (ext && !d.m) { seg(A, B); continue; }
          const from = ext ? d.m : d.b, x0 = Math.min(A.x, B.x, M ? M.x : Infinity);
          if (ext) { ctx.lineWidth = 1; ctx.setLineDash([4, 4]); seg(A, B); if (M) seg(B, M); ctx.setLineDash([]); }
          (ext ? FIBEXT : FIB).forEach(f => {
            const pr = ext ? from.p + (d.b.p - d.a.p) * f : d.b.p + (d.a.p - d.b.p) * f, y = candles.priceToCoordinate(pr);
            if (y == null) return;
            const key = f === 0.618 || f === 0.5 || f === 0 || f === 1 || f === 1.618;
            ctx.strokeStyle = key ? col : fade(col, 0.75); ctx.lineWidth = key ? 1.75 : 1.25; ctx.setLineDash(f === 0 || f === 1 ? [] : [5, 3]);
            ctx.beginPath(); ctx.moveTo(ext && M ? M.x : x0, y); ctx.lineTo(W, y); ctx.stroke();
            ctx.setLineDash([]); ctx.fillStyle = col; ctx.fillText((f * 100).toFixed(1) + '%  ' + fmtP(pr), (ext && M ? M.x : x0) + 4, y - 3);
          });
        } else if (d.type === 'measure') {
          const dp = d.b.p - d.a.p, pct = d.a.p ? dp / d.a.p * 100 : 0;
          const nb = Math.round(Math.abs((logicalOf(d.b.t) || 0) - (logicalOf(d.a.t) || 0)));
          const mc = dp >= 0 ? k.green : k.red;
          ctx.fillStyle = fade(mc, 0.16);
          ctx.fillRect(Math.min(A.x, B.x), Math.min(A.y, B.y), Math.abs(B.x - A.x), Math.abs(B.y - A.y));
          const txt = (dp >= 0 ? '+' : '−') + fmtP(Math.abs(dp)) + '  (' + (pct >= 0 ? '+' : '−') + Math.abs(pct).toFixed(2) + '%)  ·  ' + nb + ' bars';
          const tw = ctx.measureText(txt).width + 12, tx = Math.min(Math.max(B.x - tw / 2, 4), W - tw - 4), ty = B.y + (dp >= 0 ? -26 : 8);
          ctx.fillStyle = k.bg; ctx.fillRect(tx, ty, tw, 18); ctx.strokeStyle = k.rule; ctx.strokeRect(tx, ty, tw, 18);
          ctx.fillStyle = mc; ctx.fillText(txt, tx + 6, ty + 13);
        }
      }
      ctx.restore();
    }
    // Under the price: Ichimoku's lines and cloud, and the volume profile of the bars on view.
    const under = {
      _req: null,
      attached(p) { this._req = p.requestUpdate; },
      detached() { this._req = null; },
      updateAllViews() {},
      paneViews() { return [{ zOrder: () => 'bottom', renderer: () => ({ draw: target => target.useMediaCoordinateSpace(sc => paintUnder(sc.context, sc.mediaSize)) }) }]; }
    };
    function paintUnder(ctx, size) {
      if (!bars.length || (!avgOn.ichimoku && !avgOn.vprofile)) return;
      const ts = chart.timeScale(), yOf = p => candles.priceToCoordinate(p);
      ctx.save();
      if (avgOn.ichimoku) {
        const I = ichimokuOf(bars, 9, 26, 52), n = bars.length;
        const path = (vals, shift) => { const out = []; vals.forEach((v, i) => { if (v == null) return; const x = ts.logicalToCoordinate(i + shift), y = yOf(v); if (x != null && y != null) out.push({ x, y, i }); }); return out; };
        const A = path(I.spanA, I.shift - 1), B = path(I.spanB, I.shift - 1);
        // The cloud: green where span A is above span B, red where below.
        const bByI = new Map(B.map(p => [p.i, p]));
        for (let j = 1; j < A.length; j++) {
          const a0 = A[j - 1], a1 = A[j], b0 = bByI.get(a0.i), b1 = bByI.get(a1.i);
          if (!b0 || !b1) continue;
          ctx.fillStyle = fade(I.spanA[a1.i] >= I.spanB[a1.i] ? k.green : k.red, 0.14);
          ctx.beginPath(); ctx.moveTo(a0.x, a0.y); ctx.lineTo(a1.x, a1.y); ctx.lineTo(b1.x, b1.y); ctx.lineTo(b0.x, b0.y); ctx.closePath(); ctx.fill();
        }
        const stroke = (P, col, w) => { if (P.length < 2) return; ctx.strokeStyle = col; ctx.lineWidth = w; ctx.beginPath(); P.forEach((p, j) => j ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.stroke(); };
        stroke(A, fade(k.green, 0.8), 1); stroke(B, fade(k.red, 0.8), 1);
        stroke(path(I.tenkan, 0), k.blue, 1.25); stroke(path(I.kijun, 0), k.red, 1.25);
        stroke(path(I.lagging, -(I.shift - 1)), fade(k.purple, 0.85), 1);
        void n;
      }
      if (avgOn.vprofile) {
        const r = ts.getVisibleLogicalRange();
        const vis = r ? bars.slice(Math.max(0, Math.floor(r.from)), Math.min(bars.length, Math.ceil(r.to) + 1)) : bars;
        const VP = volumeProfile(vis, 24);
        if (VP) {
          const max = Math.max(...VP.vol), Wmax = size.width * 0.22;
          VP.vol.forEach((v, i) => {
            const y0 = yOf(VP.lo + VP.h * (i + 1)), y1 = yOf(VP.lo + VP.h * i);
            if (y0 == null || y1 == null || !max) return;
            const w = Wmax * v / max;
            ctx.fillStyle = fade(i === VP.poc ? k.accent : k.blue, i === VP.poc ? 0.45 : 0.22);
            ctx.fillRect(size.width - w, Math.min(y0, y1) + 0.5, w, Math.max(1, Math.abs(y1 - y0) - 1));
          });
        }
      }
      ctx.restore();
    }
    function syncHLines() {
      for (const [id, line] of hLines) if (!drawings.some(d => d.id === id)) { candles.removePriceLine(line); hLines.delete(id); }
      drawings.filter(d => d.type === 'hline' && !hLines.has(d.id)).forEach(d => hLines.set(d.id,
        candles.createPriceLine({ price: d.a.p, color: penOf(d), lineWidth: 2, lineStyle: LWC.LineStyle.Solid, axisLabelVisible: true, title: '' })));
    }
    function syncAuto() {
      autoLines.forEach(l => candles.removePriceLine(l)); autoLines = [];
      if (!autoOn) return;
      autoLevels(bars, o.step >= 604800).forEach(x => autoLines.push(candles.createPriceLine({ price: x.p, color: x.label[0] === 'R' ? k.red : k.green,
        lineWidth: 2, lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: true, title: x.label + ' \u00d7' + x.touches })));
    }
    const redraw = () => { if (layer._req) layer._req(); if (under._req) under._req(); };
    const pointAt = param => {
      if (!param || !param.point) return null;
      const l = chart.timeScale().coordinateToLogical(param.point.x), p = candles.coordinateToPrice(param.point.y);
      const t = timeOf(l);
      return t == null || p == null ? null : { t, p: +p.toPrecision(8) };
    };
    const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const onClick = param => {
      if (!tool) return;

      const pt = pointAt(param);
      if (!pt) return;
      const saved = () => { if (o.onDraw) o.onDraw(drawings.filter(x => x.type !== 'measure')); };
      const n = POINTS[tool] || 2;
      if (n === 1) {
        const d = { id: newId(), type: tool, c: pen, a: pt, b: pt };
        if (tool === 'text') {
          // The note's words come from the page (o.askText); none, no note.
          const txt = String((o.askText && o.askText()) || '').replace(/\s+/g, ' ').trim().slice(0, 80);
          if (!txt) return;
          d.text = txt;
        }
        drawings.push(d); syncHLines(); redraw(); saved(); return;
      }
      pts.push(pt); hover = pt;
      if (pts.length < n) { redraw(); return; }
      const d = { id: newId(), type: tool, c: pen, a: pts[0], b: pts[1] };
      if (n === 3) d.m = pts[2];
      pts = []; hover = null;
      // A measurement is shown until the next click, not kept.
      if (tool === 'measure') { measure = d; drawings = drawings.filter(x => x.type !== 'measure').concat([d]); redraw(); return; }
      drawings.push(d); redraw(); saved();
    };
    // Clicks are read from the page rather than the library, which swallows a second click
    // that comes quickly (both ends of a line). A press that moved isn't a click (a pan).
    let down = null;
    const local = ev => { const r = el.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
    const onDown = ev => { down = local(ev); };
    const onUp = ev => {
      const p = local(ev), d = down;
      down = null;
      if (!tool || !d || Math.hypot(p.x - d.x, p.y - d.y) > 6) return;
      // Only on the price chart itself: not an axis, not an indicator's pane.
      if (p.x < 0 || p.x > chart.timeScale().width() || p.y < 0 || p.y > chart.panes()[0].getHeight()) return;
      onClick({ point: p });
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    let measure = null;
    chart.subscribeCrosshairMove(p => { if (pts.length && tool) { const pt = pointAt(p); if (pt) { hover = pt; redraw(); } } });
    candles.attachPrimitive(layer);
    candles.attachPrimitive(under);

    const toBar = b => ({ time: b.t + offsetAt(o.tz, b.t), open: b.o, high: b.h, low: b.l, close: b.c, value: b.v, volume: b.v, raw: b });
    const volOf = b => ({ time: b.time, value: b.value || 0, color: fade(b.close >= b.open ? k.ink : k.accent, 0.35) });
    const points = vals => vals.map((v, i) => v == null ? null : { time: bars[i].time, value: v }).filter(Boolean);
    function drawAverages() {
      const close = bars.map(b => b.close);
      AVERAGES.forEach(([id, , c]) => {
        if (avgOn[id] && !avgSeries[id]) avgSeries[id] = chart.addSeries(LWC.LineSeries, { color: k[c], lineWidth: id === 'sma200' || id === 'sma100' ? 2 : 1.5,
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
        if (!avgOn[id] && avgSeries[id]) { chart.removeSeries(avgSeries[id]); avgSeries[id] = null; }
        if (avgSeries[id]) { const n = +id.replace(/\D/g, ''); avgSeries[id].setData(points(id[0] === 's' ? smaOf(close, n) : emaOf(close, n))); }
      });
    }
    // Indicator panes: rebuilt when the set changes; their data is recomputed on each refresh.
    let indKey = '';
    function drawIndicators() {
      const on = INDICATORS.map(x => x[0]).filter(id => indOn[id]), key = on.join(',');
      if (key !== indKey) {
        indSeries.forEach(x => chart.removeSeries(x.s)); indSeries = [];
        for (let i = chart.panes().length - 1; i > 0; i--) chart.removePane(i);
        on.forEach((id, i) => {
          const pane = i + 1, line = (color, title, extra) => chart.addSeries(LWC.LineSeries, Object.assign({ color, lineWidth: 1.5, title,
            priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false }, extra || {}), pane);
          if (id === 'macd') {
            indSeries.push({ id, part: 'hist', s: chart.addSeries(LWC.HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, pane) });
            indSeries.push({ id, part: 'line', s: line(k.blue, 'MACD 12 26') });
            indSeries.push({ id, part: 'signal', s: line(k.orange, '9') });
          } else if (id === 'rsi') {
            const s = line(k.purple, 'RSI 14', { autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) });
            [70, 30].forEach(v => s.createPriceLine({ price: v, color: fade(k.mute, 0.8), lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: false }));
            s.createPriceLine({ price: 50, color: fade(k.rule, 0.9), lineWidth: 1, lineStyle: LWC.LineStyle.Dotted, axisLabelVisible: false });
            indSeries.push({ id, part: 'rsi', s });
          } else if (id === 'dmi') {
            indSeries.push({ id, part: 'plus', s: line(k.green, '+DI') });
            indSeries.push({ id, part: 'minus', s: line(k.red, '\u2212DI') });
            indSeries.push({ id, part: 'adx', s: line(k.ink, 'ADX 14', { lineWidth: 2 }) });
          } else if (id === 'stoch' || id === 'willr' || id === 'cci') {
            // Oscillators with fixed bands: Stochastic 80/20, %R -20/-80, CCI +100/-100.
            const band = { stoch: [80, 20, 0, 100], willr: [-20, -80, -100, 0], cci: [100, -100] }[id];
            const s = line(id === 'stoch' ? k.blue : id === 'willr' ? k.teal : k.orange, id === 'stoch' ? '%K 14 3' : id === 'willr' ? '%R 14' : 'CCI 20',
              band.length > 2 ? { autoscaleInfoProvider: () => ({ priceRange: { minValue: band[2], maxValue: band[3] } }) } : {});
            band.slice(0, 2).forEach(v => s.createPriceLine({ price: v, color: fade(k.mute, 0.8), lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: false }));
            indSeries.push({ id, part: id, s });
            if (id === 'stoch') indSeries.push({ id, part: 'stochd', s: line(k.orange, '%D 3') });
          } else if (id === 'atr') {
            indSeries.push({ id, part: 'atr', s: line(k.pink, 'ATR 14') });
          } else if (id === 'obv') {
            indSeries.push({ id, part: 'obv', s: line(k.purple, 'OBV', { priceFormat: { type: 'volume' } }) });
          }
        });
        indKey = key;
        // The price chart keeps most of the height; each indicator gets an equal strip.
        const panes = chart.panes();
        panes.forEach((p, i) => p.setStretchFactor(i ? 1 : 3.4));
      }
      if (!indSeries.length || !bars.length) return;
      const close = bars.map(b => b.close);
      const m = indOn.macd ? macdOf(close, 12, 26, 9) : null, r = indOn.rsi ? rsiOf(close, 14) : null, d = indOn.dmi ? dmiOf(bars, 14) : null;
      const st = indOn.stoch ? stochOf(bars, 14, 3, 3) : null;
      const more = { stoch: st && st.k, stochd: st && st.d, willr: indOn.willr ? willrOf(bars, 14) : null, cci: indOn.cci ? cciOf(bars, 20) : null,
        atr: indOn.atr ? atrOf(bars, 14) : null, obv: indOn.obv ? obvOf(bars) : null };
      indSeries.forEach(x => {
        if (x.part === 'hist') x.s.setData(m.hist.map((v, i) => v == null ? null : { time: bars[i].time, value: v,
          color: fade(v >= 0 ? k.green : k.red, (i && m.hist[i - 1] != null && Math.abs(v) < Math.abs(m.hist[i - 1])) ? 0.4 : 0.8) }).filter(Boolean));
        else if (x.part === 'line') x.s.setData(points(m.line));
        else if (x.part === 'signal') x.s.setData(points(m.signal));
        else if (x.part === 'rsi') x.s.setData(points(r));
        else if (x.part === 'plus') x.s.setData(points(d.plus));
        else if (x.part === 'minus') x.s.setData(points(d.minus));
        else if (x.part === 'adx') x.s.setData(points(d.adx));
        else if (more[x.part]) x.s.setData(points(more[x.part]));
      });
    }
    chart.subscribeCrosshairMove(p => {
      if (!o.onHover) return;
      const d = p && p.seriesData ? p.seriesData.get(candles) : null;
      const b = d ? bars.find(x => x.time === d.time) : null;
      o.onHover(b ? b.raw : null);
    });

    let cmpBars = null;
    function drawCompare() {
      if (!cmpBars || !cmpBars.length) { if (cmp) { chart.removeSeries(cmp); cmp = null; } scaleMode(); return; }
      if (!cmp) cmp = chart.addSeries(LWC.LineSeries, { color: k.orange, lineWidth: 2, priceLineVisible: false, crosshairMarkerVisible: false });
      cmp.applyOptions({ title: cmpLabel });
      // On this chart's bars only, so the two lines start at the same one: by time within a day,
      // by date for daily bars and longer (two exchanges open at different hours).
      const key = b => o.intraday ? b.time : new Date(b.time * 1000).toISOString().slice(0, 10);
      const other = new Map(cmpBars.map(b => [key(b), b.close]));
      cmp.setData(bars.filter(b => other.has(key(b))).map(b => ({ time: b.time, value: other.get(key(b)) })));
      scaleMode();
    }
    const api = {
      setBars(list) {
        bars = (list || []).map(toBar);
        drawMain(); volume.setData(bars.map(volOf)); drawAverages(); drawOverlays(); drawIndicators(); syncAuto(); drawCompare();
        api.reset();
      },
      mergeBars(list) {
        if (!bars.length) return api.setBars(list);
        const last = bars[bars.length - 1].time, n0 = bars.length;
        (list || []).map(toBar).filter(b => b.time >= last).forEach(b => {
          if (b.time === bars[bars.length - 1].time) bars[bars.length - 1] = b; else bars.push(b);
          volume.update(volOf(b));
        });
        drawMain();
        // A new bar can make a new swing: the automatic levels are found again.
        if (bars.length !== n0) syncAuto();
        drawAverages(); drawOverlays(); drawIndicators(); redraw();
      },
      zoom(f) {
        const ts = chart.timeScale(), r = ts.getVisibleLogicalRange();
        if (!r) return;
        const width = Math.max(10, (r.to - r.from) * f);
        ts.setVisibleLogicalRange({ from: r.to - width, to: r.to });
      },
      reset() {
        const n = bars.length;
        if (!n) return;
        chart.timeScale().setVisibleLogicalRange({ from: Math.max(-1, n - 150), to: n + 5 });
      },
      setAverages(on) { avgOn = Object.assign({}, on || {}); drawAverages(); drawOverlays(); },
      // 'candles' | 'bars' | 'line' | 'area' | 'heikin'
      setType(t) { type = TYPES.indexOf(t) >= 0 ? t : 'candles'; if (bars.length) drawMain(); },
      setLog(on) { logScale = !!on; scaleMode(); },
      // Another share over this one, both in % from the left of the chart; null takes it off.
      setCompare(label, list) { cmpLabel = label || ''; cmpBars = list ? list.map(toBar) : null; drawCompare(); },
      setIndicators(on) { indOn = Object.assign({}, on || {}); drawIndicators(); },
      setPen(name) { if (k[name]) pen = name; redraw(); },
      setTool(name) { tool = name || null; pts = []; hover = null; drawings = drawings.filter(x => x.type !== 'measure'); redraw();
        chart.applyOptions({ handleScroll: !tool, handleScale: !tool }); },
      cancel() { pts = []; hover = null; redraw(); },
      setDrawings(list) { drawings = (list || []).filter(d => d && d.a && d.b && POINTS[d.type] && d.type !== 'measure' && (POINTS[d.type] < 3 || d.m)); syncHLines(); redraw(); },
      recolor(id, c) { const d = drawings.find(x => x.id === id); if (!d || !k[c]) return; d.c = c;
        if (hLines.has(id)) hLines.get(id).applyOptions({ color: penOf(d) }); redraw(); if (o.onDraw) o.onDraw(drawings.filter(x => x.type !== 'measure')); },
      removeDrawing(id) { drawings = drawings.filter(d => d.id !== id); syncHLines(); redraw(); if (o.onDraw) o.onDraw(drawings.filter(x => x.type !== 'measure')); },
      clearDrawings() { drawings = []; syncHLines(); redraw(); if (o.onDraw) o.onDraw([]); },
      setAutoLevels(on) { autoOn = !!on; syncAuto(); },
      autoLevels() { return autoLevels(bars, o.step >= 604800); },
      setTheme() {
        k = colors();
        chart.applyOptions({ layout: { textColor: k.mute }, grid: { vertLines: { color: fade(k.rule, 0.35) }, horzLines: { color: fade(k.rule, 0.35) } },
          rightPriceScale: { borderColor: k.rule }, timeScale: { borderColor: k.rule } });
        candles.applyOptions(candleColors());
        if (alt) { chart.removeSeries(alt.s); alt = null; }
        if (bars.length) drawMain();
        Object.keys(ovSeries).forEach(id => { chart.removeSeries(ovSeries[id]); delete ovSeries[id]; }); drawOverlays();
        if (cmp) cmp.applyOptions({ color: k.orange });
        volume.setData(bars.map(volOf));
        AVERAGES.forEach(([id, , c]) => avgSeries[id] && avgSeries[id].applyOptions({ color: k[c] }));
        for (const [id, l] of hLines) { const d = drawings.find(x => x.id === id); if (d) l.applyOptions({ color: penOf(d) }); }
        indKey = ''; drawIndicators();
        syncAuto(); redraw();
      },
      get element() { return el; },
      destroy() { el.removeEventListener('pointerdown', onDown); el.removeEventListener('pointerup', onUp); try { chart.remove(); } catch (e) {} }
    };
    return api;
  }

  window.HIFLiveChart = { create, loadLib, autoLevels, AVERAGES, OVERLAYS, INDICATORS, TYPES, POINTS, PENS, PEN_OF, smaOf, emaOf, rsiOf, macdOf, dmiOf,
    bollingerOf, stochOf, atrOf, obvOf, cciOf, willrOf, vwapOf, ichimokuOf, heikinAshi, volumeProfile };
})();
