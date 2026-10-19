// The scan Edge Function runs on Deno, which these tests don't have: its TypeScript is
// stripped of types and syntax-checked by Node, and the alerts-only path is checked to fetch
// nothing. Its behaviour against a real project is checked after deploy (docs/phase-a-setup.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import * as nodeModule from 'node:module';

// Node 22.13+; older Node skips the syntax check locally, but CI (Node 22) must run it.
const { stripTypeScriptTypes } = nodeModule;

const src = readFileSync(new URL('../supabase/functions/scan/index.ts', import.meta.url), 'utf8');

test('scan/index.ts is valid TypeScript syntax', { skip: !stripTypeScriptTypes && !process.env.CI && 'needs Node 22.13+' }, () => {
  assert.ok(stripTypeScriptTypes, 'Node 22.13+ is needed to check the Edge Function syntax');
  const js = stripTypeScriptTypes(src);
  const file = join(mkdtempSync(join(tmpdir(), 'scan-')), 'index.mjs');
  writeFileSync(file, js);
  execFileSync(process.execPath, ['--check', file]);
});

test('alerts-only mode reads stored stories and calls no news source', () => {
  const start = src.indexOf('if (alertsOnly) {'), other = src.indexOf('} else {', start), end = src.indexOf('} // end of fetching');
  assert.ok(start > 0 && other > start && end > other);
  const alertsBranch = src.slice(start, other), fetching = src.slice(other, end);
  assert.match(alertsBranch, /from\('stories'\)[\s\S]*\.is\('alerted_at', null\)/);
  assert.doesNotMatch(alertsBranch, /companyNews|pressMarketNews|fetch\(/);
  assert.match(fetching, /companyNews\(/);
  // Stories are marked once alerted.
  assert.match(src, /update\(\{ alerted_at: at \}\)/);
});

test('MARKET_TOP and the EU feed only with their flags', () => {
  assert.match(src, /concat\(flagOn\('FLAG_US_MARKET'\) \? MARKET_TOP : \[\]\)/);
  assert.match(src, /flagOn\('FLAG_EU_MARKET'\) \? await pressMarketNews\('\/eu-news'/);
});

test('the test alert answers the app on Cloudflare Pages (production and branch previews) as well as Netlify', () => {
  const line = src.split('\n').find(l => l.includes('const ok = origin &&'));
  const re = new RegExp(line.match(/\/\^(.+?)\$\//)[0].slice(1, -1));
  for (const o of ['https://aa-market-pulse.pages.dev', 'https://staging.aa-market-pulse.pages.dev', 'https://973e7c03.aa-market-pulse.pages.dev',
    'https://aa-market-pulse.netlify.app', 'https://staging--aa-market-pulse.netlify.app',
    'https://marketpulse.ro', 'https://www.marketpulse.ro', 'https://staging.marketpulse.ro']) assert.ok(re.test(o), o);
  for (const o of ['https://evil.pages.dev', 'https://aa-market-pulse.pages.dev.evil.com', 'http://aa-market-pulse.pages.dev', 'https://x.y.aa-market-pulse.pages.dev',
    'http://marketpulse.ro', 'https://marketpulse.ro.evil.com', 'https://evilmarketpulse.ro', 'https://x.staging.marketpulse.ro', 'https://admin.marketpulse.ro'])
    assert.ok(!re.test(o), o);
});

test('scan_runs gets only its own columns (the mode stays in the response)', () => {
  const ins = src.match(/from\('scan_runs'\)\.insert\(([^)]*)\)/);
  assert.ok(ins, 'scan_runs insert');
  const cols = /\{([^}]*)\}/.exec(ins[1]);
  assert.ok(cols, 'inserts an explicit column list');
  const names = cols[1].split(',').map(s => s.trim().split(':')[0]).filter(Boolean).sort();
  assert.deepEqual(names, ['errors', 'new_stories', 'pushes', 'started_at', 'tickers']);
});

test('policy alerts: worked out in SQL, sent once a day at most per run, marked even with no device', () => {
  const start = src.indexOf('// Policy alerts'), end = src.indexOf('// end of policy alerts');
  assert.ok(start > 0 && end > start, 'policy alerts block');
  const block = src.slice(start, end);
  assert.match(block, /flagOn\('FLAG_POLICY_ALERTS'\)/);
  assert.match(block, /rpc\('policy_alerts_due', \{ p_since:/);
  assert.match(block, /rpc\('policy_alerts_mark', \{ p_until:/);
  assert.doesNotMatch(block, /fetch\(/);
  // Marking does not depend on having sent anything (no device, VAPID missing).
  const mark = block.indexOf("rpc('policy_alerts_mark'"), send = block.indexOf('sendNotification');
  assert.ok(mark > 0 && send > 0);
  assert.doesNotMatch(block.slice(block.lastIndexOf('if', mark), mark), /sent|pushes/);
});
