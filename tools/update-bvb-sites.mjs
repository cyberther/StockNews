#!/usr/bin/env node
// Company websites of the Bucharest listings, for the filings reader (tools/filings-crawl.mjs).
// Reads each company's profile on Yahoo Finance (the website field) and writes
// tools/data/bvb-sites.json: { "SNP.RO": "https://www.omvpetrom.com", ... }.
// Sites already in the file are kept unless --all is given; fix a wrong one by hand there
// (a value of "" marks a company without a usable site).
//   node tools/update-bvb-sites.mjs [--all]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BVB_SHARES } from '../netlify/functions/_shared/market/bvb-symbols.js';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'data/bvb-sites.json');
const UA = 'Mozilla/5.0 (X11; Linux x86_64)';
let sites = {};
try { sites = JSON.parse(readFileSync(OUT, 'utf8')); } catch {}
const all = process.argv.includes('--all');

// Yahoo's profile API wants a session cookie and its crumb.
const r0 = await fetch('https://fc.yahoo.com', { headers: { 'user-agent': UA }, redirect: 'manual' }).catch(() => null);
const cookie = r0 ? (r0.headers.getSetCookie ? r0.headers.getSetCookie() : []).map(c => c.split(';')[0]).join('; ') : '';
const crumb = await (await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { 'user-agent': UA, cookie } })).text();
if (!crumb || crumb.length > 40) { console.error('no crumb'); process.exit(1); }

let found = 0, missing = [];
for (const [sym] of BVB_SHARES) {
  if (!all && sym in sites) continue;
  try {
    const res = await fetch(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=assetProfile&crumb=${encodeURIComponent(crumb)}`,
      { headers: { 'user-agent': UA, cookie } });
    const j = await res.json();
    const w = j && j.quoteSummary && j.quoteSummary.result && j.quoteSummary.result[0] && j.quoteSummary.result[0].assetProfile && j.quoteSummary.result[0].assetProfile.website;
    if (w && /^https?:\/\//.test(w)) { sites[sym] = new URL(w).origin.replace(/^http:/, 'https:'); found++; }
    else missing.push(sym);
  } catch { missing.push(sym); }
  await new Promise(r => setTimeout(r, 400));
}
mkdirSync(dirname(OUT), { recursive: true });
const sorted = Object.fromEntries(Object.keys(sites).sort().map(k => [k, sites[k]]));
writeFileSync(OUT, JSON.stringify(sorted, null, 1) + '\n');
console.log(`${found} found, ${missing.length} without a website: ${missing.join(' ')}`);
