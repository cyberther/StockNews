// The live chart page's chart: candles, volume and optional moving averages, drawn by
// TradingView Lightweight Charts (vendor/lightweight-charts.standalone.production.js, loaded
// the first time the page opens). The app owns the data and the refresh; this only draws.
//
//   const c = await HIFLiveChart.create(el, { tz: 'America/New_York', locale: 'ro-RO', intraday: true, onHover })
//   c.setBars([{ t, o, h, l, c, v }, ...])   all bars (a new symbol or bar size)
//   c.mergeBars([...])                       the latest bars (a refresh): updates the last, adds new ones
//   c.zoom(0.7) / c.zoom(1.4) / c.reset()    narrower / wider / the last ~150 bars
//   c.setAverages({ 20: true, 50: false })  c.setTheme()   c.destroy()
// Drawing (support and resistance, trends): c.setTool('hline' | 'trend' | 'zone' | 'fib' |
// 'measure' | null), c.setDrawings(list), c.removeDrawing(id), c.clearDrawings(),
// c.setAutoLevels(true); onDraw(list) is called when the user adds one. A drawing keeps
// real times and prices ({ id, type, a: { t, p }, b: { t, p } }), so it stays in place
// when the bar size changes.
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
  function sma(bars, n) {
    const out = []; let sum = 0;
    bars.forEach((b, i) => { sum += b.close; if (i >= n) sum -= bars[i - n].close; if (i >= n - 1) out.push({ time: b.time, value: sum / n }); });
    return out;
  }

  // Support and resistance from the bars: swing highs and lows (a bar higher or lower than
  // the 5 on each side), grouped when within half an average bar range, ranked by how many
  // times price turned there; the closest 3 above and 3 below the last close.
  function autoLevels(bars) {
    const n = bars.length, w = 5;
    if (n < 2 * w + 5) return [];
    const range = bars.slice(-200).reduce((a, b) => a + (b.high - b.low), 0) / Math.min(n, 200) || 0;
    const tol = Math.max(range * 0.5, bars[n - 1].close * 0.002);
    const pts = [];
    for (let i = w; i < n - w; i++) {
      let hi = true, lo = true;
      for (let j = i - w; j <= i + w; j++) {
        if (j === i) continue;
        if (bars[j].high > bars[i].high) hi = false;
        if (bars[j].low < bars[i].low) lo = false;
      }
      if (hi) pts.push(bars[i].high);
      if (lo) pts.push(bars[i].low);
    }
    const groups = [];
    pts.sort((a, b) => a - b).forEach(p => {
      const g = groups[groups.length - 1];
      if (g && p - g.max <= tol) { g.sum += p; g.n++; g.max = p; } else groups.push({ sum: p, n: 1, max: p });
    });
    const last = bars[n - 1].close;
    const lv = groups.map(g => ({ p: g.sum / g.n, touches: g.n }));
    const above = lv.filter(x => x.p > last).sort((a, b) => a.p - b.p).slice(0, 3).map((x, i) => Object.assign(x, { label: 'R' + (i + 1) }));
    const below = lv.filter(x => x.p <= last).sort((a, b) => b.p - a.p).slice(0, 3).map((x, i) => Object.assign(x, { label: 'S' + (i + 1) }));
    return above.concat(below);
  }
  const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

  async function create(el, opts) {
    const LWC = await loadLib();
    const o = Object.assign({ tz: '', locale: undefined, intraday: true, seconds: false, onHover: null, onDraw: null, step: 60 }, opts || {});
    const colors = () => ({ bg: css(el, '--s-bg', '#121212'), ink: css(el, '--s-ink', '#F5F5F7'), mute: css(el, '--s-mute', '#A0A0A0'),
      rule: css(el, '--s-rule', '#333333'), accent: css(el, '--color-accent', '#D4AF37') });
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
    const avgSeries = { 20: null, 50: null };
    let avgOn = { 20: false, 50: false }, bars = [];

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
        if (d.type === 'trend') {
          ctx.strokeStyle = k.accent; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(A.x, A.y);
          // A trend line runs on to the right edge, as a ray.
          const dx = B.x - A.x, dy = B.y - A.y, far = dx > 0 ? (size.width - A.x) / dx : 1;
          ctx.lineTo(dx > 0 && !d.temp ? A.x + dx * far : B.x, dx > 0 && !d.temp ? A.y + dy * far : B.y); ctx.stroke();
          [A, B].forEach(P => { ctx.fillStyle = k.accent; ctx.beginPath(); ctx.arc(P.x, P.y, 3, 0, 7); ctx.fill(); });
        } else if (d.type === 'zone') {
          const x = Math.min(A.x, B.x), y = Math.min(A.y, B.y), w = Math.max(size.width - x, Math.abs(B.x - A.x)), h = Math.abs(B.y - A.y);
          ctx.fillStyle = fade(k.accent, 0.14); ctx.fillRect(x, y, d.temp ? Math.abs(B.x - A.x) : w, h);
          ctx.strokeStyle = fade(k.accent, 0.7); ctx.lineWidth = 1; ctx.strokeRect(x, y, d.temp ? Math.abs(B.x - A.x) : w, h);
        } else if (d.type === 'fib') {
          const x0 = Math.min(A.x, B.x);
          FIB.forEach(f => {
            const p = d.b.p + (d.a.p - d.b.p) * f, y = candles.priceToCoordinate(p);
            if (y == null) return;
            ctx.strokeStyle = f === 0.618 || f === 0.5 ? k.accent : fade(k.mute, 0.9); ctx.lineWidth = 1; ctx.setLineDash(f === 0 || f === 1 ? [] : [4, 3]);
            ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(size.width, y); ctx.stroke();
            ctx.setLineDash([]); ctx.fillStyle = k.mute; ctx.fillText((f * 100).toFixed(1) + '%  ' + fmtP(p), x0 + 4, y - 3);
          });
        } else if (d.type === 'measure') {
          const dp = d.b.p - d.a.p, pct = d.a.p ? dp / d.a.p * 100 : 0;
          const nb = Math.round(Math.abs((logicalOf(d.b.t) || 0) - (logicalOf(d.a.t) || 0)));
          ctx.fillStyle = fade(dp >= 0 ? k.ink : k.accent, 0.12);
          ctx.fillRect(Math.min(A.x, B.x), Math.min(A.y, B.y), Math.abs(B.x - A.x), Math.abs(B.y - A.y));
          const txt = (dp >= 0 ? '+' : '\u2212') + fmtP(Math.abs(dp)) + '  (' + (pct >= 0 ? '+' : '\u2212') + Math.abs(pct).toFixed(2) + '%)  \u00b7  ' + nb + ' bars';
          const tw = ctx.measureText(txt).width + 12, tx = Math.min(Math.max(B.x - tw / 2, 4), size.width - tw - 4), ty = B.y + (dp >= 0 ? -26 : 8);
          ctx.fillStyle = k.bg; ctx.fillRect(tx, ty, tw, 18); ctx.strokeStyle = k.rule; ctx.strokeRect(tx, ty, tw, 18);
          ctx.fillStyle = dp >= 0 ? k.ink : k.accent; ctx.fillText(txt, tx + 6, ty + 13);
        }
      }
      ctx.restore();
    }
    function syncHLines() {
      for (const [id, line] of hLines) if (!drawings.some(d => d.id === id)) { candles.removePriceLine(line); hLines.delete(id); }
      drawings.filter(d => d.type === 'hline' && !hLines.has(d.id)).forEach(d => hLines.set(d.id,
        candles.createPriceLine({ price: d.a.p, color: k.accent, lineWidth: 1, lineStyle: LWC.LineStyle.Solid, axisLabelVisible: true, title: '' })));
    }
    function syncAuto() {
      autoLines.forEach(l => candles.removePriceLine(l)); autoLines = [];
      if (!autoOn) return;
      autoLevels(bars).forEach(x => autoLines.push(candles.createPriceLine({ price: x.p, color: x.label[0] === 'R' ? k.accent : k.ink,
        lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: true, title: x.label + ' \u00d7' + x.touches })));
    }
    const redraw = () => { if (layer._req) layer._req(); };
    const pointAt = param => {
      if (!param || !param.point) return null;
      const l = chart.timeScale().coordinateToLogical(param.point.x), p = candles.coordinateToPrice(param.point.y);
      const t = timeOf(l);
      return t == null || p == null ? null : { t, p: +p.toPrecision(8) };
    };
    const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    chart.subscribeClick(param => {
      if (!tool) return;
      const pt = pointAt(param);
      if (!pt) return;
      if (tool === 'hline') { drawings.push({ id: newId(), type: 'hline', a: pt, b: pt }); syncHLines(); if (o.onDraw) o.onDraw(drawings.slice()); return; }
      if (!first) { first = pt; hover = pt; redraw(); return; }
      const d = { id: newId(), type: tool, a: first, b: pt };
      first = null; hover = null;
      // A measurement is shown until the next click, not kept.
      if (tool === 'measure') { measure = d; drawings = drawings.filter(x => x.type !== 'measure').concat([d]); redraw(); return; }
      drawings.push(d); redraw();
      if (o.onDraw) o.onDraw(drawings.filter(x => x.type !== 'measure'));
    });
    let measure = null;
    chart.subscribeCrosshairMove(p => { if (first && tool) { const pt = pointAt(p); if (pt) { hover = pt; redraw(); } } });
    candles.attachPrimitive(layer);

    const toBar = b => ({ time: b.t + offsetAt(o.tz, b.t), open: b.o, high: b.h, low: b.l, close: b.c, value: b.v, raw: b });
    const volOf = b => ({ time: b.time, value: b.value || 0, color: fade(b.close >= b.open ? k.ink : k.accent, 0.35) });
    function drawAverages() {
      [20, 50].forEach(n => {
        if (avgOn[n] && !avgSeries[n]) avgSeries[n] = chart.addSeries(LWC.LineSeries, { color: n === 20 ? k.accent : k.mute, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
        if (!avgOn[n] && avgSeries[n]) { chart.removeSeries(avgSeries[n]); avgSeries[n] = null; }
        if (avgSeries[n]) avgSeries[n].setData(sma(bars, n));
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
        candles.setData(bars); volume.setData(bars.map(volOf)); drawAverages(); syncAuto();
        api.reset();
      },
      mergeBars(list) {
        if (!bars.length) return api.setBars(list);
        const last = bars[bars.length - 1].time;
        (list || []).map(toBar).filter(b => b.time >= last).forEach(b => {
          if (b.time === bars[bars.length - 1].time) bars[bars.length - 1] = b; else bars.push(b);
          candles.update(b); volume.update(volOf(b));
        });
        drawAverages(); redraw();
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
      setAverages(on) { avgOn = Object.assign({ 20: false, 50: false }, on || {}); drawAverages(); },
      setTool(name) { tool = name || null; first = null; hover = null; drawings = drawings.filter(x => x.type !== 'measure'); redraw();
        chart.applyOptions({ handleScroll: !tool, handleScale: !tool }); },
      cancel() { first = null; hover = null; redraw(); },
      setDrawings(list) { drawings = (list || []).filter(d => d && d.a && d.b && ['hline', 'trend', 'zone', 'fib'].includes(d.type)); syncHLines(); redraw(); },
      removeDrawing(id) { drawings = drawings.filter(d => d.id !== id); syncHLines(); redraw(); if (o.onDraw) o.onDraw(drawings.filter(x => x.type !== 'measure')); },
      clearDrawings() { drawings = []; syncHLines(); redraw(); if (o.onDraw) o.onDraw([]); },
      setAutoLevels(on) { autoOn = !!on; syncAuto(); },
      autoLevels() { return autoLevels(bars); },
      setTheme() {
        k = colors();
        chart.applyOptions({ layout: { textColor: k.mute }, grid: { vertLines: { color: fade(k.rule, 0.35) }, horzLines: { color: fade(k.rule, 0.35) } },
          rightPriceScale: { borderColor: k.rule }, timeScale: { borderColor: k.rule } });
        candles.applyOptions({ upColor: k.ink, downColor: k.accent, borderUpColor: k.ink, borderDownColor: k.accent, wickUpColor: k.ink, wickDownColor: k.accent });
        volume.setData(bars.map(volOf));
        if (avgSeries[20]) avgSeries[20].applyOptions({ color: k.accent });
        if (avgSeries[50]) avgSeries[50].applyOptions({ color: k.mute });
        for (const l of hLines.values()) l.applyOptions({ color: k.accent });
        syncAuto(); redraw();
      },
      get element() { return el; },
      destroy() { try { chart.remove(); } catch (e) {} }
    };
    return api;
  }

  window.HIFLiveChart = { create, loadLib, autoLevels };
})();
