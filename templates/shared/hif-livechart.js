// The live chart page's chart: candles, volume and optional moving averages, drawn by
// TradingView Lightweight Charts (vendor/lightweight-charts.standalone.production.js, loaded
// the first time the page opens). The app owns the data and the refresh; this only draws.
//
//   const c = await HIFLiveChart.create(el, { tz: 'America/New_York', locale: 'ro-RO', intraday: true, onHover })
//   c.setBars([{ t, o, h, l, c, v }, ...])   all bars (a new symbol or bar size)
//   c.mergeBars([...])                       the latest bars (a refresh): updates the last, adds new ones
//   c.zoom(0.7) / c.zoom(1.4) / c.reset()    narrower / wider / the last ~150 bars
//   c.setAverages({ 20: true, 50: false })  c.setTheme()   c.destroy()
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

  async function create(el, opts) {
    const LWC = await loadLib();
    const o = Object.assign({ tz: '', locale: undefined, intraday: true, onHover: null }, opts || {});
    const colors = () => ({ bg: css(el, '--s-bg', '#121212'), ink: css(el, '--s-ink', '#F5F5F7'), mute: css(el, '--s-mute', '#A0A0A0'),
      rule: css(el, '--s-rule', '#333333'), accent: css(el, '--color-accent', '#D4AF37') });
    let k = colors();
    const chart = LWC.createChart(el, {
      autoSize: true,
      layout: { background: { type: 'solid', color: 'transparent' }, textColor: k.mute, fontFamily: getComputedStyle(el).fontFamily, attributionLogo: true },
      grid: { vertLines: { color: fade(k.rule, 0.35) }, horzLines: { color: fade(k.rule, 0.35) } },
      rightPriceScale: { borderColor: k.rule },
      timeScale: { borderColor: k.rule, timeVisible: o.intraday, secondsVisible: false, rightOffset: 6, minBarSpacing: 1 },
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
        candles.setData(bars); volume.setData(bars.map(volOf)); drawAverages();
        api.reset();
      },
      mergeBars(list) {
        if (!bars.length) return api.setBars(list);
        const last = bars[bars.length - 1].time;
        (list || []).map(toBar).filter(b => b.time >= last).forEach(b => {
          if (b.time === bars[bars.length - 1].time) bars[bars.length - 1] = b; else bars.push(b);
          candles.update(b); volume.update(volOf(b));
        });
        drawAverages();
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
      setTheme() {
        k = colors();
        chart.applyOptions({ layout: { textColor: k.mute }, grid: { vertLines: { color: fade(k.rule, 0.35) }, horzLines: { color: fade(k.rule, 0.35) } },
          rightPriceScale: { borderColor: k.rule }, timeScale: { borderColor: k.rule } });
        candles.applyOptions({ upColor: k.ink, downColor: k.accent, borderUpColor: k.ink, borderDownColor: k.accent, wickUpColor: k.ink, wickDownColor: k.accent });
        volume.setData(bars.map(volOf));
        if (avgSeries[20]) avgSeries[20].applyOptions({ color: k.accent });
        if (avgSeries[50]) avgSeries[50].applyOptions({ color: k.mute });
      },
      get element() { return el; },
      destroy() { try { chart.remove(); } catch (e) {} }
    };
    return api;
  }

  window.HIFLiveChart = { create, loadLib };
})();
