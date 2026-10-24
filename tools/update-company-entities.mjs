#!/usr/bin/env node
// Builds config/company-entities.json: each BVB company's fiscal code (CUI), read from its own
// site (tools/data/bvb-sites.json) where it is labelled, then confirmed in ANAF's public register
// (the registered name must be the issuer's). The result is reviewed in a pull request like any
// other figures. Public contracts and state aid, and the Finance Ministry's yearly statements
// (tools/financials-mf.mjs), are tied to companies by this code only.
// Where the code is looked for, per site: the home page and the usual contact paths; then the
// site's own pages linked under names like contact, legal, terms, privacy, about, investors; then
// the first two pages of a few PDF reports linked from those pages (a current report to the
// market regulator names the issuer's fiscal code). A code is kept only when ANAF's register
// gives it the issuer's name, and only when exactly one such code is found.
//
//   node tools/update-company-entities.mjs [--only=TLV.RO,SNP.RO]
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { BVB_SHARES } from '../netlify/functions/_shared/market/bvb-symbols.js';
import { cuiValid, validateEntities, catalogTickers } from '../ingest/impact/schema.mjs';
import { fold } from '../ingest/policy/classify.mjs';

const UA = 'MarketPulse/1.0 (+https://www.marketpulse.ro)';
const LABEL = /(?:\bC\.?\s?U\.?\s?I\.?|\bC\.?\s?I\.?\s?F\.?|cod(?:ul)?\s+fiscal|cod(?:ul)?\s+unic\s+de\s+[iî]nregistrare(?:\s+(?:la\s+)?(?:ORC|ONRC|registrul\s+comer[tț]ului))?|cod(?:ul)?\s+de\s+identificare\s+fiscal[aă]|cod(?:ul)?\s+de\s+[iî]nregistrare\s+fiscal[aă]|fiscal\s+(?:code|identification\s+(?:code|number))|sole\s+registration\s+(?:code|number)|tax\s+(?:identification\s+)?(?:code|number)|VAT\s+(?:no|number|code))\.?\s*[:\-–]?\s*(?:RO\s*)?(\d{2,10})\b/gi;

// Codes written next to a label (CUI, CIF, cod fiscal, ...), with a valid check digit.
export function extractCuis(html) {
  const t = String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ');
  const out = [];
  for (const m of t.matchAll(LABEL)) if (cuiValid(m[1]) && !out.includes(m[1])) out.push(m[1]);
  return out;
}

const FORMS = new Set(['SA', 'SRL', 'SC', 'SN', 'SNGN', 'SNTGN', 'CN', 'CNTEE', 'SOCIETATEA', 'COMPANIA', 'NATIONALA', 'COMERCIALA', 'GRUP', 'GROUP', 'HOLDING', 'IFN', 'SSIF', 'SAI']);
const words = s => fold(s).toUpperCase().replace(/\./g, '').replace(/[^A-Z0-9]+/g, ' ').trim().split(/\s+/).filter(w => w && !FORMS.has(w));
// The ANAF name names the issuer: every word of the issuer's name is in it, or it is the
// issuer's name without at most one word (a town the catalog appends), never a namesake.
export function sameCompany(anafName, issuerName) {
  const a = words(anafName), b = words(issuerName);
  if (!a.length || !b.length) return false;
  if (a.join('') === b.join('')) return true;   // MED LIFE / MedLife
  if (b.every(w => a.includes(w))) return true;
  return a.every(w => b.includes(w)) && a.length >= b.length - 1 && a.some(w => w.length >= 4);
}

async function get(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return { url: r.url, html: (await r.text()).slice(0, 2_000_000) };
}
// The site's own pages likely to name its fiscal code, and its PDF reports, linked from a page.
const PAGE_WORDS = /contact|legal|termeni|terms|confiden|privacy|gdpr|despre|about|identificare|informatii|investitor|investor|actionar|shareholder|guvernanta|governance|raport|report|comunicat/i;
export function pageLinks(html, base) {
  const out = { pages: [], pdfs: [] };
  let host;
  try { host = new URL(base).host; } catch { return out; }
  for (const m of String(html || '').matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
    let u;
    try { u = new URL(m[1], base); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || u.host !== host) continue;
    const label = m[2].replace(/<[^>]+>/g, ' ') + ' ' + u.pathname;
    if (/\.pdf$/i.test(u.pathname)) { if (!out.pdfs.includes(u.href)) out.pdfs.push(u.href); }
    else if (PAGE_WORDS.test(label) && !out.pages.includes(u.href)) out.pages.push(u.href);
  }
  return out;
}
const execFileP = promisify(execFile);
// The first two pages of a PDF as text (pdftotext); '' when it can't be read.
async function pdfText(url) {
  const dir = mkdtempSync(join(tmpdir(), 'mp-cui-'));
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    if (!r.ok) return '';
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 15 * 1024 * 1024 || buf.slice(0, 4).toString() !== '%PDF') return '';
    writeFileSync(join(dir, 'f.pdf'), buf);
    const { stdout } = await execFileP('pdftotext', ['-f', '1', '-l', '2', '-enc', 'UTF-8', join(dir, 'f.pdf'), '-'], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  } catch { return ''; } finally { rmSync(dir, { recursive: true, force: true }); }
}
async function anaf(cuis, day) {
  const r = await fetch('https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva', { method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA }, body: JSON.stringify(cuis.map(c => ({ cui: Number(c), data: day }))),
    signal: AbortSignal.timeout(30000) });
  const j = await r.json();
  return new Map(((j && j.found) || []).map(f => [String(f.date_generale.cui), f.date_generale.denumire]));
}

async function main() {
  const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
  const sites = JSON.parse(readFileSync(new URL('./data/bvb-sites.json', import.meta.url), 'utf8'));
  const file = new URL('../config/company-entities.json', import.meta.url);
  const kept = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  const day = new Date().toISOString().slice(0, 10), found = [];
  const todo = BVB_SHARES.filter(([ticker]) => (!only.length || only.includes(ticker)) && sites[ticker] && !kept.some(r => r.ticker === ticker && r.role === 'issuer'));
  // Eight sites at a time; per site, the home page first, then the usual contact paths, then the
  // pages it links under contact / legal / investors..., then a few of its PDF reports. Every
  // code found is kept as a candidate; ANAF decides below.
  const one = async ([ticker, name]) => {
    const base = sites[ticker].replace(/\/$/, ''), seen = new Set(), cands = new Map(), links = { pages: [], pdfs: [] };
    const look = (url, text) => extractCuis(text).forEach(c => { if (!cands.has(c)) cands.set(c, url); });
    const visit = async url => {
      if (seen.has(url) || seen.size >= 14) return;
      seen.add(url);
      try {
        const page = await get(url);
        look(page.url, page.html);
        const l = pageLinks(page.html, page.url);
        l.pages.forEach(u => { if (!links.pages.includes(u)) links.pages.push(u); });
        l.pdfs.forEach(u => { if (!links.pdfs.includes(u)) links.pdfs.push(u); });
      } catch (e) { /* next page */ }
    };
    for (const path of ['', '/contact', '/despre-noi', '/investitori', '/en/contact']) await visit(base + path);
    for (const u of links.pages.slice(0, 8)) { if (cands.size) break; await visit(u); }
    for (const u of links.pdfs.slice(0, 3)) { if (cands.size) break; look(u, await pdfText(u)); }
    if (cands.size) found.push({ ticker, issuer: name, cuis: [...cands.keys()], sources: Object.fromEntries(cands) });
  };
  for (let i = 0; i < todo.length; i += 8) { await Promise.all(todo.slice(i, i + 8).map(one)); console.log('sites', Math.min(i + 8, todo.length) + '/' + todo.length, 'found', found.length); }
  const all = [...new Set(found.flatMap(f => f.cuis))];
  const names = new Map();
  for (let i = 0; i < all.length; i += 100) { (await anaf(all.slice(i, i + 100), day)).forEach((v, k) => names.set(k, v)); await new Promise(r => setTimeout(r, 1500)); }
  const rows = [...kept];
  for (const f of found) {
    // Exactly one code with the issuer's name in ANAF's register, or none is kept.
    const ok = f.cuis.filter(c => names.has(c) && sameCompany(names.get(c), f.issuer));
    const cui = ok.length === 1 ? ok[0] : null;
    if (!cui || rows.some(r => r.cui === cui)) { console.log('skip', f.ticker, f.issuer, '|', f.cuis.map(c => c + '=' + (names.get(c) || '?')).join(' ')); continue; }
    rows.push({ ticker: f.ticker, cui, name: names.get(cui), role: 'issuer', source_url: f.sources[cui].replace(/^http:/, 'https:'), verified_on: day });
    console.log('kept', f.ticker, cui, names.get(cui));
  }
  rows.sort((a, b) => a.ticker.localeCompare(b.ticker) || a.role.localeCompare(b.role));
  const v = validateEntities(rows, { tickers: catalogTickers() });
  if (!v.ok) { console.error(v.errors.join('\n')); process.exit(1); }
  writeFileSync(file, JSON.stringify(rows, null, 1) + '\n');
  console.log(rows.length + ' companies');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
