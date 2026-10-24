// The figures read from the filings in Pro (2026-10-24, the owner's call): every approved reader
// lists the documents (every column but data); the figures come from the view filing_figures,
// for Pro readers only while the commercial rules are on, and for every approved one while off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { supabaseDb, as, APPROVED, WAITING } from './helpers/supabase-pg.js';
import { PAYER, BILLING_STUBS, BILLING_SQL } from './helpers/billing-stubs.js';

const STUBS = BILLING_STUBS + `
create function public.summary_secret_ok(p text) returns boolean language sql stable as $$ select false $$;
create schema cron; create table cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text);
create function cron.schedule(n text, s text, c text) returns bigint language sql as $$
  insert into cron.job (jobname, schedule, command) values (n, s, c) on conflict (jobname) do update set schedule = excluded.schedule returning jobid $$;
create function cron.unschedule(i bigint) returns boolean language sql as $$ delete from cron.job where jobid = i returning true $$;
`;
let db;
const q = (u, sql) => as(db, 'authenticated', u, sql).then(r => r.rows);
const commercial = on => db.exec(`update public.app_config set value = '${on}' where key = 'commercial_mode'`);
test.before(async () => {
  db = await supabaseDb(STUBS, readFileSync(new URL('../supabase/filings.sql', import.meta.url), 'utf8'), BILLING_SQL);
  // approval.sql's policy: approved readers.
  await db.exec(`drop policy if exists "read filings" on public.filings;
    create policy "read filings" on public.filings for select to authenticated using (public.is_approved());
    insert into public.filings (ticker, url, title, published_at, kind, source, data, extract_status) values
      ('ALR.RO', 'https://a.ro/1', 'Tranzacții conducere', now() - interval '1 day', 'insider', 'Alro', '{"transactions":[{"person":"X","shares":10}]}', 'ok'),
      ('ALR.RO', 'https://a.ro/2', 'Raport anual', now() - interval '2 days', 'report', 'Alro', null, null);
    insert into public.entitlements (user_id, source, status, current_period_end) values ('${PAYER}', 'payment', 'active', now() + interval '20 days');`);
});
test.after(() => db && db.close());

test('the documents: every column but the figures, for every approved reader', async () => {
  await commercial(true);
  try {
    assert.equal((await q(APPROVED, 'select id, title, url, kind, extract_status from public.filings')).length, 2);
    await assert.rejects(q(APPROVED, 'select data from public.filings'), /permission denied/);
    await assert.rejects(q(PAYER, 'select * from public.filings'), /permission denied/);
    assert.equal((await q(WAITING, 'select id from public.filings')).length, 0);
  } finally { await commercial(false); }
});

test('the figures: Pro only with the commercial rules on; every approved reader with them off', async () => {
  await commercial(true);
  try {
    assert.equal((await q(APPROVED, 'select * from public.filing_figures')).length, 0, 'Free');
    const pro = await q(PAYER, "select id, kind, data->'transactions' t from public.filing_figures");
    assert.equal(pro.length, 1); assert.equal(pro[0].t[0].person, 'X');
  } finally { await commercial(false); }
  assert.equal((await q(APPROVED, 'select * from public.filing_figures')).length, 1, 'rules off');
  assert.equal((await q(WAITING, 'select * from public.filing_figures')).length, 0, 'not approved');
  await assert.rejects(as(db, 'anon', '', 'select * from public.filing_figures'), /permission denied/);
});
