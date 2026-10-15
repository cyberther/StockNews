// Romanian company news for Bucharest Stock Exchange listings (.RO), from the RSS feeds of
// the Romanian financial press. Only what each feed publishes for syndication is used:
// headline, its short description and the link to the publisher's article.
//
// A story belongs to a company when it names it (catalog name or a known alias, compared
// without diacritics) or cites its symbol, e.g. "(TLV)". Items come out in Finnhub's
// company-news shape, so the apps read them like any other news; ids are a stable hash of
// the article link, so the background scan, alerts and AI summaries line up with them.
import { BVB_SHARES, BVB_ALIASES } from './bvb-symbols.js';

export const RO_FEEDS = [
  { url: 'https://www.zf.ro/rss/burse-fonduri-mutuale', source: 'Ziarul Financiar' },
  { url: 'https://www.zf.ro/rss', source: 'Ziarul Financiar' },
  { url: 'https://financialintelligence.ro/feed/', source: 'Financial Intelligence' },
  { url: 'https://www.profit.ro/rss', source: 'Profit.ro' },
  { url: 'https://www.economica.net/feed', source: 'Economica.net' },
  { url: 'https://www.investenergy.ro/feed/', source: 'InvestEnergy' }
];
const FEED_TTL = 10 * 60 * 1000;
const MAX_BYTES = 3 * 1024 * 1024;

// ------------------------------------------------------------------ RSS
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', ndash: '–', mdash: '—',
  laquo: '«', raquo: '»', bdquo: '„', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’' };
function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] != null ? ENTITIES[n.toLowerCase()] : m)
    // Feeds that escape their HTML (The Guardian: &lt;p&gt;) have tags again only now.
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
const tag = (xml, name) => { const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(xml); return m ? m[1] : ''; };

export function parseRss(xml, source) {
  const items = [];
  const re = /<item[\s>][\s\S]*?<\/item>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const it = m[0];
    // Business Wire lists its pages over http; they are served over https too.
    const link = (decode(tag(it, 'link')) || decode(tag(it, 'guid'))).replace(/^http:\/\/(?:www\.)?businesswire\.com\//, 'https://www.businesswire.com/');
    const headline = decode(tag(it, 'title'));
    const ts = Date.parse(decode(tag(it, 'pubDate')) || decode(tag(it, 'dc:date')));
    if (!/^https:\/\//.test(link) || !headline || !Number.isFinite(ts)) continue;
    let summary = decode(tag(it, 'description'));
    if (summary.length > 400) summary = summary.slice(0, 400).replace(/\s+\S*$/, '') + '…';
    items.push({ headline, summary, url: link, source, datetime: Math.floor(ts / 1000) });
  }
  return items;
}

// FNV-1a over the link, folded to 53 bits: a stable numeric id, like Finnhub's.
export function storyId(link) {
  let h = 0xcbf29ce484222325n;
  for (const b of new TextEncoder().encode(link)) { h ^= BigInt(b); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; }
  return Number(h & 0x1fffffffffffffn);
}

async function fetchFeed(f) {
  const res = await fetch(f.url, { headers: { 'user-agent': 'Mozilla/5.0 (StockNews news reader)', accept: 'application/rss+xml, application/xml, text/xml' }, signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(f.url + ' ' + res.status);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error(f.url + ' too large');
  return parseRss(text, f.source);
}
// A reader for a list of feeds: every feed, cached for 10 minutes and shared by concurrent
// requests. A feed that fails is skipped; the others still count. Also used for the German
// and British press (eu-news.js).
export function feedReader(feeds, provider) {
  let feedCache = { at: 0, items: [], pending: null };
  async function allItems(log) {
    if (Date.now() - feedCache.at < FEED_TTL) return feedCache.items;
    if (feedCache.pending) return feedCache.pending;
    feedCache.pending = (async () => {
      const results = await Promise.allSettled(feeds.map(fetchFeed));
      const seen = new Set(), items = [];
      results.forEach((r, i) => {
        if (r.status !== 'fulfilled') { if (log) log({ evt: 'market.upstream', provider, cap: 'feed', status: 'error', feed: feeds[i].source }); return; }
        r.value.forEach(x => { if (!seen.has(x.url)) { seen.add(x.url); items.push(x); } });
      });
      items.sort((a, b) => b.datetime - a.datetime);
      // Keep the previous items if every feed failed this time.
      if (items.length || !feedCache.items.length) feedCache = { at: Date.now(), items, pending: null };
      else feedCache = { ...feedCache, at: Date.now() - FEED_TTL + 60_000, pending: null };
      return feedCache.items;
    })();
    try { return await feedCache.pending; } finally { feedCache.pending = null; }
  }
  allItems.reset = () => { feedCache = { at: 0, items: [], pending: null }; };
  return allItems;
}
export const allItems = feedReader(RO_FEEDS, 'ronews');

// ------------------------------------------------------------------ matching
const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[șş]/gi, 's').replace(/[țţ]/gi, 't');
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Words too common in Romanian business writing to identify a company on their own.
const GENERIC = new Set(['romania', 'romaniei', 'romanesc', 'bucuresti', 'energie', 'energy', 'banca', 'bank', 'fond', 'fondul',
  'industrie', 'industrial', 'constructii', 'transport', 'grup', 'group', 'holding', 'invest', 'investments', 'capital',
  'agricola', 'media', 'imobiliare', 'turism', 'services', 'servicii', 'comert', 'productie', 'international', 'national',
  'nationala', 'societatea', 'compania', 'company', 'system', 'systems', 'solutions', 'technologies', 'partners', 'trading',
  'development', 'network', 'communications', 'properties', 'financial', 'franchise', 'innovations', 'business', 'prod',
  'part', 'com', 'impex', 'sistem', 'distributie', 'electric', 'hotel', 'hoteluri', 'farm', 'pharma']);
// Single-word company names that are also ordinary Romanian words or place names.
const COMMON_WORDS = new Set(['sinteza', 'armatura', 'practic', 'prefab', 'fort', 'socep', 'aeta', 'condmag']);
// Symbols that are also everyday abbreviations in the press, matched only in brackets.
const PLAIN_TICKER_BLOCK = new Set(['BVB', 'ONE', 'TEL', 'BIO', 'ART', 'CAR', 'SAFE', 'OIL', 'AIR', 'IPO', 'EUR', 'USD', 'RON', 'ARS']);

// A company is named by its full name (or an alias) as the press writes it: capitalised
// ("Electrica", "One United Properties") or in capitals ("ROMGAZ"). Matching is
// case-sensitive, so ordinary words ("energie electrică") and names that contain a city
// ("Bad Suceava" doesn't match "Suceava") don't count. Returns the position of the first
// mention, or -1.
const matchers = new Map();
function matcherFor(symbol) {
  if (matchers.has(symbol)) return matchers.get(symbol);
  const row = BVB_SHARES.find(r => r[0] === symbol);
  if (!row) { matchers.set(symbol, null); return null; }
  const base = symbol.replace(/\.RO$/, '');
  const names = new Set();
  const add = n => { const f = fold(n).trim(); if (f) { names.add(f); names.add(f.toUpperCase()); } };
  (BVB_ALIASES[symbol] || []).forEach(add);
  const clean = fold(row[1]).replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim();
  const words = clean.split(' ');
  if (words.length >= 2 || (clean.length >= 6 && !GENERIC.has(clean.toLowerCase()) && !COMMON_WORDS.has(clean.toLowerCase()))) add(clean);
  const nameRe = names.size ? new RegExp(`(?<![A-Za-z0-9])(${[...names].sort((x, y) => y.length - x.length).map(esc).join('|')})(?![A-Za-z0-9])`) : null;
  // "(TLV)", "(BVB: TLV)", "simbolul TLV"; and a bare upper-case symbol of 3+ letters unless
  // it is an everyday abbreviation.
  const bracket = new RegExp(`\\((?:BVB\\s*:\\s*)?${esc(base)}\\)|simbol(?:ul)?\\s+${esc(base)}(?![A-Za-z0-9])`);
  const bare = base.length >= 3 && !PLAIN_TICKER_BLOCK.has(base) && !/^\d/.test(base) ? new RegExp(`(?<![A-Za-z0-9])${esc(base)}(?![A-Za-z0-9])`) : null;
  const m = text => {
    const f = fold(text);
    let at = -1;
    for (const re of [nameRe, bracket, bare]) {
      if (!re) continue;
      const hit = re.exec(f);
      if (hit && (at < 0 || hit.index < at)) at = hit.index;
    }
    return at;
  };
  matchers.set(symbol, m);
  return m;
}

const shape = (x, symbol) => ({ category: 'company', datetime: x.datetime, headline: x.headline, id: storyId(x.url),
  image: '', related: symbol, source: x.source, summary: x.summary, url: x.url });

// Stories about one .RO company between two ISO dates, newest first.
export async function companyNews(symbol, from, to, log) {
  const m = matcherFor(symbol);
  if (!m) return [];
  const lo = from ? Date.parse(from + 'T00:00:00Z') / 1000 : 0, hi = to ? Date.parse(to + 'T23:59:59Z') / 1000 : Infinity;
  return (await allItems(log)).filter(x => x.datetime >= lo && x.datetime <= hi && m(x.headline + ' \n ' + x.summary) >= 0)
    .slice(0, 40).map(x => shape(x, symbol));
}

// Every story that names a listed company (the BVB market tab). Each is filed under the
// company named first in its headline, or else first in its text.
export async function marketNews(limit, log) {
  const out = [];
  for (const x of await allItems(log)) {
    let best = null, bestAt = Infinity;
    for (const part of [x.headline, x.summary]) {
      for (const [sym] of BVB_SHARES) {
        const m = matcherFor(sym);
        const at = m ? m(part) : -1;
        if (at >= 0 && at < bestAt) { best = sym; bestAt = at; }
      }
      if (best) break;
    }
    if (best) out.push(shape(x, best));
    if (out.length >= (limit || 40)) break;
  }
  return out;
}

export function resetRoNewsForTests() { allItems.reset(); matchers.clear(); }
