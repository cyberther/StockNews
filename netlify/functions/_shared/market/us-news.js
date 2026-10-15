// US company news beyond Finnhub: the companies' own press releases (PR Newswire, Business
// Wire) and the financial press (CNBC, MarketWatch), from their public RSS feeds. As with
// the Romanian and European press, only what each feed publishes for syndication is used:
// headline, short description and the link to the publisher's page.
//
// A press release names its issuer the way the exchanges require, "(NASDAQ: OKLO)" or
// "(NYSE: JPM)", so it is filed under that ticker, small companies included. A CNBC or
// MarketWatch story is filed under a company only when its headline names it (the
// registered name without "Inc." and the like, or a known alias such as "Google").
// GlobeNewswire refuses automated readers, so it is not read.
import { feedReader, storyId } from './ro-news.js';

export const US_FEEDS = [
  { url: 'https://www.prnewswire.com/rss/news-releases-list.rss', source: 'PR Newswire', wire: true },
  { url: 'https://www.prnewswire.com/rss/financial-services-latest-news/financial-services-latest-news-list.rss', source: 'PR Newswire', wire: true },
  { url: 'https://feed.businesswire.com/rss/home/?rss=G1QFDERJXkJeEFtRWA==', source: 'Business Wire', wire: true },
  { url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', source: 'CNBC' },
  { url: 'https://www.cnbc.com/id/10001147/device/rss/rss.html', source: 'CNBC' },
  { url: 'https://www.cnbc.com/id/15839135/device/rss/rss.html', source: 'CNBC' },
  { url: 'https://www.cnbc.com/id/19854910/device/rss/rss.html', source: 'CNBC' },
  { url: 'https://www.cnbc.com/id/15839069/device/rss/rss.html', source: 'CNBC' },
  { url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories', source: 'MarketWatch' },
  { url: 'https://feeds.content.dowjones.io/public/rss/mw_bulletins', source: 'MarketWatch' }
];
export const allUsItems = feedReader(US_FEEDS, 'usnews');

// "(NASDAQ: OKLO)", "(NYSE:JPM)", "(Nasdaq: AAPL; NYSE: X)", "(NYSE American: UEC)", "(OTCQX: ABC)".
const EXCHANGE = /\b(?:NASDAQ|Nasdaq|NYSE(?: American| Arca| MKT)?|NYSEAmerican|Cboe(?: BZX)?|OTC(?:QX|QB| Pink)?)\s*:\s*([A-Z][A-Z0-9]{0,5}(?:\.[A-Z])?)\b/g;
export function tickersIn(text) {
  const out = [];
  for (const m of String(text || '').matchAll(EXCHANGE)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

// The words a headline uses for a company: its name without the legal suffix, and aliases.
const SUFFIX = /[,.]?\s+\b(?:Incorporated|Inc|Corporation|Corp|Company|Co|Ltd|Limited|plc|PLC|Holdings?|Group|N\.?V|S\.?A|AG|SE|ADR|Class [A-C]|Common Stock)\b\.?/g;
const ALIASES = {
  GOOGL: ['Google', 'Alphabet'], GOOG: ['Google', 'Alphabet'], META: ['Meta', 'Facebook', 'Instagram', 'WhatsApp'],
  TSM: ['TSMC', 'Taiwan Semiconductor'], JPM: ['JPMorgan', 'JP Morgan'], AMZN: ['Amazon', 'AWS'], MSFT: ['Microsoft'],
  AAPL: ['Apple'], NVDA: ['Nvidia'], TSLA: ['Tesla'], AVGO: ['Broadcom'], AMD: ['AMD'], LLY: ['Eli Lilly', 'Lilly'],
  'BRK.B': ['Berkshire'], NVO: ['Novo Nordisk'], ASTS: ['AST SpaceMobile']
};
// Names that are also everyday words in a headline: matched only through their ticker.
const TOO_COMMON = new Set(['Target', 'Visa', 'Block', 'Snap', 'Gap', 'Shell', 'Ball', 'Match', 'Opendoor', 'Progressive',
  'Corning', 'Carrier', 'Equity', 'Global', 'American', 'General', 'National', 'United', 'First', 'Federal', 'Energy']);
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function namesFor(symbol, companyName) {
  const names = new Set(ALIASES[symbol] || []);
  const clean = String(companyName || '').replace(SUFFIX, '').replace(/\s+/g, ' ').trim();
  if (clean.length >= 4 && !TOO_COMMON.has(clean)) names.add(clean);
  return [...names];
}
function headlineMatcher(symbol, companyName) {
  const names = namesFor(symbol, companyName);
  // Case-sensitive, whole words: "Apple" is the company, "apple" is fruit.
  const re = names.length ? new RegExp(`(?<![A-Za-z0-9&-])(?:${names.map(esc).join('|')})(?![A-Za-z0-9&])`) : null;
  // The bare ticker in capitals counts too ("OKLO shares jump"), from three letters up.
  const t = symbol.length >= 3 ? new RegExp(`(?<![A-Za-z$])\\$?${esc(symbol)}(?![A-Za-z])`) : null;
  return h => (re && re.test(h)) || (t && t.test(h));
}

const WIRE = new Set(US_FEEDS.filter(f => f.wire).map(f => f.source));
// Round-ups and live blogs: one headline about many companies ("Inflation data, Apple's new
// hub and more in Morning Squawk", "Stocks making the biggest moves midday").
const ROUNDUP = /\band more in\b|Morning Squawk|Evening Brief|biggest moves|stocks to watch|live updates|stock market today|\bmarkets? wrap\b|week ahead/i;
// The same story in two feeds (MarketWatch top stories and bulletins) under two links.
async function items(log) {
  const seen = new Set();
  return (await allUsItems(log)).filter(x => {
    if (!WIRE.has(x.source) && ROUNDUP.test(x.headline)) return false;
    const k = x.source + '|' + x.headline.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}
const shape = (x, symbol) => ({ category: 'company', datetime: x.datetime, headline: x.headline, id: storyId(x.url),
  image: '', related: symbol, source: x.source, summary: x.summary, url: x.url });

// Stories about one US company between two ISO dates, newest first.
export async function usCompanyNews(symbol, companyName, from, to, log) {
  const lo = from ? Date.parse(from + 'T00:00:00Z') / 1000 : 0, hi = to ? Date.parse(to + 'T23:59:59Z') / 1000 : Infinity;
  const named = headlineMatcher(symbol, companyName);
  return (await items(log)).filter(x => x.datetime >= lo && x.datetime <= hi &&
      (WIRE.has(x.source) ? tickersIn(x.headline + ' ' + x.summary).includes(symbol) : named(x.headline)))
    .slice(0, 40).map(x => shape(x, symbol));
}

// The press releases of listed US companies (each filed under the first ticker it cites),
// and, for the companies given as { symbol: name }, the CNBC and MarketWatch stories whose
// headline names them. For the background scan, which stores them like any other story.
export async function usMarketNews(names, limit, log) {
  const want = Object.keys(names || {}), matchers = want.map(t => [t, headlineMatcher(t, names[t])]);
  const out = [];
  for (const x of await items(log)) {
    if (WIRE.has(x.source)) {
      const t = tickersIn(x.headline + ' ' + x.summary)[0];
      if (t) out.push(shape(x, t));
    } else {
      const hit = matchers.find(([, m]) => m(x.headline));
      if (hit) out.push(shape(x, hit[0]));
    }
    if (out.length >= (limit || 150)) break;
  }
  return out;
}

export function resetUsNewsForTests() { allUsItems.reset(); }
