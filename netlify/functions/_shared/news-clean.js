// Cleans Finnhub company news before it reaches the apps.
//
// 1. Relevance. Finnhub tags a ticker onto many general market articles ("3 dividend
//    stocks…", "Chipotle soars…" under NVDA). A story is kept only when its headline or
//    summary names the company (from Finnhub's /stock/profile2, plus a few common
//    aliases) or its ticker.
// 2. Publisher. Every syndicated story arrives as source "Yahoo" with a finnhub.io
//    redirect link. The redirect is followed once to find the real article, so the app
//    shows "Motley Fool" and links straight to fool.com.
//
// Plain ES module with no dependencies: used by the Netlify function and the local
// preview server. supabase/functions/scan keeps a copy of the same rules.

const SUFFIX = /\b(incorporated|inc|corporation|corp|company|co|ltd|limited|plc|holdings?|group|n\.?v|s\.?a|ag|se|a\/s|asa|ab|oyj|spa|ADR|class [a-c]|the)\b\.?/gi;
const GENERIC = new Set(['international', 'technologies', 'technology', 'systems', 'global', 'american',
  'america', 'financial', 'capital', 'energy', 'pharmaceuticals', 'therapeutics', 'motors', 'platforms',
  'semiconductor', 'manufacturing', 'industries', 'services', 'solutions', 'communications', 'networks',
  'resources', 'brands', 'enterprises', 'partners', 'trust', 'bank', 'bancorp', 'chase', 'and']);
// Names the press uses that the registered name doesn't contain.
const ALIASES = {
  GOOGL: ['Google', 'Alphabet'], GOOG: ['Google', 'Alphabet'], META: ['Meta', 'Facebook', 'Instagram', 'WhatsApp'],
  TSM: ['TSMC', 'Taiwan Semiconductor'], NVO: ['Novo Nordisk', 'Novo', 'Wegovy', 'Ozempic'], LLY: ['Eli Lilly', 'Lilly'],
  JPM: ['JPMorgan', 'JP Morgan'], BRK: ['Berkshire'], 'BRK.B': ['Berkshire'], 'BRK.A': ['Berkshire'],
  AMZN: ['Amazon', 'AWS'], MSFT: ['Microsoft', 'Azure'], AAPL: ['Apple', 'iPhone'], NVDA: ['Nvidia'],
  TSLA: ['Tesla'], AVGO: ['Broadcom'], AMD: ['AMD', 'Advanced Micro Devices'], ASTS: ['AST SpaceMobile', 'SpaceMobile']
};

export function keywordsFor(symbol, companyName) {
  const words = new Set(ALIASES[symbol] || []);
  const clean = String(companyName || '').replace(SUFFIX, ' ').replace(/[,()]/g, ' ').replace(/\s+/g, ' ').trim();
  if (clean) {
    words.add(clean);
    clean.split(' ').forEach(w => { if (w.length >= 4 && !GENERIC.has(w.toLowerCase())) words.add(w); });
  }
  return [...words];
}

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function matcher(symbol, companyName) {
  const words = keywordsFor(symbol, companyName);
  const nameRe = words.length ? new RegExp('\\b(' + words.map(esc).join('|') + ')\\b', 'i') : null;
  // The bare ticker only counts in capitals ("AMD", "$NVDA"), and not for one- or
  // two-letter tickers, which collide with ordinary words.
  const tickerRe = symbol.length >= 3 ? new RegExp('(^|[^A-Za-z])\\$?' + esc(symbol) + '(?![A-Za-z])') : null;
  return text => (nameRe && nameRe.test(text)) || (tickerRe && tickerRe.test(text));
}

const PUBLISHERS = {
  'fool.com': 'Motley Fool', '247wallst.com': '24/7 Wall St.', 'finance.yahoo.com': 'Yahoo Finance',
  'yahoo.com': 'Yahoo Finance', 'reuters.com': 'Reuters', 'bloomberg.com': 'Bloomberg', 'cnbc.com': 'CNBC',
  'marketwatch.com': 'MarketWatch', 'barrons.com': "Barron's", 'wsj.com': 'WSJ', 'ft.com': 'FT',
  'seekingalpha.com': 'Seeking Alpha', 'benzinga.com': 'Benzinga', 'investors.com': "Investor's Business Daily",
  'zacks.com': 'Zacks', 'thestreet.com': 'TheStreet', 'forbes.com': 'Forbes', 'businessinsider.com': 'Business Insider',
  'insidermonkey.com': 'Insider Monkey', 'investopedia.com': 'Investopedia', 'techcrunch.com': 'TechCrunch',
  'theverge.com': 'The Verge', 'fortune.com': 'Fortune', 'apnews.com': 'AP', 'nytimes.com': 'New York Times',
  'gurufocus.com': 'GuruFocus', 'simplywall.st': 'Simply Wall St', 'tipranks.com': 'TipRanks',
  'globenewswire.com': 'GlobeNewswire', 'prnewswire.com': 'PR Newswire', 'businesswire.com': 'Business Wire',
  'accessnewswire.com': 'ACCESS Newswire', 'investing.com': 'Investing.com', 'nasdaq.com': 'Nasdaq',
  'morningstar.com': 'Morningstar', 'tikr.com': 'TIKR', 'qz.com': 'Quartz', 'marketbeat.com': 'MarketBeat', 'kiplinger.com': 'Kiplinger', 'axios.com': 'Axios', 'theinformation.com': 'The Information'
};
export function publisherFor(href, fallback) {
  let host = '';
  try { host = new URL(href).hostname.replace(/^www\./, ''); } catch { return fallback; }
  if (PUBLISHERS[host]) return PUBLISHERS[host];
  const parent = host.split('.').slice(-2).join('.');
  return PUBLISHERS[parent] || parent || fallback;
}

// Module-level caches survive between calls on a warm function instance.
const names = new Map();      // symbol -> { name, at }
const resolved = new Map();   // finnhub link -> final article URL (successes only; misses are retried)
const NAME_TTL = 24 * 3600 * 1000;

async function companyName(symbol, apiKey, base) {
  const hit = names.get(symbol);
  if (hit && Date.now() - hit.at < NAME_TTL) return hit.name;
  let name = '';
  try {
    const res = await fetch(`${base}/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`,
      { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(3000) });
    if (res.ok) name = String((await res.json()).name || '');
  } catch {}
  names.set(symbol, { name, at: Date.now() });
  if (names.size > 2000) names.delete(names.keys().next().value);
  return name;
}

async function finalUrl(link) {
  if (resolved.has(link)) return resolved.get(link);
  let out = '';
  // Finnhub answers 429 to bursts of these lookups; one short pause and a retry.
  for (let attempt = 0; attempt < 2 && !out; attempt++) {
    try {
      const res = await fetch(link, { redirect: 'manual', signal: AbortSignal.timeout(2500) });
      const loc = res.headers.get('location') || '';
      if (/^https:\/\//.test(loc)) out = loc;
      else if (res.status === 429 && attempt === 0) await new Promise(r => setTimeout(r, 400));
      else break;
    } catch { break; }
  }
  if (out) {
    resolved.set(link, out);
    if (resolved.size > 5000) resolved.delete(resolved.keys().next().value);
  }
  return out;
}

// rows: Finnhub /company-news array. Returns the relevant stories, newest first, at most
// `limit` of them, with url and source pointing at the real publisher where it resolved.
export async function cleanNews(rows, symbol, { apiKey, base = 'https://finnhub.io/api/v1', limit = 20 } = {}) {
  if (!Array.isArray(rows)) return rows;
  const name = apiKey ? await companyName(symbol, apiKey, base) : '';
  const relevant = matcher(symbol, name);
  const kept = rows.filter(n => n && n.headline && relevant(n.headline + ' ' + (n.summary || '')))
    .sort((a, b) => (b.datetime || 0) - (a.datetime || 0)).slice(0, limit);
  // Two at a time (Finnhub refuses bursts of these lookups); stops after 5 seconds.
  const started = Date.now(), queue = kept.filter(n => /^https:\/\/finnhub\.io\/api\/news\?/.test(n.url || ''));
  await Promise.all(Array.from({ length: 2 }, async () => {
    while (queue.length && Date.now() - started < 5000) {
      const n = queue.shift(), url = await finalUrl(n.url);
      if (url) { n.url = url; n.source = publisherFor(url, n.source); }
    }
  }));
  return kept;
}
