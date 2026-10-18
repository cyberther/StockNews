// The press feeds the gateway already reads (netlify/functions/_shared/market/), used by the
// ingestion jobs directly: each feed is read once per run, whoever follows what.
import { marketNews, RO_FEEDS } from '../netlify/functions/_shared/market/ro-news.js';
import { usMarketNews, US_FEEDS } from '../netlify/functions/_shared/market/us-news.js';
import { euCompanyNews, EU_FEEDS } from '../netlify/functions/_shared/market/eu-news.js';

const ymd = offsetDays => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);

export const pressNews = {
  feedCount: { ro: RO_FEEDS.length, us: US_FEEDS.length, eu: EU_FEEDS.length },
  // Every Bucharest press story naming a listed company (the BVB tab).
  ro: () => marketNews(300),
  // US press releases, and press stories naming the companies given as { symbol: name }.
  us: names => usMarketNews(names, 400),
  // Stories naming one German or British company (the feeds are read once, then cached).
  eu: (symbol, name) => euCompanyNews(symbol, ymd(-2), ymd(1), undefined, name)
};
