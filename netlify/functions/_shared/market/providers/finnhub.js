// Finnhub adapter. Turns a gateway capability into a Finnhub request; replies stay in
// Finnhub's own shape, which is what the apps read today. The key comes from the caller
// (an env var) and is only ever placed on the upstream URL.
import { cleanNews } from '../../news-clean.js';

const BASE = 'https://finnhub.io/api/v1';

const PATHS = {
  quote: '/quote',
  news: '/company-news',
  search: '/search',
  recommendation: '/stock/recommendation',
  earnings: '/stock/earnings',
  earningsCalendar: '/calendar/earnings',
  profile: '/stock/profile2',
  insiderTx: '/stock/insider-transactions',
  secFilings: '/stock/filings'
};

export const finnhub = {
  name: 'finnhub',
  needsKey: true,
  // Free tier: 60 calls a minute per key, no daily cap.
  limits: { perMinute: 60 },
  supports: cap => cap in PATHS,
  url(cap, p, key) {
    const u = new URL(BASE + PATHS[cap]);
    if (cap === 'search') u.searchParams.set('q', p.q);
    else u.searchParams.set('symbol', p.symbol);
    if (p.from) { u.searchParams.set('from', p.from); u.searchParams.set('to', p.to); }
    if (cap === 'earnings') u.searchParams.set('limit', String(p.limit));
    u.searchParams.set('token', key);
    return u;
  },
  // An empty profile (some ETFs and ADRs) or earnings list lets the next provider try.
  // An empty quote (c: 0) is kept: it usually means an unknown symbol, and asking every
  // other provider about it would only spend their small daily quotas.
  empty: (cap, d) => cap === 'profile' ? !(d && d.name) : cap === 'earnings' ? !(Array.isArray(d) && d.length) : false,
  async transform(cap, data, p, key) {
    if (cap === 'news') return cleanNews(data, p.symbol, { apiKey: key });
    return data;
  }
};
