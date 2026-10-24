// Financial statements (supabase/financials.sql): the PC job saves them with the shared secret;
// every approved reader sees each company's latest year and quarter; the years behind are Pro
// while the commercial rules are on (2026-10-24, the owner's call).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { supabaseDb, as, APPROVED, WAITING } from './helpers/supabase-pg.js';
import { PAYER, BILLING_STUBS, BILLING_SQL } from './helpers/billing-stubs.js';

const SECRET = 's'.repeat(40);
const STUBS = BILLING_STUBS + `
create function public.summary_secret_ok(p text) returns boolean language sql stable as $$ select p = '${SECRET}' $$;`;
let db;
const q = (u, sql) => as(db, 'authenticated', u, sql).then(r => r.rows);
const commercial = on => db.exec(`update public.app_config set value = '${on}' where key = 'commercial_mode'`);
const rows = JSON.stringify([
  { period: 'A', period_end: '2025-09-27', label: '2025', currency: 'USD', data: { revenue: 416 } },
  { period: 'A', period_end: '2024-09-28', label: '2024', currency: 'USD', data: { revenue: 391 } },
  { period: 'Q', period_end: '2026-06-27', label: 'T3 2026', currency: 'USD', data: { revenue: 109 } },
  { period: 'Q', period_end: '2026-03-28', label: 'T2 2026', currency: 'USD', data: { revenue: 111 } }]);
const save = (secret, ticker, status, r) => db.query(`select public.financials_save($1, $2, 'sec', $3, $4::jsonb) n`, [secret, ticker, status, r]);
test.before(async () => {
  db = await supabaseDb(STUBS, BILLING_SQL, readFileSync(new URL('../supabase/financials.sql', import.meta.url), 'utf8'));
  await db.exec(`insert into public.watchlist values ('${APPROVED}', 'AAPL', true), ('${APPROVED}', 'TLV.RO', true), ('${PAYER}', 'MSFT', true);
    insert into public.holdings values ('${APPROVED}', 'BRK.B', 2);
    insert into public.entitlements (user_id, source, status, current_period_end) values ('${PAYER}', 'payment', 'active', now() + interval '20 days');`);
});
test.after(() => db && db.close());

test('the queue: US shares followed or held, never asked for first; Bucharest ones for their own sources', async () => {
  const pending = async src => (await db.query(`select ticker from public.financials_pending('${SECRET}', '${src}', 10)`)).rows.map(r => r.ticker);
  assert.deepEqual(await pending('sec'), ['AAPL', 'BRK.B', 'MSFT']);
  assert.deepEqual(await pending('mf'), ['TLV.RO']);
  await assert.rejects(db.query(`select * from public.financials_pending('wrong', 'sec', 10)`), /not allowed/);
});

test('saving replaces a ticker\'s rows and marks the latest year and quarter; the queue moves on', async () => {
  assert.equal((await save(SECRET, 'AAPL', 'ok', rows)).rows[0].n, 4);
  assert.equal((await save(SECRET, 'AAPL', 'ok', rows)).rows[0].n, 4);
  const latest = (await db.query(`select label from public.financials where is_latest order by label`)).rows.map(r => r.label);
  assert.deepEqual(latest, ['2025', 'T3 2026']);
  await save(SECRET, 'MSFT', 'none', '[]');
  assert.deepEqual((await db.query(`select ticker from public.financials_pending('${SECRET}', 'sec', 10)`)).rows.map(r => r.ticker), ['BRK.B']);
  // A failed read keeps what was saved before.
  await save(SECRET, 'AAPL', 'failed', '[]');
  assert.equal((await db.query(`select count(*)::int n from public.financials where ticker = 'AAPL'`)).rows[0].n, 4);
  await assert.rejects(save('wrong', 'AAPL', 'ok', rows), /not allowed/);
  await assert.rejects(save(SECRET, 'AAPL', 'maybe', rows), /bad status/);
});

test('readers: the latest year and quarter for every approved reader, all of it for Pro', async () => {
  await commercial(true);
  try {
    assert.deepEqual((await q(APPROVED, 'select label from public.financials order by label')).map(r => r.label), ['2025', 'T3 2026']);
    assert.equal((await q(PAYER, 'select label from public.financials')).length, 4);
    assert.equal((await q(WAITING, 'select label from public.financials')).length, 0);
    await assert.rejects(as(db, 'anon', '', 'select * from public.financials'), /permission denied/);
    await assert.rejects(q(APPROVED, 'select * from public.financials_checked'), /permission denied/);
    await assert.rejects(q(PAYER, `insert into public.financials (ticker, source, period, period_end, label, currency, data) values ('X', 'sec', 'A', '2025-01-01', 'x', 'USD', '{}')`), /permission denied/);
  } finally { await commercial(false); }
  assert.equal((await q(APPROVED, 'select label from public.financials')).length, 4, 'commercial rules off: everything');
});
