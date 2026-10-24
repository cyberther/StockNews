#!/usr/bin/env node
// Builds the catalog of US-listed shares the apps search (templates/shared/us-tickers.json), from
// the SEC's public list of companies and their tickers (company_tickers_exchange.json: US
// government data, free of licence terms). Only the Nasdaq, NYSE and Cboe listings are kept;
// over-the-counter tickers are left out. A share class is written the way the apps show it
// (BRK-B → BRK.B).
//
// The search used Finnhub, which the Cloudflare gateway does not use (its plan is for personal
// use only: LEGAL-SOURCES.md), so US shares could no longer be found (2026-10-24).
//
//   node tools/update-us-catalog.mjs
//
// The SEC asks automated requests to name a contact (https://www.sec.gov/os/accessing-edgar-data):
// read from SEC_CONTACT or ~/.config/market-pulse/sec-contact, never kept in the repo.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = 'https://www.sec.gov/files/company_tickers_exchange.json';
const EXCHANGES = { Nasdaq: 'Nasdaq', NYSE: 'NYSE', CBOE: 'Cboe' };

// [[ticker, name, exchange]] from the SEC file ({ fields, data }), sorted, one row per ticker.
export function catalogRows(sec) {
  const at = f => (sec.fields || []).indexOf(f);
  const [iName, iTicker, iExchange] = [at('name'), at('ticker'), at('exchange')];
  if (iName < 0 || iTicker < 0 || iExchange < 0) throw new Error('unexpected SEC file: ' + JSON.stringify(sec.fields));
  const seen = new Map();
  for (const r of sec.data || []) {
    const ex = EXCHANGES[r[iExchange]], raw = String(r[iTicker] || '').toUpperCase().trim(), name = String(r[iName] || '').replace(/\s+/g, ' ').trim();
    if (!ex || !name || !/^[A-Z]{1,5}(-[A-Z])?$/.test(raw)) continue;
    const ticker = raw.replace('-', '.');
    if (!seen.has(ticker)) seen.set(ticker, [ticker, name, ex]);
  }
  return [...seen.values()].sort((a, b) => a[0].localeCompare(b[0]));
}

async function main() {
  const file = join(homedir(), '.config/market-pulse/sec-contact');
  const contact = (process.env.SEC_CONTACT || (existsSync(file) ? readFileSync(file, 'utf8') : '')).trim();
  if (!/^\S+@\S+\.\S+$/.test(contact)) { console.error('SEC_CONTACT (an email address) is needed: see the comment at the top'); process.exitCode = 2; return; }
  const res = await fetch(SOURCE, { headers: { 'user-agent': 'MarketPulse ' + contact, accept: 'application/json' } });
  if (!res.ok) throw new Error('SEC answered ' + res.status);
  const rows = catalogRows(await res.json());
  if (rows.length < 3000) throw new Error('only ' + rows.length + ' rows: not written');
  const out = { source: SOURCE, updated: new Date().toISOString().slice(0, 10), rows };
  writeFileSync(join(ROOT, 'templates/shared/us-tickers.json'), JSON.stringify(out) + '\n');
  console.log(rows.length + ' US listings written to templates/shared/us-tickers.json');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(e => { console.error(String(e.message || e)); process.exitCode = 1; });
