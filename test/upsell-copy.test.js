// The Pro offers shown in context (2026-10-23): under the first Policy event that concerns a
// Free reader, and in place of an impact analysis's results on Free. Plain statements of what
// Pro adds, in every language, with no urgency and nothing that reads as investment advice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const data = readFileSync(new URL('../templates/shared/hif-data.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../templates/stock-news-web/StockNewsWeb.dc.html', import.meta.url), 'utf8');
const KEYS = ['polUpsell', 'upsellSee', 'upsellLater', 'impLocked', 'trialEnds', 'trialPriceMonth', 'trialPriceYear', 'trialPriceAny', 'trialThen', 'trialOk'];
const values = key => [...data.matchAll(new RegExp('\\b' + key + ":'((?:[^'\\\\]|\\\\.)*)'", 'g'))].map(m => m[1]);

test('every offer has its text in English, Romanian and German', () => {
  for (const k of KEYS) assert.equal(values(k).length, 3, k);
  for (const v of values('polUpsell')) assert.ok(v.includes('{t}'), v);
});

test('no urgency, fear or advice words in the offers', () => {
  const bad = /\b(acum sau niciodat|ultima șans|nu rata|grăbește|doar azi|don't miss|last chance|hurry|today only|verpassen|nur heute|cumpără|vinde|buy|sell|kaufen|verkaufen)\b/i;
  for (const k of KEYS) for (const v of values(k)) assert.ok(!bad.test(v), k + ': ' + v);
});

test('the Policy offer: Free plan only, on one event, and "Not now" hides it for 14 days', () => {
  assert.match(app, /const up = this\.plan === 'free' && !this\.policyUpsellHidden\(\) \? cards\.find\(c => c\.hasConcerns\) : null;/);
  assert.match(app, /localStorage\.setItem\('mp\.policyUpsell'/);
  assert.match(app, /Date\.now\(\) - at < 14 \* 864e5/);
});

test('impact results: locked only on Free when the server sent none; calculator links hidden on Free', () => {
  assert.match(app, /impDLocked: this\.plan === 'free' && !fz/);
  assert.match(app, /impDCalc: this\.plan === 'free' \? \[\] :/);
});

test('the trial reminder: the last 3 days of a trial, the date, the amount and where to cancel', () => {
  for (const v of values('trialEnds')) assert.ok(v.includes('{d}') && v.includes('{p}'), v);
  assert.match(app, /b\.status === 'trialing' && end && left > 0 && left <= 3 \* 864e5/);
  assert.match(app, /localStorage\.setItem\(key, String\(b\.period_end\)\)/);
});
