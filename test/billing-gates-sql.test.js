// Phase D's server-side rules, on only with the commercial switch: the Free limits, the Pro-only
// tables (impact results, day digests) and who gets push alerts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { supabaseDb, as, APPROVED } from './helpers/supabase-pg.js';
import { ADMIN, PAYER, BILLING_STUBS, BILLING_SQL } from './helpers/billing-stubs.js';

const read = f => readFileSync(new URL('../supabase/' + f, import.meta.url), 'utf8');
// The real caps (push.sql, holdings.sql) are redefined by billing.sql; impact.sql gives impact_results.
const EXTRA = `
create function public.summary_secret_ok(p_secret text) returns boolean language sql stable as $$ select false $$;
create table public.push_subscriptions (endpoint text primary key, user_id uuid not null, p256dh text not null, auth text not null);
create table public.ticker_digests (ticker text, day date, lang text, digest text, stories int, primary key (ticker, day, lang));
alter table public.ticker_digests enable row level security; alter table public.ticker_digests force row level security;
grant select on public.ticker_digests to authenticated;
create policy "read digests" on public.ticker_digests for select to authenticated using (public.is_approved());
create trigger watchlist_cap before insert on public.watchlist for each row execute function public.watchlist_cap();
create trigger holdings_cap before insert on public.holdings for each row execute function public.holdings_cap();
grant select, insert, delete on public.watchlist, public.holdings to authenticated;
`;
let db;
const commercial = on => db.exec(`update public.app_config set value = '${on}' where key = 'commercial_mode'`);
const svc = async sql => { await db.exec('set role service_role'); try { return await db.query(sql); } finally { await db.exec('reset role'); } };
test.before(async () => {
  db = await supabaseDb(BILLING_STUBS, EXTRA, read('policy.sql'), read('impact.sql'), BILLING_SQL);
  await db.exec(`insert into public.impact_analyses (id, version, published_at, title, policy, events, sectors, body, content_hash)
      values ('a-b', 1, '2026-10-19', 'A', 'p-q', '{}', '{}', '{"companies":[]}', '${'a'.repeat(64)}');
    insert into public.impact_results (analysis_id, version, engine_version, scenario, subject, vals, formula) values ('a-b', 1, '1.0.0', 'full', 'budget', '{}', 'f');
    insert into public.ticker_digests values ('SNP.RO', current_date, 'ro', 'x'.repeat(30), 2);`.replace("'x'.repeat(30)", `'${'x'.repeat(30)}'`));
});
test.after(() => db && db.close());

const addTickers = async (u, n, table = 'watchlist', from = 0) => {
  for (let i = from; i < from + n; i++)
    await as(db, 'authenticated', u, table === 'watchlist' ? `insert into public.watchlist (user_id, ticker) values ('${u}', 'T${i}.RO')`
      : `insert into public.holdings (user_id, ticker, shares) values ('${u}', 'T${i}.RO', 1)`);
};
const clear = () => db.exec('delete from public.watchlist; delete from public.holdings; delete from public.entitlements;');

test('commercial mode off: the old caps (100) for everyone, every approved account reads results and digests', async () => {
  await clear();
  await addTickers(PAYER, 8);
  await addTickers(PAYER, 8, 'holdings');
  assert.equal((await as(db, 'authenticated', PAYER, 'select 1 from public.impact_results')).rows.length, 1);
  assert.equal((await as(db, 'authenticated', PAYER, 'select 1 from public.ticker_digests')).rows.length, 1);
  assert.deepEqual((await svc(`select array_agg(u order by u) a from public.pro_users(array['${PAYER}','${APPROVED}']::uuid[]) u`)).rows[0].a.sort(), [APPROVED, PAYER].sort());
});

test('commercial mode on: Free is held to 5 tickers and 5 positions, Pro to 100', async () => {
  await clear(); await commercial(true);
  try {
    await addTickers(PAYER, 5);
    await assert.rejects(addTickers(PAYER, 1, 'watchlist', 5), /limited to 5/);
    await addTickers(PAYER, 5, 'holdings');
    await assert.rejects(addTickers(PAYER, 1, 'holdings', 5), /limited to 5/);
    await db.query(`insert into public.entitlements (user_id, source, status, current_period_end) values ($1, 'payment', 'active', now() + interval '30 days')`, [PAYER]);
    await db.exec(`delete from public.watchlist`);
    await addTickers(PAYER, 8);
    assert.equal((await db.query(`select count(*)::int c from public.watchlist where user_id = $1`, [PAYER])).rows[0].c, 8);
  } finally { await commercial(false); }
});

test('commercial mode on: impact results, accuracy and day digests are Pro; alerts go to Pro accounts only', async () => {
  await clear(); await commercial(true);
  try {
    assert.equal((await as(db, 'authenticated', PAYER, 'select 1 from public.impact_results')).rows.length, 0);
    assert.equal((await as(db, 'authenticated', PAYER, 'select 1 from public.ticker_digests')).rows.length, 0);
    assert.equal((await as(db, 'authenticated', PAYER, 'select 1 from public.impact_analyses')).rows.length, 1, 'the analysis itself (facts, assumptions) stays free');
    assert.deepEqual((await svc(`select array_agg(u) a from public.pro_users(array['${PAYER}','${APPROVED}']::uuid[]) u`)).rows[0].a, null);
    await db.query(`insert into public.entitlements (user_id, source, status, current_period_end) values ($1, 'payment', 'active', now() + interval '30 days')`, [PAYER]);
    assert.equal((await as(db, 'authenticated', PAYER, 'select 1 from public.impact_results')).rows.length, 1);
    assert.equal((await as(db, 'authenticated', PAYER, 'select 1 from public.ticker_digests')).rows.length, 1);
    assert.deepEqual((await svc(`select array_agg(u) a from public.pro_users(array['${PAYER}','${APPROVED}']::uuid[]) u`)).rows[0].a, [PAYER]);
  } finally { await commercial(false); }
});

test('pro_users is for the service role only', async () => {
  await assert.rejects(as(db, 'authenticated', ADMIN, `select * from public.pro_users(array['${PAYER}']::uuid[])`), /permission denied/);
});
