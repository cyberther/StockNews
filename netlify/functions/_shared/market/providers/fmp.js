// Financial Modeling Prep adapter (stable API): quotes, company profiles and earnings.
// Replies are converted to Finnhub's shapes, which the apps read. Free tier: 250 calls a
// day, US listings. Key: FMP_KEY.
const BASE = 'https://financialmodelingprep.com/stable';
const PATHS = { quote: '/quote', profile: '/profile', earnings: '/earnings', earningsHistory: '/earnings' };

const num = v => (v == null || v === '' ? null : Number(v));
const first = d => (Array.isArray(d) ? d[0] : null) || null;

export const fmp = {
  name: 'fmp',
  needsKey: true,
  limits: { perDay: 250 },
  supports: cap => cap in PATHS,
  url(cap, p, key) {
    const u = new URL(BASE + PATHS[cap]);
    u.searchParams.set('symbol', p.symbol);
    u.searchParams.set('apikey', key);
    return u;
  },
  // Plan limits come back as a message object rather than an error status.
  status(res) {
    const d = res.parsed;
    if (d && !Array.isArray(d) && typeof d === 'object' && (d['Error Message'] || d.message)) {
      return /limit/i.test(d['Error Message'] || d.message) ? 429 : 403;
    }
    return res.status;
  },
  async transform(cap, d, p) {
    if (cap === 'quote') {
      const q = first(d);
      return q ? { c: num(q.price), d: num(q.change), dp: num(q.changePercentage), h: num(q.dayHigh), l: num(q.dayLow),
        o: num(q.open), pc: num(q.previousClose), t: num(q.timestamp) } : {};
    }
    if (cap === 'profile') {
      const q = first(d);
      return q ? { ticker: q.symbol, name: q.companyName, currency: q.currency, exchange: q.exchangeFullName || q.exchange,
        finnhubIndustry: q.industry, logo: q.defaultImage ? '' : (q.image || ''), country: q.country, weburl: q.website,
        ipo: q.ipoDate } : {};
    }
    // Earnings rows carry the report date and EPS, not the fiscal quarter.
    const rows = (Array.isArray(d) ? d : []).filter(r => r && /^\d{4}-\d{2}-\d{2}$/.test(r.date || ''));
    if (cap === 'earningsHistory') {
      return rows.map(r => ({ symbol: p.symbol, date: r.date, epsActual: num(r.epsActual), epsEstimate: num(r.epsEstimated), hour: '', quarter: null, year: null }));
    }
    return rows.filter(r => r.epsActual != null).map(r => {
      const a = num(r.epsActual), e = num(r.epsEstimated);
      return { symbol: p.symbol, period: r.date, actual: a, estimate: e, surprise: e == null ? null : a - e,
        surprisePercent: e ? (a - e) / Math.abs(e) * 100 : null, quarter: null, year: null };
    });
  },
  empty: (cap, data) => cap === 'quote' ? !(data && data.c) : cap === 'profile' ? !(data && data.name) : !(Array.isArray(data) && data.length)
};
