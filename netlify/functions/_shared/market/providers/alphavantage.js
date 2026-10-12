// Alpha Vantage adapter: last resort for quotes and company names. Free tier: about 25
// calls a day, so it only answers when every other provider has failed. Key:
// ALPHAVANTAGE_KEY.
const BASE = 'https://www.alphavantage.co/query';
const num = v => (v == null || v === '' || v === 'None' ? null : Number(String(v).replace('%', '')));

export const alphavantage = {
  name: 'alphavantage',
  needsKey: true,
  limits: { perMinute: 5, perDay: 25 },
  supports: cap => cap === 'quote' || cap === 'profile',
  url(cap, p, key) {
    const u = new URL(BASE);
    u.searchParams.set('function', cap === 'quote' ? 'GLOBAL_QUOTE' : 'OVERVIEW');
    u.searchParams.set('symbol', p.symbol);
    u.searchParams.set('apikey', key);
    return u;
  },
  // Over quota it answers 200 with a Note / Information message instead of data.
  status(res) {
    const d = res.parsed;
    if (d && (d.Note || d.Information)) return 429;
    if (d && d['Error Message']) return 400;
    return res.status;
  },
  async transform(cap, d) {
    if (cap === 'quote') {
      const q = (d && d['Global Quote']) || {};
      const day = q['07. latest trading day'];
      return { c: num(q['05. price']), d: num(q['09. change']), dp: num(q['10. change percent']), h: num(q['03. high']),
        l: num(q['04. low']), o: num(q['02. open']), pc: num(q['08. previous close']),
        t: day ? Math.round(Date.parse(day + 'T20:00:00Z') / 1000) : null };
    }
    return d && d.Name ? { ticker: d.Symbol, name: d.Name, currency: d.Currency, exchange: d.Exchange,
      finnhubIndustry: d.Industry, country: d.Country, weburl: d.OfficialSite || '' } : {};
  },
  empty: (cap, data) => cap === 'quote' ? !(data && data.c) : !(data && data.name)
};
