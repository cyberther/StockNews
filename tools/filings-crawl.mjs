#!/usr/bin/env node
// The filings reader: every Bucharest listing's investor announcements, from its own website
// (never bvb.ro) and from the Romanian press, stored in Supabase (supabase/filings.sql).
//
// For each company (tools/data/bvb-sites.json gives its site), where robots.txt allows it:
//   - its RSS feed (/feed/), its sitemap's investor pages, and the documents and pages
//     linked from its investor section (found from the home page, two clicks deep);
//   - each link becomes a row: title, day, link and kind (insider, holding, dividend, agm,
//     results, report). Pages already seen are not read again (~/.cache/market-pulse).
// The figures in the documents are read later by tools/summarize-batch.mjs.
//
//   node tools/filings-crawl.mjs                 every company, saved
//   node tools/filings-crawl.mjs SNP.RO TLV.RO   those only
//   node tools/filings-crawl.mjs SNP.RO --dry    print what would be saved
// Settings: ~/.config/market-pulse/summarizer.env (SUPABASE_URL, SUPABASE_ANON_KEY, SUMMARY_SECRET).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { httpGet, robotsAllow } from './summarize-batch.mjs';
import { classifyKind, classifyPress, looksLikeFiling, stripSiteName, publishedDay, linksIn, linkTitle, isDocument, isEnglishCopy, isIrLink,
  sameSite, offLimits, decodeText, fold } from './filings-lib.mjs';
import { BVB_SHARES } from '../netlify/functions/_shared/market/bvb-symbols.js';
import { ISSUERS } from '../netlify/functions/_shared/market/ro-filings.js';
import { parseRss, marketNews } from '../netlify/functions/_shared/market/ro-news.js';

const UA = 'Mozilla/5.0 (compatible; MarketPulseFilings/1.0; +https://github.com/cyberther/StockNews)';
const AGENT = 'marketpulsefilings';
const MAX_PAGES = 24;          // HTML pages read per company and run (besides robots and sitemaps)
const MAX_TITLES = 30;         // sitemap pages whose title is read per company and run
const PAUSE_MS = 300;          // between two requests to the same site
const CONCURRENCY = 4;
const ENV_FILE = join(homedir(), '.config/market-pulse/summarizer.env');
const SEEN_FILE = join(homedir(), '.cache/market-pulse/filings-seen.json');
const SITES_FILE = join(dirname(fileURLToPath(import.meta.url)), 'data/bvb-sites.json');

try {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {}
const cfg = { supabaseUrl: (process.env.SUPABASE_URL || '').replace(/\/$/, ''), anonKey: process.env.SUPABASE_ANON_KEY || '', secret: process.env.SUMMARY_SECRET || '' };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);

let seen = {};
try { seen = JSON.parse(readFileSync(SEEN_FILE, 'utf8')); } catch {}

// ------------------------------------------------------------------ one site
const robotsTxt = new Map();
async function robotsFor(url) {
  const u = new URL(url);
  if (!robotsTxt.has(u.host)) {
    let txt = '';
    try { const r = await httpGet(`https://${u.host}/robots.txt`, { timeout: 10000, accept: 'text/plain', ua: UA }); if (r.status === 200 && !/<html/i.test(r.body)) txt = r.body; } catch {}
    robotsTxt.set(u.host, txt);
  }
  return robotsTxt.get(u.host);
}
export async function allowed(url) {
  if (offLimits(url)) return false;
  return robotsAllow(await robotsFor(url), new URL(url).pathname + new URL(url).search, AGENT);
}
async function get(url, accept) {
  if (!(await allowed(url))) return null;
  await sleep(PAUSE_MS);
  try {
    const r = await httpGet(url, { timeout: 15000, accept: accept || 'text/html', ua: UA, maxBytes: 6 * 1024 * 1024 });
    return r.status === 200 ? r : null;
  } catch { return null; }
}

// Sitemap (or index, one level down, skipping the product and media lists) -> [{ url, at }].
const SKIP_MAP = /product|produs|medicament|categor|tag|author|image|video|attachment|media|slider|job|cariere|location|portfolio|proiect/i;
async function sitemapUrls(url, depth = 0) {
  const r = await get(url, 'application/xml, text/xml');
  if (!r || !/<(urlset|sitemapindex)/i.test(r.body)) return [];
  if (/<sitemapindex/i.test(r.body)) {
    if (depth) return [];
    const subs = [...r.body.matchAll(/<sitemap>[\s\S]*?<loc>\s*([^<\s]+)/g)].map(m => m[1].replace(/&amp;/g, '&')).filter(s => !SKIP_MAP.test(s)).slice(0, 30);
    const out = [];
    for (const s of subs) out.push(...await sitemapUrls(s, 1));
    return out;
  }
  return [...r.body.matchAll(/<url>([\s\S]*?)<\/url>/g)].map(m => {
    const loc = /<loc>\s*([^<\s]+)/.exec(m[1]), mod = /<lastmod>\s*([^<\s]+)/.exec(m[1]);
    return loc ? { url: loc[1].replace(/&amp;/g, '&'), at: mod ? mod[1].slice(0, 10) : null } : null;
  }).filter(Boolean);
}
const pageTitle = html => decodeText((/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i.exec(html) || /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html) || /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || '');
const pageDate = html => ((/<meta[^>]+property=["']article:published_time["'][^>]+content=["'](\d{4}-\d{2}-\d{2})/i.exec(html) || /"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2})/.exec(html) || [])[1]) || null;

export async function crawlCompany(ticker, site, source) {
  const found = new Map(), dupes = new Set();
  let reads = 0;
  const add = (url, title, day, viaPath) => {
    if (!/^https:\/\//.test(url) || offLimits(url) || found.has(url) || isEnglishCopy(url, title)) return;
    const t = String(title || '').replace(/\s+/g, ' ').trim();
    if (t.length < 4) return;
    const kind = classifyKind(t, url);
    if (!kind) return;
    // The same announcement as a page and as its PDF: once.
    const key = fold(t) + '|' + (day || '');
    if (dupes.has(key)) return;
    dupes.add(key);
    found.set(url, { ticker, url, title: t.slice(0, 400), published_at: day && day <= today() ? day + 'T12:00:00Z' : null, kind, source, official: true });
  };
  const hint = ISSUERS[ticker] || {};
  const home = site ? site.replace(/\/$/, '') : '';
  if (!home && !hint.feed && !hint.sitemap) return { rows: [], status: 'none' };
  if (home && !(await allowed(home + '/'))) return { rows: [], status: 'robots' };
  // A site that turns programs away (403, a bot wall) is left alone.
  if (home) {
    let st = 0;
    try { st = (await httpGet(home + '/', { timeout: 15000, ua: UA })).status; } catch {}
    if (st === 401 || st === 403 || st === 429 || st === 0) return { rows: [], status: st ? 'blocked' : 'unreachable' };
  }

  // 1. RSS feed.
  for (const f of [hint.feed, home && home + '/feed/'].filter(Boolean)) {
    const r = await get(f, 'application/rss+xml, application/xml');
    if (!r || !/<item[\s>]/i.test(r.body)) continue;
    for (const x of parseRss(r.body, source)) add(x.url, x.headline, new Date(x.datetime * 1000).toISOString().slice(0, 10));
    break;
  }
  // 2. Sitemap: investor pages, by their address; their titles are read (newest first).
  const irPages = [];
  const maps = hint.sitemap ? [].concat(hint.sitemap) : [];
  if (home && !maps.length) {
    const sm = [...(await robotsFor(home + '/')).matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)].map(m => m[1]);
    maps.push(...(sm.length ? sm.slice(0, 3) : [home + '/sitemap_index.xml', home + '/sitemap.xml', home + '/wp-sitemap.xml']));
  }
  let urls = [];
  for (const m of maps) { urls = urls.concat(await sitemapUrls(m)); if (urls.length && !hint.sitemap) break; }
  const pathOk = u => hint.path ? hint.path.test(u) : (looksLikeFiling(u) || isIrLink({ text: '', url: u }));
  const cand = urls.filter(x => x.url.startsWith('https://') && pathOk(x.url) && !isEnglishCopy(x.url))
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  let titles = 0;
  for (const x of cand) {
    if (isDocument(x.url)) { add(x.url, linkTitleFromUrl(x.url), x.at, true); continue; }
    if (!looksLikeFiling(x.url) && !hint.path) { if (irPages.length < 12) irPages.push(x.url); continue; }
    if (seen[x.url]) { add(x.url, seen[x.url].t, seen[x.url].d || x.at); continue; }
    if (titles >= MAX_TITLES) continue;
    titles++;
    const r = await get(x.url);
    if (!r) continue;
    const t = stripSiteName(pageTitle(r.body)), d = pageDate(r.body) || publishedDay(t, x.url) || x.at;
    seen[x.url] = { t, d };
    add(x.url, t, d);
  }
  // 3. The investor section: from the home page, two clicks deep.
  const queue = [], visited = new Set();
  if (home) queue.push([home + '/', 0]);
  irPages.forEach(u => queue.push([u, 1]));
  while (queue.length && reads < MAX_PAGES) {
    const [url, depth] = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);
    const r = await get(url);
    reads++;
    if (!r || !/html/i.test(r.type)) continue;
    for (const l of linksIn(r.body, r.url)) {
      if (offLimits(l.url)) continue;
      const title = linkTitle(l);
      if (isDocument(l.url)) { add(l.url, title, publishedDay(l.block + ' ' + l.text, l.url), depth > 0); continue; }
      if (!sameSite(l.url, home || url)) continue;
      const clean = l.url.split('#')[0];
      // A page is an announcement when its link is dated; an undated one is a section to open.
      const day = publishedDay(l.block, clean);
      if (depth > 0 && day && classifyKind(l.text) && l.text.length >= 12) add(clean, title, day);
      if (depth < 2 && !visited.has(clean) && (isIrLink(l) || (depth > 0 && classifyKind(l.text)))) queue.push([clean, depth + 1]);
    }
  }
  return { rows: [...found.values()], status: 'ok' };
}
const linkTitleFromUrl = url => linkTitle({ text: '', block: '', url });

// ------------------------------------------------------------------ the press
async function pressRows() {
  const rows = [];
  for (const x of await marketNews(400)) {
    const kind = classifyPress(x.headline);
    if (kind) rows.push({ ticker: x.related, url: x.url, title: x.headline, published_at: new Date(x.datetime * 1000).toISOString(), kind, source: x.source, official: false });
  }
  return rows;
}

// ------------------------------------------------------------------ run
async function rpc(fn, body) {
  const res = await fetch(`${cfg.supabaseUrl}/rest/v1/rpc/${fn}`, { method: 'POST',
    headers: { apikey: cfg.anonKey, authorization: 'Bearer ' + cfg.anonKey, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${fn}: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function main() {
  const args = process.argv.slice(2), dry = args.includes('--dry');
  const only = args.filter(a => /\.RO$/i.test(a)).map(a => a.toUpperCase());
  if (!dry && (!cfg.supabaseUrl || !cfg.anonKey || cfg.secret.length < 32)) { log('not configured:', ENV_FILE); process.exitCode = 2; return; }
  let sites = {};
  try { sites = JSON.parse(readFileSync(SITES_FILE, 'utf8')); } catch {}
  const names = Object.fromEntries(BVB_SHARES.map(r => [r[0], r[1]]));
  const tickers = only.length ? only : BVB_SHARES.map(r => r[0]);
  const queue = tickers.slice(), results = [];
  const t0 = Date.now();
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const t = queue.shift(), site = sites[t] || '', source = (ISSUERS[t] && ISSUERS[t].source) || names[t] || t.replace(/\.RO$/, '');
      try {
        const r = await crawlCompany(t, site, source);
        results.push({ ticker: t, site, ...r });
        log(t, r.status, r.rows.length, site);
      } catch (e) { results.push({ ticker: t, site, rows: [], status: 'unreachable' }); log(t, 'error', String(e.message || e)); }
    }
  }));
  let press = [];
  if (!only.length || only.length > 0) { try { press = (await pressRows()).filter(r => !only.length || only.includes(r.ticker)); } catch (e) { log('press:', e.message); } }
  const rows = results.flatMap(r => r.rows).concat(press);
  try { mkdirSync(dirname(SEEN_FILE), { recursive: true }); writeFileSync(SEEN_FILE, JSON.stringify(seen)); } catch {}
  if (dry) {
    rows.sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)))
      .forEach(r => console.log((r.published_at || '----------').slice(0, 10), r.ticker.padEnd(8), r.kind.padEnd(8), r.official ? ' ' : 'P', r.title.slice(0, 90), '|', r.url.slice(0, 90)));
    log(`${rows.length} rows (dry run), ${Math.round((Date.now() - t0) / 1000)}s`);
    return;
  }
  const sitesInfo = results.map(r => ({ ticker: r.ticker, site: r.site, status: r.status, found: r.rows.length }));
  let saved = 0;
  for (let i = 0; i < Math.max(rows.length, 1); i += 300) {
    saved += await rpc('filings_upsert', { p_secret: cfg.secret, p_rows: rows.slice(i, i + 300), p_sites: i === 0 ? sitesInfo : [] }) || 0;
  }
  log(`done: ${rows.length} found, ${saved} saved or updated, ${results.filter(r => r.rows.length).length} of ${results.length} companies, ${Math.round((Date.now() - t0) / 1000)}s`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { log('error', e.message); process.exitCode = 1; }).finally(() => process.exit());
