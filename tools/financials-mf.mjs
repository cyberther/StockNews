#!/usr/bin/env node
// Bucharest listings' yearly statements for the Financials tab (supabase/financials.sql, source
// 'mf'), from the Finance Ministry's open data on data.gov.ro ("Situațiile financiare <year>",
// CC BY 4.0: "Sursa: Ministerul Finanțelor / data.gov.ro"). Run on the owner's PC (data.gov.ro
// does not answer GitHub's runners): tools/systemd/market-pulse-financials-mf.*.
//
//   node tools/financials-mf.mjs [--dry] [--years 5] [TICKER ...]
//
// The companies: the issuers in config/company-entities.json (fiscal codes confirmed in ANAF's
// register). The last five years published, individual statements, in lei. data.gov.ro's
// robots.txt asks for 10 s between requests and keeps /api/ off limits, so the dataset pages and
// files are read directly, one at a time. Files already read are remembered (by address) in
// ~/.cache/market-pulse/mf/, so a run downloads only what is new.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MF_KINDS, mfColumns, mfFigures } from './financials-lib.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENV_FILE = join(homedir(), '.config/market-pulse/summarizer.env');
const CACHE = join(homedir(), '.cache/market-pulse/mf');
const SITE = 'https://data.gov.ro';
const UA = 'MarketPulse/1.0 (+https://www.marketpulse.ro)';
try {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {}
const cfg = { supabaseUrl: (process.env.SUPABASE_URL || '').replace(/\/$/, ''), anonKey: process.env.SUPABASE_ANON_KEY || '', secret: process.env.SUMMARY_SECRET || '' };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let last = 0;
async function get(url, timeout = 300000) {
  const wait = last + 10500 - Date.now();
  if (wait > 0) await sleep(wait);
  last = Date.now();
  const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(timeout) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(url + ': ' + res.status);
  return Buffer.from(await res.arrayBuffer());
}
const text = buf => new TextDecoder('windows-1250').decode(buf);

// The ministry's datasets by year, from one search page (a dataset that does not exist is not
// asked for: data.gov.ro leaves such a request hanging). An updated one ("_actualizat") wins.
async function datasets() {
  const page = await get(`${SITE}/dataset?q=situatii+financiare&sort=metadata_modified+desc`, 120000);
  const out = {};
  for (const m of text(page || Buffer.alloc(0)).matchAll(/href="\/dataset\/(situatii_financiare_?(\d{4})(_actualizat)?)"/g)) {
    const y = +m[2];
    if (!out[y] || m[3]) out[y] = m[1];
  }
  return out;
}
// A year's dataset page -> the files of each kind: { ir: { data, spec }, ... }.
async function yearFiles(slug) {
  const page = await get(`${SITE}/dataset/${slug}`, 120000);
  if (!page) return null;
  const links = [...new Set([...text(page).matchAll(/href="(https:\/\/data\.gov\.ro\/dataset\/[^"]+\/download\/[^"]+\.(?:txt|csv))"/gi)].map(m => m[1]))];
  const out = {};
  for (const [key, re] of MF_KINDS) {
    const mine = links.filter(u => re.test(u.split('/').pop()));
    const data = mine.find(u => /\.txt$/i.test(u)), spec = mine.find(u => /\.csv$/i.test(u));
    if (data && spec) out[key] = { data, spec };
  }
  return Object.keys(out).length ? { slug, files: out } : null;
}

// One file's lines for the companies wanted -> { cui: figures }, remembered by address.
async function readFile(kind, data, spec, cuis, cuiKey) {
  mkdirSync(CACHE, { recursive: true });
  const id = createHash('sha1').update(data + '|' + cuiKey).digest('hex').slice(0, 20), file = join(CACHE, id + '.json');
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch {}
  const columns = mfColumns(text(await get(spec) || Buffer.alloc(0)));
  const body = await get(data);
  if (!body) return {};
  const lines = text(body).split(/\r?\n/), header = lines[0].split(',').map(h => h.trim());
  const out = {};
  for (const line of lines.slice(1)) {
    const cui = line.slice(0, line.indexOf(','));
    if (!cuis.has(cui)) continue;
    const d = mfFigures(columns, header, line.split(','));
    if (Object.keys(d).length >= 2) out[cui] = d;
  }
  writeFileSync(file, JSON.stringify(out));
  log(`  ${kind}: ${Object.keys(out).length} of ours in ${lines.length - 1} filers`);
  return out;
}

async function rpc(fn, body) {
  const res = await fetch(`${cfg.supabaseUrl}/rest/v1/rpc/${fn}`, { method: 'POST',
    headers: { apikey: cfg.anonKey, authorization: 'Bearer ' + cfg.anonKey, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const t = await res.text();
  if (!res.ok) throw new Error(`${fn}: ${res.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}

async function main() {
  const args = process.argv.slice(2), dry = args.includes('--dry');
  const yi = args.indexOf('--years'), years = yi >= 0 ? +args[yi + 1] : 5;
  const only = args.filter((a, i) => /\.RO$/i.test(a) && args[i - 1] !== '--years').map(a => a.toUpperCase());
  if (!dry && (!cfg.supabaseUrl || !cfg.anonKey || !cfg.secret)) { log('not configured: SUPABASE_URL, SUPABASE_ANON_KEY, SUMMARY_SECRET'); process.exitCode = 2; return; }
  const issuers = JSON.parse(readFileSync(join(ROOT, 'config/company-entities.json'), 'utf8'))
    .filter(e => e.role === 'issuer' && /^\d{2,10}$/.test(e.cui) && (!only.length || only.includes(e.ticker)));
  const cuis = new Map(issuers.map(e => [e.cui, e.ticker]));
  const cuiKey = createHash('sha1').update([...cuis.keys()].sort().join(',')).digest('hex').slice(0, 12);
  const byTicker = new Map();
  // The last `years` years published.
  const all = await datasets(), list = Object.keys(all).map(Number).sort((a, b) => b - a).slice(0, years);
  if (!list.length) throw new Error('no "Situațiile financiare" datasets found on data.gov.ro');
  for (const y of list) {
    const set = await yearFiles(all[y]);
    if (!set) { log(y, 'no files'); continue; }
    log(y, set.slug, Object.keys(set.files).join(' '));
    const seen = new Set();
    for (const [kind] of MF_KINDS) {
      const f = set.files[kind];
      if (!f) continue;
      const figures = await readFile(kind, f.data, f.spec, cuis, cuiKey);
      // A company in two files keeps the first (MF_KINDS' order: IFRS, banks, funds, ... others).
      for (const [cui, data] of Object.entries(figures)) {
        if (seen.has(cui)) continue;
        seen.add(cui);
        const t = cuis.get(cui);
        (byTicker.get(t) || byTicker.set(t, []).get(t)).push({ period: 'A', period_end: y + '-12-31', label: String(y), currency: 'RON', consolidated: false, data });
      }
    }
  }
  let ok = 0;
  for (const e of issuers) {
    const rows = (byTicker.get(e.ticker) || []).sort((a, b) => b.period_end.localeCompare(a.period_end));
    const status = rows.length ? 'ok' : 'none';
    if (rows.length) ok++;
    log(e.ticker.padEnd(10), status, rows.map(r => r.label).join(' '), rows[0] ? 'revenue ' + rows[0].data.revenue + ' net ' + rows[0].data.net_income : '');
    if (!dry) await rpc('financials_save', { p_secret: cfg.secret, p_ticker: e.ticker, p_source: 'mf', p_status: status, p_rows: rows });
  }
  log(`done: ${ok} of ${issuers.length} companies with yearly statements`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(e => { log(String(e.message || e)); process.exitCode = 1; });
