import test from 'node:test';
import assert from 'node:assert/strict';
import { expectedSlots, checkRuns } from '../ingest/health.mjs';
import { issueAction } from '../ingest/notify.mjs';

test('expected intraday runs on a weekday: every cron slot (a run with no market open still records itself)', () => {
  const slots = expectedSlots('2026-10-20');
  assert.equal(slots[0], '2026-10-20T07:07:00.000Z');
  assert.equal(slots[slots.length - 1], '2026-10-20T21:52:00.000Z');
  assert.equal(slots.length, 60);
  assert.deepEqual(expectedSlots('2026-10-24'), []);   // Saturday
});

test('checkRuns: missed runs, failed runs and a silent day are problems; a good day is not', () => {
  const day = '2026-10-20', slots = expectedSlots(day);
  const good = slots.map(s => ({ job: 'intraday', started_at: s, ok: true })).concat([{ job: 'eod', started_at: '2026-10-20T21:41:00Z', ok: true }]);
  assert.deepEqual(checkRuns(day, good), []);
  // GitHub delays scheduled runs: a few minutes late still counts.
  assert.deepEqual(checkRuns(day, good.map(r => ({ ...r, started_at: new Date(Date.parse(r.started_at) + 9 * 60000).toISOString() }))), []);
  const missing = good.filter((r, i) => i % 3 !== 0);
  assert.match(checkRuns(day, missing).join(), /intraday: 40 of 60 expected runs/);
  assert.match(checkRuns(day, good.filter(r => r.job !== 'eod')).join(), /eod: no run/);
  const failing = good.map((r, i) => (i < 20 ? { ...r, ok: false } : r));
  assert.match(checkRuns(day, failing).join(), /20 runs reported errors/);
  assert.deepEqual(checkRuns('2026-10-24', []), []);
});

test('issueAction: open a new issue, or comment on the open one with the same title', () => {
  assert.deepEqual(issueAction([], 'Ingest: missed runs'), { action: 'create' });
  assert.deepEqual(issueAction([{ number: 7, title: 'Ingest: missed runs', state: 'open' }], 'Ingest: missed runs'), { action: 'comment', number: 7 });
  assert.deepEqual(issueAction([{ number: 7, title: 'Ingest: budget', state: 'open' }], 'Ingest: missed runs'), { action: 'create' });
});

test('the ingest workflow\'s cron is the one the health check expects', async () => {
  const { readFileSync } = await import('node:fs');
  const { CRON } = await import('../ingest/health.mjs');
  const yml = readFileSync(new URL('../.github/workflows/ingest.yml', import.meta.url), 'utf8');
  assert.ok(yml.includes(`- cron: '${CRON.minutes.join(',')} ${CRON.hours[0]}-${CRON.hours[1]} * * 1-5'`));
  assert.match(yml, /if: vars\.INGEST_ENABLED == 'true'/);
});
