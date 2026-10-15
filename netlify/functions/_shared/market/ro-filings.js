// Regulatory filings and management dealings of Bucharest listings (.RO), without bvb.ro.
//
// Two sources:
//   - the issuer's own investor pages, for the companies whose site can be read by a
//     program (robots.txt allows it): an RSS feed, or the sitemap's investor-news pages;
//   - the Romanian press (ro-news.js), whose stories about a company are kept when they
//     report a manager's share dealing or an official report.
// Every row links to the publisher's page; nothing beyond its title and date is used.
import { parseRss, companyNews } from './ro-news.js';

// feed: RSS whose investor items are told apart from marketing ones by REPORT/INSIDER.
// sitemap (one or several) + path: every page under that path is an investor announcement;
// its title is read from the page (og:title). insider: the path of management dealings.
export const ISSUERS = {
  'SNP.RO': { source: 'OMV Petrom', sitemap: 'https://www.omvpetrom.com/sitemap.xml', path: /\/ro\/investitori\/noutati-si-evenimente\/\d{4}\/[^/]+$/, all: true },
  'ATB.RO': { source: 'Antibiotice', sitemap: ['comunicate', 'adunari', 'rapoarte', 'tranzactii'].map(s => `https://www.antibiotice.ro/${s}-sitemap.xml`),
    path: /\/(comunicate|adunari|rapoarte|tranzactii)\/[^/]+\/$/, insider: /\/tranzactii\//, all: true },
  'EL.RO': { source: 'Electrica', feed: 'https://www.electrica.ro/feed/' },
  'SFG.RO': { source: 'Sphera Franchise Group', feed: 'https://www.spheragroup.com/feed/' },
  'BNET.RO': { source: 'Bittnet', feed: 'https://investors.bittnet.ro/feed/', all: true },
  'ONE.RO': { source: 'One United Properties', feed: 'https://www.one.ro/feed/' },
  'TRP.RO': { source: 'TeraPlast', sitemap: 'https://www.teraplast.ro/comunicat-sitemap.xml', path: /\/comunicat\/[^/]+\/?$/ }
};

const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[șş]/gi, 's').replace(/[țţ]/gi, 't').toLowerCase();
// A manager's or director's dealing in the company's shares (MAR art. 19).
const INSIDER = /\bpdmr\b|\bart(?:\.|icolul)?\s*19\b|responsabilitati de conducere|tranzactii(?:le)? (?:ale |efectuate de )?(?:management|managementului|conducerii|persoanelor)|managers?'? transactions|directors?'? dealings/;
// An official report: current report, results, general meeting, dividend, holdings
// threshold, buy-back, offer, coupon, financial calendar.
const REPORT = /raport(?:ul)? curent|rapoart(?:e|ele) curente|ad.?hoc|rezultat(?:e|ele) (?:financiare|preliminare|trimestriale|semestriale|anuale)|\braport(?:ul)? (?:s1|h1|t[1-4]|q[1-4]|trimestrial|semestrial|anual)|trading update|convoca(?:re|rea)|adunar(?:ea|ii|i) general|\bag[oe]?a\b|hotarar(?:ea|ile|i) (?:ag|adunar)|dividend|cupon|notificare (?:prag|detinere)|prag(?:uri)? de detinere|detineri\/vot|oferta publica|rascumparare|calendar(?:ul)? financiar|teleconferint|estimari(?:lor)? privind rezultat|buget(?:ul)? de venituri|majorare (?:de |a )?capital|auditor/;
// The press: a named manager bought or sold shares ("Directorul general al X a cumpărat
// acțiuni"), or the company published a current report.
const PRESS_ROLE = /\b(?:director|directorul|ceo|cfo|presedinte|presedintele|administrator|administratorul|membru|membrul|membrii|fondator|fondatorul|conducerea|sef|seful|managerii|managementul|actionarul majoritar)\b/;
const PRESS_DEAL = /\b(?:a|au) (?:cumparat|vandut|achizitionat|instrainat)\b|\b(?:cumpara|vinde)\b/;
const PRESS_REPORT = /raport(?:ul)? curent|potrivit unui raport (?:transmis|publicat)|notificare (?:privind|de) detinere/;

export function classify(title, opts = {}) {
  const f = fold(title);
  if (INSIDER.test(f)) return 'insider';
  if (opts.press) {
    if (/\bactiuni\b/.test(f) && PRESS_ROLE.test(f) && PRESS_DEAL.test(f)) return 'insider';
    return PRESS_REPORT.test(f) ? 'filing' : null;
  }
  if (REPORT.test(f)) return 'filing';
  return opts.all ? 'filing' : null;
}
// "buy" / "sell" when a dealing's title says which.
export function dealing(title) {
  const f = fold(title);
  if (/\b(?:a|au) (?:cumparat|achizitionat)\b|\bcumpara\b|\bachizitie\b|\bpurchase\b|\bbought\b/.test(f)) return 'buy';
  if (/\b(?:a|au) (?:vandut|instrainat)\b|\bvinde\b|\bvanzare\b|\bsale\b|\bsold\b/.test(f)) return 'sell';
  return '';
}

const UA = 'Mozilla/5.0 (StockNews filings reader)';
const MAX_BYTES = 4 * 1024 * 1024;
const SOURCE_TTL = 60 * 60 * 1000;
async function getText(url, accept) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: accept || 'text/html, application/xml' }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(url + ' ' + res.status);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error(url + ' too large');
  return text;
}
// Sitemap (or sitemap index, one level down) -> [{ url, at }] under `path`.
async function sitemapPages(url, path) {
  const xml = await getText(url, 'application/xml, text/xml');
  if (/<sitemapindex/i.test(xml)) {
    const subs = [...xml.matchAll(/<sitemap>[\s\S]*?<loc>\s*([^<\s]+)/g)].map(m => m[1].replace(/&amp;/g, '&'));
    const out = [];
    for (const s of subs.slice(0, 40)) { try { out.push(...await sitemapPages(s, path)); } catch {} }
    return out;
  }
  const out = [], seen = new Set();
  for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = /<loc>\s*([^<\s]+)/.exec(m[1]), mod = /<lastmod>\s*([^<\s]+)/.exec(m[1]);
    if (!loc || !mod) continue;
    const u = loc[1].replace(/&amp;/g, '&'), at = Date.parse(mod[1]);
    if (!/^https:\/\//.test(u) || !path.test(u) || !Number.isFinite(at) || seen.has(u)) continue;
    seen.add(u); out.push({ url: u, at: Math.floor(at / 1000) });
  }
  return out;
}
const titles = new Map(); // page url -> title
async function pageTitle(url, source) {
  if (titles.has(url)) return titles.get(url);
  const html = await getText(url);
  const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i.exec(html) || /<title[^>]*>([^<]+)/i.exec(html);
  const [item] = parseRss(`<item><title>${og ? og[1] : ''}</title><link>${url}</link><pubDate>${new Date().toUTCString()}</pubDate></item>`, source);
  let t = item ? item.headline : '';
  t = t.replace(new RegExp(`\\s*[|\\-–]\\s*(?:${source}|OMVPetrom\\.com|${source.split(' ')[0]})\\s*$`, 'i'), '').trim();
  if (titles.size > 2000) titles.clear();
  titles.set(url, t);
  return t;
}

const sourceCache = new Map(); // symbol -> { at, rows }
async function issuerRows(symbol, sinceSec) {
  const cfg = ISSUERS[symbol];
  if (!cfg) return [];
  const hit = sourceCache.get(symbol);
  if (hit && Date.now() - hit.at < SOURCE_TTL) return hit.rows.filter(r => r.datetime >= sinceSec);
  let rows = [];
  if (cfg.feed) {
    const xml = await getText(cfg.feed, 'application/rss+xml, application/xml, text/xml');
    rows = parseRss(xml, cfg.source).map(x => ({ datetime: x.datetime, title: x.headline, url: x.url }));
  } else {
    const maps = [].concat(cfg.sitemap), pages = [];
    for (const m of maps) { try { pages.push(...await sitemapPages(m, cfg.path)); } catch (e) { if (maps.length === 1) throw e; } }
    // Titles of the last 45 days' pages only (the window asked for is at most 30 days).
    const cut = Math.floor(Date.now() / 1000) - 45 * 86400;
    const recent = pages.filter(p => p.at >= cut).sort((a, b) => b.at - a.at)
      .filter((p, i, a) => a.findIndex(q => q.url === p.url) === i).slice(0, 12);
    const got = await Promise.all(recent.map(p => pageTitle(p.url, cfg.source).then(t => t && { datetime: p.at, title: t, url: p.url }, () => null)));
    rows = got.filter(Boolean);
  }
  rows = rows.map(r => ({ ...r, type: cfg.insider && cfg.insider.test(r.url) ? 'insider' : classify(r.title, { all: cfg.all }),
    source: cfg.source, official: true })).filter(r => r.type);
  sourceCache.set(symbol, { at: Date.now(), rows });
  return rows.filter(r => r.datetime >= sinceSec);
}

// The last `days` days of filings and dealings for one .RO company, newest first:
// [{ type: 'insider'|'filing', datetime, title, url, source, official, act }].
// coverage: 'issuer' when the company's own pages were read, else 'press'.
export async function roFilings(symbol, days, log) {
  const since = Math.floor(Date.now() / 1000) - (days || 30) * 86400;
  let own = [];
  try { own = await issuerRows(symbol, since); }
  catch (e) { if (log) log({ evt: 'market.upstream', provider: 'rofilings', cap: 'filings', status: 'error', symbol }); }
  const from = new Date(since * 1000).toISOString().slice(0, 10), to = new Date().toISOString().slice(0, 10);
  let press = [];
  try {
    press = (await companyNews(symbol, from, to, log))
      .map(x => ({ datetime: x.datetime, title: x.headline, url: x.url, source: x.source, official: false, type: classify(x.headline, { press: true }) }))
      .filter(r => r.type);
  } catch {}
  const seen = new Set(own.map(r => fold(r.title)));
  const rows = own.concat(press.filter(r => !seen.has(fold(r.title))))
    .map(r => ({ ...r, act: r.type === 'insider' ? dealing(r.title) : '' }))
    .sort((a, b) => b.datetime - a.datetime).slice(0, 20);
  return { items: rows, coverage: ISSUERS[symbol] ? 'issuer' : 'press' };
}

export function resetRoFilingsForTests() { sourceCache.clear(); titles.clear(); }
