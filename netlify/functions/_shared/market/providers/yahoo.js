// Yahoo's public chart endpoint: price history for every listing, and quotes and company
// names for markets the other providers don't cover (Bucharest .RO, XETRA .DE, London .L).
// Charts keep Yahoo's shape, which hif-live.js reads; quotes and profiles are converted to
// Finnhub's shapes.
const RANGES = { '1d': '5m', '5d': '15m', '1mo': '60m', '6mo': '1d', ytd: '1d', '1y': '1d', '5y': '1wk' };
// With warm=1 the same bar size covers a longer range, so moving averages and RSI have
// history before the first visible bar.
const WARM = { '1d': '5d', '5d': '1mo', '1mo': '3mo', '6mo': '1y', ytd: '2y', '1y': '2y', '5y': '10y' };

export const CHART_RANGES = Object.keys(RANGES);
// Candles for the live chart page: bar size -> how far back Yahoo serves it (1m: 7 days,
// minute bars up to 60 days, hourly up to two years).
export const CANDLE_RANGE = { '1m': '5d', '2m': '1mo', '5m': '1mo', '15m': '1mo', '30m': '1mo', '60m': '6mo', '1d': '5y', '1wk': '10y', '1mo': 'max' };
export const CANDLE_INTERVALS = Object.keys(CANDLE_RANGE);
// Yahoo's chart -> { t, o, h, l, c, v } arrays (bars without a price dropped), plus what the
// page labels: currency, the exchange's time zone and how many minutes the data is delayed.
export function compactCandles(data) {
  const r = data && data.chart && data.chart.result && data.chart.result[0];
  if (!r) return { t: [], o: [], h: [], l: [], c: [], v: [] };
  const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {}, ts = r.timestamp || [];
  const out = { t: [], o: [], h: [], l: [], c: [], v: [] };
  ts.forEach((t, i) => {
    const o = num((q.open || [])[i]), h = num((q.high || [])[i]), l = num((q.low || [])[i]), c = num((q.close || [])[i]);
    if (o == null || h == null || l == null || c == null) return;
    out.t.push(t); out.o.push(o); out.h.push(h); out.l.push(l); out.c.push(c); out.v.push(num((q.volume || [])[i]) || 0);
  });
  const m = r.meta || {};
  return Object.assign(out, { currency: m.currency || '', tz: m.exchangeTimezoneName || '', delay: num(m.exchangeDataDelayedBy) || 0,
    price: num(m.regularMarketPrice), prevClose: num(m.chartPreviousClose != null ? m.chartPreviousClose : m.previousClose),
    exchange: m.fullExchangeName || m.exchangeName || '', marketTime: num(m.regularMarketTime) });
}

const num = v => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
// London prices come in pence ("GBp"); the apps show pounds, like every other currency.
const PENCE = new Set(['GBp', 'GBX']);
function toPounds(data) {
  const r = data && data.chart && data.chart.result && data.chart.result[0];
  if (!r || !r.meta || !PENCE.has(r.meta.currency)) return data;
  const p = v => (typeof v === 'number' ? +(v / 100).toFixed(6) : v);
  const meta = Object.assign({}, r.meta, { currency: 'GBP' });
  ['regularMarketPrice', 'chartPreviousClose', 'previousClose', 'regularMarketDayHigh', 'regularMarketDayLow',
    'fiftyTwoWeekHigh', 'fiftyTwoWeekLow'].forEach(k => { if (k in meta) meta[k] = p(meta[k]); });
  const quote = ((r.indicators && r.indicators.quote) || []).map(q => Object.fromEntries(Object.entries(q)
    .map(([k, arr]) => [k, k === 'volume' || !Array.isArray(arr) ? arr : arr.map(p)])));
  const adj = ((r.indicators && r.indicators.adjclose) || []).map(a => ({ adjclose: (a.adjclose || []).map(p) }));
  const indicators = Object.assign({}, r.indicators, { quote }, adj.length ? { adjclose: adj } : {});
  return { chart: Object.assign({}, data.chart, { result: [Object.assign({}, r, { meta, indicators })].concat(data.chart.result.slice(1)) }) };
}
const metaOf = d => (d && d.chart && d.chart.result && d.chart.result[0] && d.chart.result[0].meta) || null;

export const yahoo = {
  name: 'yahoo',
  needsKey: false,
  limits: {},
  supports: cap => cap === 'chart' || cap === 'candles' || cap === 'quote' || cap === 'profile',
  url(cap, p) {
    const u = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(p.symbol)}`);
    if (cap === 'chart') {
      u.searchParams.set('range', p.warm ? WARM[p.range] : p.range);
      u.searchParams.set('interval', RANGES[p.range]);
    } else if (cap === 'candles') {
      // tail=1: just today's bars, for the page's refresh.
      u.searchParams.set('range', p.tail ? '1d' : CANDLE_RANGE[p.interval]);
      u.searchParams.set('interval', p.interval);
    } else {
      // One daily bar: its meta block carries today's price, the previous close and the name.
      u.searchParams.set('range', '1d');
      u.searchParams.set('interval', '1d');
    }
    u.searchParams.set('includePrePost', 'false');
    return u;
  },
  headers: { 'user-agent': 'Mozilla/5.0' },
  async transform(cap, raw, p) {
    const data = toPounds(raw);
    if (cap === 'chart') return data;
    if (cap === 'candles') return compactCandles(data);
    const m = metaOf(data) || {};
    if (cap === 'quote') {
      const c = num(m.regularMarketPrice), pc = num(m.chartPreviousClose != null ? m.chartPreviousClose : m.previousClose);
      return { c, d: c != null && pc != null ? +(c - pc).toFixed(6) : null, dp: c != null && pc ? +((c / pc - 1) * 100).toFixed(4) : null,
        h: num(m.regularMarketDayHigh), l: num(m.regularMarketDayLow), o: null, pc, t: num(m.regularMarketTime) };
    }
    const name = String(m.longName || m.shortName || '').replace(/\s+S\.?A\.?$/i, '').trim();
    return name ? { ticker: p.symbol, name, currency: m.currency || '', exchange: m.fullExchangeName || m.exchangeName || '' } : {};
  },
  empty: (cap, d) => cap === 'quote' ? !(d && d.c) : cap === 'profile' ? !(d && d.name) : false
};
