import test from 'node:test';
import assert from 'node:assert/strict';
import { createBreaker } from '../ingest/breaker.mjs';
import { createBudget } from '../ingest/budget.mjs';

const t0 = Date.parse('2026-10-20T08:07:00Z'), MIN = 60000;

test('the breaker opens after 3 failures in a row and stays open 30 minutes', () => {
  const b = createBreaker([], t0);
  b.failure('yahoo', 'timeout'); b.failure('yahoo', 'timeout');
  assert.equal(b.allowed('yahoo'), true);
  b.failure('yahoo', '429');
  assert.equal(b.allowed('yahoo'), false);
  const [row] = b.changes();
  assert.equal(row.provider, 'yahoo');
  assert.equal(row.reason, '429');
  assert.equal(row.open_until, new Date(t0 + 30 * MIN).toISOString());
  // The next run, 15 minutes later, reads the stored state: still open.
  assert.equal(createBreaker([row], t0 + 15 * MIN).allowed('yahoo'), false);
  // After 30 minutes one try is allowed; a failure opens it again at once, a success resets it.
  const later = createBreaker([row], t0 + 31 * MIN);
  assert.equal(later.allowed('yahoo'), true);
  later.failure('yahoo', 'timeout');
  assert.equal(later.allowed('yahoo'), false);
  const ok = createBreaker([row], t0 + 31 * MIN);
  ok.success('yahoo');
  assert.deepEqual(ok.changes().map(r => [r.fails, r.open_until]), [[0, null]]);
});

test('a success between failures resets the count; unchanged providers are not written', () => {
  const b = createBreaker([{ provider: 'feeds', fails: 0, open_until: null }], t0);
  b.failure('yahoo', 'x'); b.failure('yahoo', 'x'); b.success('yahoo'); b.failure('yahoo', 'x'); b.failure('yahoo', 'x');
  assert.equal(b.allowed('yahoo'), true);
  b.success('feeds');
  assert.deepEqual(b.changes().map(r => r.provider), ['yahoo']);
});

const limits = { providers: { yahoo: { perDay: 10 } }, jobs: { intraday: { perRun: 4 } } };

test('the budget refuses calls past a provider\'s daily limit, counting earlier runs', () => {
  const b = createBudget(limits, [{ day: '2026-10-20', provider: 'yahoo', job: 'eod', calls: 7 }], '2026-10-20');
  assert.equal(b.take('yahoo', 'intraday', 2), true);
  assert.equal(b.take('yahoo', 'intraday', 2), false);   // 7 + 2 + 2 > 10
  assert.match(b.over().join(), /yahoo.*10\/day/);
  assert.deepEqual(b.usage(), [{ day: '2026-10-20', provider: 'yahoo', job: 'intraday', calls: 2 }]);
});

test('the budget refuses calls past a job\'s per-run limit; unknown providers and jobs are unlimited', () => {
  const b = createBudget(limits, [], '2026-10-20');
  assert.equal(b.take('feeds', 'intraday', 3), true);
  assert.equal(b.take('feeds', 'intraday', 2), false);  // 3 + 2 > 4 per run
  assert.match(b.over().join(), /intraday.*4\/run/);
  assert.equal(b.take('yahoo', 'other', 5), true);
});
