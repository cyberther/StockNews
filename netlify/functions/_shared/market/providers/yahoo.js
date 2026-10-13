// Yahoo's public chart endpoint: price history for every listing, and quotes and company
// names for markets the other providers don't cover (the Bucharest Stock Exchange, .RO).
// Charts keep Yahoo's shape, which hif-live.js reads; quotes and profiles are converted to
// Finnhub's shapes.
const RANGES = { '1d': '5m', '5d': '15m', '1mo': '60m', '6mo': '1d', ytd: '1d', '1y': '1d', '5y': '1wk' };
// With warm=1 the same bar size covers a longer range, so moving averages and RSI have
// history before the first visible bar.
const WARM = { '1d': '5d', '5d': '1mo', '1mo': '3mo', '6mo': '1y', ytd: '2y', '1y': '2y', '5y': '10y' };

export const CHART_RANGES = Object.keys(RANGES);

const num = v => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const metaOf = d => (d && d.chart && d.chart.result && d.chart.result[0] && d.chart.result[0].meta) || null;

export const yahoo = {
  name: 'yahoo',
  needsKey: false,
  limits: {},
  supports: cap => cap === 'chart' || cap === 'quote' || cap === 'profile',
  url(cap, p) {
    const u = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(p.symbol)}`);
    if (cap === 'chart') {
      u.searchParams.set('range', p.warm ? WARM[p.range] : p.range);
      u.searchParams.set('interval', RANGES[p.range]);
    } else {
      // One daily bar: its meta block carries today's price, the previous close and the name.
      u.searchParams.set('range', '1d');
      u.searchParams.set('interval', '1d');
    }
    u.searchParams.set('includePrePost', 'false');
    return u;
  },
  headers: { 'user-agent': 'Mozilla/5.0' },
  async transform(cap, data, p) {
    if (cap === 'chart') return data;
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
