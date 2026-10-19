// The assumption library (config/impact-assumptions.json): the only assumptions an automatic
// analysis may use (docs/plans/2026-10-19-politici-automat-design.md). A data assumption
// needs an official https source; a scenario parameter (how much of a measure applies, how
// late) is a choice of method and says why in its own words. Changes go through review.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateAssumptionLibrary } from '../ingest/impact/schema.mjs';

const lib = JSON.parse(readFileSync(new URL('../config/impact-assumptions.json', import.meta.url), 'utf8'));
const good = { key: 'gdp_2026', label: 'PIB nominal 2026 (lei)', kind: 'data', unit: 'RON',
  why: 'Derivat din comunicatul MF: deficit 78,52 mld. lei = 3,82% din PIB.', source_url: 'https://mfinante.gov.ro/x', source_date: '2026-10-16',
  range: [1, 3], default: 2, applies_to: ['tax_rate_change'] };

test('the real library passes and has no unsourced data assumption', () => {
  const r = validateAssumptionLibrary(lib);
  assert.deepEqual(r.errors, []);
  assert.ok(r.ok);
  assert.ok(!lib.some(a => a.key === 'diesel_volume'));
  assert.ok(lib.filter(a => a.kind === 'data').every(a => a.source_url.startsWith('https://')));
});

test('an entry needs a why of 20+ characters, a default inside its range and known measure types', () => {
  assert.ok(validateAssumptionLibrary([good]).ok);
  assert.match(validateAssumptionLibrary([{ ...good, why: 'scurt' }]).errors.join(), /why/);
  assert.match(validateAssumptionLibrary([{ ...good, default: 9 }]).errors.join(), /outside/);
  assert.match(validateAssumptionLibrary([{ ...good, applies_to: ['other'] }]).errors.join(), /applies_to/);
  assert.match(validateAssumptionLibrary([{ ...good, range: [3, 1] }]).errors.join(), /range/);
});

test('a data assumption needs an https source and its date; keys are unique', () => {
  assert.match(validateAssumptionLibrary([{ ...good, source_url: 'http://x' }]).errors.join(), /source_url/);
  assert.match(validateAssumptionLibrary([{ ...good, source_date: null }]).errors.join(), /source_date/);
  assert.match(validateAssumptionLibrary([good, good]).errors.join(), /twice/);
  // A scenario parameter is a method choice: no source, but still a reason.
  assert.ok(validateAssumptionLibrary([{ ...good, kind: 'scenario', source_url: null, source_date: null }]).ok);
  assert.match(validateAssumptionLibrary([{ ...good, kind: 'guess' }]).errors.join(), /kind/);
});
