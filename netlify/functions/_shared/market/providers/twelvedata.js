// Twelve Data adapter: quotes and price history. Replies are converted to the shapes the
// apps already read (Finnhub's quote, Yahoo's chart). Free tier: about 8 credits a minute
// and 800 a day, one credit per symbol, so it backs up the main providers rather than
// carrying the load. Key: TWELVEDATA_KEY.
const BASE = 'https://api.twelvedata.com';

// Chart range -> bar size, and how many bars cover the range (and the longer warm-up
// range, so moving averages have history before the first visible bar).
const CHART = {
  '1d':  { interval: '5min',  bars: 80,  warm: 400 },
  '5d':  { interval: '15min', bars: 135, warm: 600 },
  '1mo': { interval: '1h',    bars: 160, warm: 480 },
  '6mo': { interval: '1day',  bars: 130, warm: 260 },
  ytd:   { interval: '1day',  bars: 260, warm: 520 },
  '1y':  { interval: '1day',  bars: 260, warm: 520 },
  '5y':  { interval: '1week', bars: 265, warm: 530 }
};

const num = v => (v == null || v === '' ? null : Number(v));

// Seconds east of UTC for an IANA zone right now (Yahoo's meta.gmtoffset).
function tzOffset(zone) {
  try {
    const d = new Date(), local = new Date(d.toLocaleString('en-US', { timeZone: zone || 'America/New_York' }));
    const utc = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
    return Math.round((local - utc) / 1000);
  } catch { return 0; }
}

export const twelvedata = {
  name: 'twelvedata',
  needsKey: true,
  limits: { perMinute: 8, perDay: 800 },
  supports: cap => cap === 'quote' || cap === 'chart',
  url(cap, p, key) {
    const u = new URL(BASE + (cap === 'quote' ? '/quote' : '/time_series'));
    u.searchParams.set('symbol', p.symbol);
    if (cap === 'chart') {
      const c = CHART[p.range];
      u.searchParams.set('interval', c.interval);
      u.searchParams.set('outputsize', String(p.warm ? c.warm : c.bars));
      u.searchParams.set('timezone', 'UTC');
    }
    u.searchParams.set('apikey', key);
    return u;
  },
  // Errors can arrive with HTTP 200 and the real code in the body.
  status(res) {
    const d = res.parsed;
    if (d && d.status === 'error') return Number(d.code) || 400;
    return res.status;
  },
  async transform(cap, d, p) {
    if (cap === 'quote') {
      return { c: num(d.close), d: num(d.change), dp: num(d.percent_change), h: num(d.high), l: num(d.low),
        o: num(d.open), pc: num(d.previous_close), t: num(d.timestamp) };
    }
    const values = (Array.isArray(d.values) ? d.values : []).slice().reverse();
    const daily = /day|week|month/.test((d.meta && d.meta.interval) || '');
    // Intraday bars come in UTC; daily bars are dated, so place them mid-session (16:00 UTC)
    // where the exchange date and the UTC date agree.
    const ts = v => Math.round(Date.parse(daily ? v.datetime.slice(0, 10) + 'T16:00:00Z' : v.datetime.replace(' ', 'T') + 'Z') / 1000);
    const meta = d.meta || {};
    return { chart: { error: null, result: [{
      meta: { symbol: p.symbol, currency: meta.currency || 'USD', gmtoffset: tzOffset(meta.exchange_timezone), exchangeName: meta.exchange || '' },
      timestamp: values.map(ts),
      indicators: { quote: [{
        open: values.map(v => num(v.open)), high: values.map(v => num(v.high)), low: values.map(v => num(v.low)),
        close: values.map(v => num(v.close)), volume: values.map(v => num(v.volume))
      }] }
    }] } };
  },
  empty: (cap, data) => cap === 'quote' ? !(data && data.c) : !(data && data.chart.result[0].timestamp.length)
};
