// Company news for German (XETRA, .DE) and London (LSE, .L) listings, from the RSS feeds of
// the German and British press. As with the Romanian press (ro-news.js), only what each feed
// publishes for syndication is used: headline, its short description and the link to the
// publisher's article.
//
// A story belongs to a company when it names it: a name from the catalog (eu-symbols.js,
// built by tools/update-eu-catalog.mjs), matched case-sensitively as a whole word. Items come
// out in Finnhub's company-news shape, with ids hashed from the link like the Romanian ones.
import { EU_SHARES, EU_ALIASES } from './eu-symbols.js';
import { feedReader, storyId } from './ro-news.js';

export const EU_FEEDS = [
  { url: 'https://www.tagesschau.de/wirtschaft/index~rss2.xml', source: 'tagesschau' },
  { url: 'https://feeds.cms.handelsblatt.com/finanzen', source: 'Handelsblatt' },
  { url: 'https://feeds.cms.handelsblatt.com/unternehmen', source: 'Handelsblatt' },
  { url: 'https://feeds.cms.wiwo.de/rss/unternehmen', source: 'WirtschaftsWoche' },
  { url: 'https://www.manager-magazin.de/unternehmen/index.rss', source: 'manager magazin' },
  { url: 'https://www.spiegel.de/wirtschaft/unternehmen/index.rss', source: 'Der Spiegel' },
  { url: 'https://www.faz.net/rss/aktuell/finanzen/', source: 'FAZ' },
  { url: 'https://www.faz.net/rss/aktuell/wirtschaft/unternehmen/', source: 'FAZ' },
  { url: 'https://www.n-tv.de/wirtschaft/rss', source: 'n-tv' },
  { url: 'https://feeds.bbci.co.uk/news/business/rss.xml', source: 'BBC News' },
  { url: 'https://www.theguardian.com/uk/business/rss', source: 'The Guardian' },
  { url: 'https://www.cityam.com/feed/', source: 'City AM' },
  { url: 'https://www.thisismoney.co.uk/money/markets/index.rss', source: 'This is Money' }
];
export const allEuItems = feedReader(EU_FEEDS, 'eunews');

export const isEu = symbol => /\.(DE|L)$/.test(String(symbol || ''));

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Before a name that is also an ordinary word, an article means the word ("eine Allianz").
const ARTICLES = ['ein', 'eine', 'einer', 'einen', 'einem', 'die', 'der', 'den', 'dem', 'des', 'das', 'a', 'an', 'the'];
const ARTICLE = `(?<!\\b(?:${ARTICLES.concat(ARTICLES.map(w => w[0].toUpperCase() + w.slice(1))).join('|')})\\s)`;
const L = 'A-Za-zÄÖÜäöüß0-9';
const ALL_NAMES = [...new Set(Object.values(EU_ALIASES).flat().map(n => n.replace(/^~/, '')))];
const matchers = new Map();
function matcherFor(symbol) {
  if (matchers.has(symbol)) return matchers.get(symbol);
  const names = EU_ALIASES[symbol];
  if (!names || !names.length) { matchers.set(symbol, null); return null; }
  // "Siemens" is not "Siemens Energy": a name doesn't match where another company's longer
  // name starting with it stands. Compounds still match ("Siemens-Aktie", "Allianz-Chef").
  const part = n => {
    const plain = n.replace(/^~/, '');
    const longer = ALL_NAMES.filter(x => x.startsWith(plain + ' ')).map(x => esc(x.slice(plain.length)));
    return (n.startsWith('~') ? ARTICLE : '') + esc(plain) + (longer.length ? `(?!${longer.join('|')})` : '');
  };
  const parts = names.map(part).sort((a, b) => b.length - a.length);
  const re = new RegExp(`(?<![${L}&-])(?:${parts.join('|')})(?![${L}&])`);
  const m = text => { const hit = re.exec(String(text || '')); return hit ? hit.index : -1; };
  matchers.set(symbol, m);
  return m;
}

// Round-ups: running tickers and live blogs ("Business-Ticker", "+++ ... +++"), whose
// headline is one item and whose text lists many companies. Filed under any of them, the
// card (and its AI summary, written from the whole page) would be about something else.
const ROUNDUP = /(?:^|[\s:-])(?:(?:business|börsen|news|wirtschafts|live)-?ticker|liveblog|live-blog|newsblog|newsticker|im überblick|auf einen blick|kompakt|markets? live|business live|as it happened)(?![\p{L}])/iu;
export const isRoundup = x => ROUNDUP.test(x.headline) || /\+\+\+/.test(x.headline + ' ' + x.summary);

const shape = (x, symbol) => ({ category: 'company', datetime: x.datetime, headline: x.headline, id: storyId(x.url),
  image: '', related: symbol, source: x.source, summary: x.summary, url: x.url });

// Stories about one .DE or .L company between two ISO dates, newest first.
export async function euCompanyNews(symbol, from, to, log) {
  const m = matcherFor(symbol);
  if (!m) return [];
  const lo = from ? Date.parse(from + 'T00:00:00Z') / 1000 : 0, hi = to ? Date.parse(to + 'T23:59:59Z') / 1000 : Infinity;
  return (await allEuItems(log)).filter(x => x.datetime >= lo && x.datetime <= hi && !isRoundup(x) && m(x.headline + ' \n ' + x.summary) >= 0)
    .slice(0, 40).map(x => shape(x, symbol));
}

// Every story whose headline names a listed company (the EU Market tab), filed under the
// company named first. A company only mentioned further down is not what the story is about.
export async function euMarketNews(limit, log) {
  const out = [];
  for (const x of await allEuItems(log)) {
    if (isRoundup(x)) continue;
    let best = null, bestAt = Infinity;
    for (const [sym] of EU_SHARES) {
      const m = matcherFor(sym);
      const at = m ? m(x.headline) : -1;
      if (at >= 0 && at < bestAt) { best = sym; bestAt = at; }
    }
    if (best) out.push(shape(x, best));
    if (out.length >= (limit || 60)) break;
  }
  return out;
}

export function resetEuNewsForTests() { allEuItems.reset(); matchers.clear(); }
export const EU_SYMBOLS = EU_SHARES.map(r => r[0]);
