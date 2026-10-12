// Price history from Yahoo's public chart endpoint (Finnhub's candles are not on the
// free tier). Replies stay in Yahoo's shape, which hif-live.js reads.
const RANGES = { '1d': '5m', '5d': '15m', '1mo': '60m', '6mo': '1d', ytd: '1d', '1y': '1d', '5y': '1wk' };
// With warm=1 the same bar size covers a longer range, so moving averages and RSI have
// history before the first visible bar.
const WARM = { '1d': '5d', '5d': '1mo', '1mo': '3mo', '6mo': '1y', ytd: '2y', '1y': '2y', '5y': '10y' };

export const CHART_RANGES = Object.keys(RANGES);

export const yahoo = {
  name: 'yahoo',
  needsKey: false,
  limits: {},
  supports: cap => cap === 'chart',
  url(cap, p) {
    const u = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(p.symbol)}`);
    u.searchParams.set('range', p.warm ? WARM[p.range] : p.range);
    u.searchParams.set('interval', RANGES[p.range]);
    u.searchParams.set('includePrePost', 'false');
    return u;
  },
  headers: { 'user-agent': 'Mozilla/5.0' },
  async transform(cap, data) { return data; }
};
