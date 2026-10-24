#!/usr/bin/env node
// Financial statements for the Financials tab (supabase/financials.sql), run on the owner's PC
// (tools/systemd/market-pulse-financials.*). The US shares people follow or hold: five years and
// twenty quarters from the SEC's XBRL company facts (tools/financials-lib.mjs), each share again
// after a week.
//
//   node tools/financials-batch.mjs [--limit 40] [--dry] [TICKER ...]
//
// Settings: ~/.config/market-pulse/summarizer.env (SUPABASE_URL, SUPABASE_ANON_KEY, SUMMARY_SECRET).
// The SEC asks automated requests to name a contact (https://www.sec.gov/os/accessing-edgar-data)
// and to stay under 10 a second: read from SEC_CONTACT or ~/.config/market-pulse/sec-contact,
// never kept in the repo.
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { secRows, secTicker } from './financials-lib.mjs';

const ENV_FILE = join(homedir(), '.config/market-pulse/summarizer.env');
try {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {}
const cfg = { supabaseUrl: (process.env.SUPABASE_URL || '').replace(/\/$/, ''), anonKey: process.env.SUPABASE_ANON_KEY || '', secret: process.env.SUMMARY_SECRET || '' };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function rpc(fn, body) {
  const res = await fetch(`${cfg.supabaseUrl}/rest/v1/rpc/${fn}`, { method: 'POST',
    headers: { apikey: cfg.anonKey, authorization: 'Bearer ' + cfg.anonKey, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${fn}: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

function secContact() {
  const file = join(homedir(), '.config/market-pulse/sec-contact');
  const c = (process.env.SEC_CONTACT || (existsSync(file) ? readFileSync(file, 'utf8') : '')).trim();
  return /^\S+@\S+\.\S+$/.test(c) ? c : null;
}
async function sec(url, contact) {
  await sleep(250); // well under the SEC's 10 requests a second
  const res = await fetch(url, { headers: { 'user-agent': 'MarketPulse ' + contact, accept: 'application/json' }, signal: AbortSignal.timeout(60000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('SEC answered ' + res.status);
  return res.json();
}

async function main() {
  const args = process.argv.slice(2), dry = args.includes('--dry');
  const li = args.indexOf('--limit'), limit = li >= 0 ? +args[li + 1] : 40;
  const named = args.filter((a, i) => /^[A-Z]/.test(a) && args[i - 1] !== '--limit');
  const contact = secContact();
  if (!contact) { log('SEC_CONTACT (an email address) is needed: see the comment at the top'); process.exitCode = 2; return; }
  if (!dry && (!cfg.supabaseUrl || !cfg.anonKey || !cfg.secret)) { log('not configured: SUPABASE_URL, SUPABASE_ANON_KEY, SUMMARY_SECRET'); process.exitCode = 2; return; }
  const tickers = named.length ? named : (await rpc('financials_pending', { p_secret: cfg.secret, p_source: 'sec', p_limit: limit })).map(r => r.ticker);
  if (!tickers.length) { log('nothing to do'); return; }
  // Ticker -> CIK, from the SEC's list.
  const list = await sec('https://www.sec.gov/files/company_tickers.json', contact);
  const cik = new Map(Object.values(list || {}).map(x => [String(x.ticker).toUpperCase(), x.cik_str]));
  let ok = 0, none = 0, failed = 0;
  for (const t of tickers) {
    let status = 'none', rows = [];
    try {
      const id = cik.get(secTicker(t));
      if (id) {
        const facts = await sec(`https://data.sec.gov/api/xbrl/companyfacts/CIK${String(id).padStart(10, '0')}.json`, contact);
        rows = facts ? secRows(facts) : [];
        if (rows.length) status = 'ok';
      }
    } catch (e) { status = 'failed'; log(t, 'failed:', String(e.message || e)); }
    if (status === 'ok') ok++; else if (status === 'none') none++; else failed++;
    const a = rows.filter(r => r.period === 'A'), q = rows.filter(r => r.period === 'Q');
    log(t.padEnd(7), status, a.length + ' years', q.length + ' quarters', a[0] ? a[0].label + ' revenue ' + a[0].data.revenue : '');
    if (!dry) await rpc('financials_save', { p_secret: cfg.secret, p_ticker: t, p_source: 'sec', p_status: status, p_rows: rows });
  }
  log(`done: ${ok} with figures, ${none} without (not an SEC filer, or no XBRL figures), ${failed} failed`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(e => { log(String(e.message || e)); process.exitCode = 1; });
