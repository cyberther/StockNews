import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const file = JSON.parse(readFileSync(new URL('../config/billing.json', import.meta.url), 'utf8'));
await import('../templates/shared/hif-flags.js');
await import('../templates/shared/hif-billing.js');
const B = globalThis.HIFBilling, F = globalThis.HIFFlags;

test('the browser copy of the billing config matches config/billing.json', () => {
  assert.deepEqual(B.CONFIG, file);
});

test('prices: positive, the year cheaper than twelve months, a 14-day trial, test mode', () => {
  assert.ok(file.prices.month > 0 && file.prices.year > 0);
  assert.ok(file.prices.year < 12 * file.prices.month);
  assert.equal(file.trialDays, 14);
  assert.equal(file.testMode, true);
  assert.equal(file.provider, 'lemonsqueezy');
});

test('limits: Free below Pro, Pro within the server caps (100)', () => {
  for (const k of ['tickers', 'positions']) {
    assert.ok(file.limits.free[k] < file.limits.pro[k], k);
    assert.ok(file.limits.pro[k] <= 100, k);
  }
  assert.deepEqual(B.limits('free'), file.limits.free);
  assert.deepEqual(B.limits('pro'), file.limits.pro);
  assert.deepEqual(B.limits('nonsense'), file.limits.free);
});

test('every feature row has its label in English, Romanian and German', () => {
  const src = readFileSync(new URL('../templates/shared/hif-data.js', import.meta.url), 'utf8');
  for (const f of file.features) assert.equal((src.match(new RegExp('\\b' + f.key + ":'", 'g')) || []).length, 3, f.key);
});

test('the commercial switches: off, and sales blocked until the legal check', () => {
  assert.equal(F.get('commercialMode'), false);
  assert.equal(F.get('billing'), true);
  assert.equal(F.get('legalReviewed'), false);
});
