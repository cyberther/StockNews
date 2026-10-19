// Which filings the local model reads next (supabase/filings.sql filings_pending): every kept
// document (6 months), the companies people follow or hold first, then by kind and newest.
// 2026-10-19: the ticker pages showed documents "still being read" that the queue (last month
// only) never reached.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { supabaseDb } from './helpers/supabase-pg.js';

const SECRET = 's'.repeat(40);
const STUBS = `
create table public.watchlist (user_id uuid, ticker text, push boolean default true);
create table public.holdings (user_id uuid, ticker text, shares numeric);
create function public.summary_secret_ok(p text) returns boolean language sql stable as $$ select p = '${SECRET}' $$;
create schema cron; create table cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text);
create function cron.schedule(n text, s text, c text) returns bigint language sql as $$
  insert into cron.job (jobname, schedule, command) values (n, s, c) on conflict (jobname) do update set schedule = excluded.schedule returning jobid $$;
create function cron.unschedule(i bigint) returns boolean language sql as $$ delete from cron.job where jobid = i returning true $$;
`;
let db;
test.before(async () => {
  db = await supabaseDb(STUBS, readFileSync(new URL('../supabase/filings.sql', import.meta.url), 'utf8'));
  await db.exec(`insert into public.watchlist values ('00000000-0000-0000-0000-000000000001', 'TLV.RO', true);
    insert into public.holdings values ('00000000-0000-0000-0000-000000000002', 'SNG.RO', 5);
    insert into public.filings (ticker, url, title, published_at, kind, source) values
      ('ALR.RO', 'https://a.ro/1', 'Rezultate T3', now() - interval '2 days', 'results', 'Alro'),
      ('ALR.RO', 'https://a.ro/2', 'Tranzacții conducere', now() - interval '1 day', 'insider', 'Alro'),
      ('TLV.RO', 'https://b.ro/1', 'Rezultate S1', now() - interval '3 months', 'results', 'BT'),
      ('SNG.RO', 'https://c.ro/1', 'Dividend', now() - interval '4 months', 'dividend', 'Romgaz'),
      ('ALR.RO', 'https://a.ro/3', 'Raport anual', now() - interval '1 day', 'report', 'Alro');`);
});
test.after(() => db && db.close());

test('older documents are read too, followed and held companies first, annual reports never', async () => {
  const rows = (await db.query(`select ticker, kind from public.filings_pending('${SECRET}', 10)`)).rows.map(r => r.ticker + ' ' + r.kind);
  assert.deepEqual(rows, ['SNG.RO dividend', 'TLV.RO results', 'ALR.RO insider', 'ALR.RO results']);
});
