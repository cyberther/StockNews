// The scan Edge Function runs on Deno, which these tests don't have: its TypeScript is
// stripped of types and syntax-checked by Node, and the alerts-only path is checked to fetch
// nothing. Its behaviour against a real project is checked after deploy (docs/phase-a-setup.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';

const src = readFileSync(new URL('../supabase/functions/scan/index.ts', import.meta.url), 'utf8');

test('scan/index.ts is valid TypeScript syntax', () => {
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
