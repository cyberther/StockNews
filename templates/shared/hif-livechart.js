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
  const AVERAGES = [['sma20', 'SMA 20', 'blue'], ['sma50', 'SMA 50', 'orange'], ['sma100', 'SMA 100', 'purple'], ['sma200', 'SMA 200', 'pink'],
    ['ema9', 'EMA 9', 'teal'], ['ema21', 'EMA 21', 'yellow']];
  const INDICATORS = [['macd', 'MACD'], ['dmi', 'DMI'], ['rsi', 'RSI']];
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
    const o = Object.assign({ tz: '', locale: undefined, intraday: true, seconds: false, onHover: null, onDraw: null, step: 60 }, opts || {});
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
    let avgOn = {}, indOn = {}, indSeries = [], bars = [], pen = 'blue';

    // ---- drawings ----------------------------------------------------------------------
    let drawings = [], tool = null, first = null, hover = null, autoOn = false, autoLines = [];
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
    function paint(ctx, size) {
      const list = drawings.filter(d => d.type !== 'hline').concat(first && hover && tool && tool !== 'hline' ? [{ type: tool, a: first, b: hover, temp: true }] : []);
      ctx.save();
      ctx.font = '11px ' + (getComputedStyle(el).fontFamily || 'sans-serif');
      for (const d of list) {
        const A = xy(d.a), B = xy(d.b);
        if (!A || !B) continue;
        ctx.globalAlpha = d.temp ? 0.7 : 1;
        const col = penOf(d.temp ? { c: pen, type: d.type } : d);
        if (d.type === 'trend') {
          ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(A.x, A.y);
          // A trend line runs on to the right edge, as a ray.
          const dx = B.x - A.x, dy = B.y - A.y, far = dx > 0 ? (size.width - A.x) / dx : 1;
          ctx.lineTo(dx > 0 && !d.temp ? A.x + dx * far : B.x, dx > 0 && !d.temp ? A.y + dy * far : B.y); ctx.stroke();
          [A, B].forEach(P => { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(P.x, P.y, 3.5, 0, 7); ctx.fill(); });
        } else if (d.type === 'zone') {
          const x = Math.min(A.x, B.x), y = Math.min(A.y, B.y), w = Math.max(size.width - x, Math.abs(B.x - A.x)), h = Math.abs(B.y - A.y);
          ctx.fillStyle = fade(col, 0.18); ctx.fillRect(x, y, d.temp ? Math.abs(B.x - A.x) : w, h);
          ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.strokeRect(x, y, d.temp ? Math.abs(B.x - A.x) : w, h);
        } else if (d.type === 'fib') {
          const x0 = Math.min(A.x, B.x);
          FIB.forEach(f => {
            const p = d.b.p + (d.a.p - d.b.p) * f, y = candles.priceToCoordinate(p);
            if (y == null) return;
            const key = f === 0.618 || f === 0.5 || f === 0 || f === 1;
            ctx.strokeStyle = key ? col : fade(col, 0.75); ctx.lineWidth = key ? 1.75 : 1.25; ctx.setLineDash(f === 0 || f === 1 ? [] : [5, 3]);
            ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(size.width, y); ctx.stroke();
            ctx.setLineDash([]); ctx.fillStyle = col; ctx.fillText((f * 100).toFixed(1) + '%  ' + fmtP(p), x0 + 4, y - 3);
          });
        } else if (d.type === 'measure') {
          const dp = d.b.p - d.a.p, pct = d.a.p ? dp / d.a.p * 100 : 0;
          const nb = Math.round(Math.abs((logicalOf(d.b.t) || 0) - (logicalOf(d.a.t) || 0)));
          const mc = dp >= 0 ? k.green : k.red;
          ctx.fillStyle = fade(mc, 0.16);
          ctx.fillRect(Math.min(A.x, B.x), Math.min(A.y, B.y), Math.abs(B.x - A.x), Math.abs(B.y - A.y));
          const txt = (dp >= 0 ? '+' : '\u2212') + fmtP(Math.abs(dp)) + '  (' + (pct >= 0 ? '+' : '\u2212') + Math.abs(pct).toFixed(2) + '%)  \u00b7  ' + nb + ' bars';
          const tw = ctx.measureText(txt).width + 12, tx = Math.min(Math.max(B.x - tw / 2, 4), size.width - tw - 4), ty = B.y + (dp >= 0 ? -26 : 8);
          ctx.fillStyle = k.bg; ctx.fillRect(tx, ty, tw, 18); ctx.strokeStyle = k.rule; ctx.strokeRect(tx, ty, tw, 18);
          ctx.fillStyle = mc; ctx.fillText(txt, tx + 6, ty + 13);
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
    const redraw = () => { if (layer._req) layer._req(); };
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
      if (tool === 'hline') { drawings.push({ id: newId(), type: 'hline', c: pen, a: pt, b: pt }); syncHLines(); if (o.onDraw) o.onDraw(drawings.slice()); return; }
      if (!first) { first = pt; hover = pt; redraw(); return; }
      const d = { id: newId(), type: tool, c: pen, a: first, b: pt };
      first = null; hover = null;
      // A measurement is shown until the next click, not kept.
      if (tool === 'measure') { measure = d; drawings = drawings.filter(x => x.type !== 'measure').concat([d]); redraw(); return; }
      drawings.push(d); redraw();
      if (o.onDraw) o.onDraw(drawings.filter(x => x.type !== 'measure'));
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
    chart.subscribeCrosshairMove(p => { if (first && tool) { const pt = pointAt(p); if (pt) { hover = pt; redraw(); } } });
    candles.attachPrimitive(layer);

    const toBar = b => ({ time: b.t + offsetAt(o.tz, b.t), open: b.o, high: b.h, low: b.l, close: b.c, value: b.v, raw: b });
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
      indSeries.forEach(x => {
        if (x.part === 'hist') x.s.setData(m.hist.map((v, i) => v == null ? null : { time: bars[i].time, value: v,
          color: fade(v >= 0 ? k.green : k.red, (i && m.hist[i - 1] != null && Math.abs(v) < Math.abs(m.hist[i - 1])) ? 0.4 : 0.8) }).filter(Boolean));
        else if (x.part === 'line') x.s.setData(points(m.line));
        else if (x.part === 'signal') x.s.setData(points(m.signal));
        else if (x.part === 'rsi') x.s.setData(points(r));
        else if (x.part === 'plus') x.s.setData(points(d.plus));
        else if (x.part === 'minus') x.s.setData(points(d.minus));
        else if (x.part === 'adx') x.s.setData(points(d.adx));
      });
    }
    chart.subscribeCrosshairMove(p => {
      if (!o.onHover) return;
      const d = p && p.seriesData ? p.seriesData.get(candles) : null;
      const b = d ? bars.find(x => x.time === d.time) : null;
      o.onHover(b ? b.raw : null);
    });

    const api = {
      setBars(list) {
        bars = (list || []).map(toBar);
        candles.setData(bars); volume.setData(bars.map(volOf)); drawAverages(); drawIndicators(); syncAuto();
        api.reset();
      },
      mergeBars(list) {
        if (!bars.length) return api.setBars(list);
        const last = bars[bars.length - 1].time, n0 = bars.length;
        (list || []).map(toBar).filter(b => b.time >= last).forEach(b => {
          if (b.time === bars[bars.length - 1].time) bars[bars.length - 1] = b; else bars.push(b);
          candles.update(b); volume.update(volOf(b));
        });
        // A new bar can make a new swing: the automatic levels are found again.
        if (bars.length !== n0) syncAuto();
        drawAverages(); drawIndicators(); redraw();
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
      setAverages(on) { avgOn = Object.assign({}, on || {}); drawAverages(); },
      setIndicators(on) { indOn = Object.assign({}, on || {}); drawIndicators(); },
      setPen(name) { if (k[name]) pen = name; redraw(); },
      setTool(name) { tool = name || null; first = null; hover = null; drawings = drawings.filter(x => x.type !== 'measure'); redraw();
        chart.applyOptions({ handleScroll: !tool, handleScale: !tool }); },
      cancel() { first = null; hover = null; redraw(); },
      setDrawings(list) { drawings = (list || []).filter(d => d && d.a && d.b && ['hline', 'trend', 'zone', 'fib'].includes(d.type)); syncHLines(); redraw(); },
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
        candles.applyOptions({ upColor: k.ink, downColor: k.accent, borderUpColor: k.ink, borderDownColor: k.accent, wickUpColor: k.ink, wickDownColor: k.accent });
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

  window.HIFLiveChart = { create, loadLib, autoLevels, AVERAGES, INDICATORS, PENS, PEN_OF, smaOf, emaOf, rsiOf, macdOf, dmiOf };
})();
