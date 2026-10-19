#!/usr/bin/env node
// Builds config/company-entities.json: each BVB company's fiscal code (CUI), read from its own
// site (tools/data/bvb-sites.json) where it is labelled, then confirmed in ANAF's public register
// (the registered name must be the issuer's). The result is reviewed in a pull request like any
// other figures. Public contracts and state aid are tied to companies by this code only.
//
//   node tools/update-company-entities.mjs [--only=TLV.RO,SNP.RO]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BVB_SHARES } from '../netlify/functions/_shared/market/bvb-symbols.js';
import { cuiValid, validateEntities, catalogTickers } from '../ingest/impact/schema.mjs';
import { fold } from '../ingest/policy/classify.mjs';

const UA = 'MarketPulse/1.0 (+https://www.marketpulse.ro)';
const LABEL = /(?:\bC\.?\s?U\.?\s?I\.?|\bC\.?\s?I\.?\s?F\.?|cod(?:ul)?\s+fiscal|cod(?:ul)?\s+unic\s+de\s+[iî]nregistrare|cod(?:ul)?\s+de\s+identificare\s+fiscal[aă]|fiscal\s+code|VAT\s+(?:no|number|code))\.?\s*[:\-–]?\s*(?:RO\s*)?(\d{2,10})\b/gi;

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
  // Eight sites at a time; per site, the home page first, then the usual contact pages.
  const one = async ([ticker, name]) => {
    for (const path of ['', '/contact', '/despre-noi', '/investitori', '/en/contact']) {
      try {
        const page = await get(sites[ticker].replace(/\/$/, '') + path);
        const c = extractCuis(page.html);
        if (c.length) { found.push({ ticker, issuer: name, cuis: c, source_url: page.url }); return; }
      } catch (e) { /* next page */ }
    }
  };
  for (let i = 0; i < todo.length; i += 8) { await Promise.all(todo.slice(i, i + 8).map(one)); console.log('sites', Math.min(i + 8, todo.length) + '/' + todo.length, 'found', found.length); }
  const all = [...new Set(found.flatMap(f => f.cuis))];
  const names = new Map();
  for (let i = 0; i < all.length; i += 100) { (await anaf(all.slice(i, i + 100), day)).forEach((v, k) => names.set(k, v)); await new Promise(r => setTimeout(r, 1500)); }
  const rows = [...kept];
  for (const f of found) {
    const cui = f.cuis.find(c => names.has(c) && sameCompany(names.get(c), f.issuer));
    if (!cui || rows.some(r => r.cui === cui)) { console.log('skip', f.ticker, f.cuis.map(c => c + '=' + (names.get(c) || '?')).join(' ')); continue; }
    rows.push({ ticker: f.ticker, cui, name: names.get(cui), role: 'issuer', source_url: f.source_url.replace(/^http:/, 'https:'), verified_on: day });
  }
  rows.sort((a, b) => a.ticker.localeCompare(b.ticker) || a.role.localeCompare(b.role));
  const v = validateEntities(rows, { tickers: catalogTickers() });
  if (!v.ok) { console.error(v.errors.join('\n')); process.exit(1); }
  writeFileSync(file, JSON.stringify(rows, null, 1) + '\n');
  console.log(rows.length + ' companies');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
