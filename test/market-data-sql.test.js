// supabase/market-data.sql on a real Postgres (PGlite), with the parts of Supabase it relies
// on stubbed the way Supabase has them: the anon / authenticated / service_role roles,
// auth.uid() from the request's JWT, and public.is_approved() as in supabase/approval.sql.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const SQL = readFileSync(new URL('../supabase/market-data.sql', import.meta.url), 'utf8');
const APPROVED = '00000000-0000-0000-0000-000000000001', WAITING = '00000000-0000-0000-0000-000000000002';

const STUB = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
-- As in Supabase: the service role gets every new table in public.
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
create table public.account_status (user_id uuid primary key, approved boolean not null default false, suspended boolean not null default false);
insert into public.account_status values ('${APPROVED}', true, false), ('${WAITING}', false, false);
create function public.is_approved() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.account_status s where s.user_id = auth.uid() and s.approved and not s.suspended) $$;
revoke all on function public.is_approved() from public, anon;
grant execute on function public.is_approved() to authenticated;
create table public.stories (id text primary key, ticker text not null, headline text not null, source text, url text, summary text,
  published_at timestamptz not null, found_at timestamptz not null default now());
`;

let db;
test.before(async () => {
  db = new PGlite();
  await db.exec(STUB);
  await db.exec(SQL);
  await db.exec(SQL); // the script can be run again
  await db.exec(`
    insert into public.market_quotes (symbol, price, change, change_pct, currency, market_time, source, license) values
      ('SNP.RO', 0.71, 0.01, 1.4, 'RON', now(), 'yahoo', 'dev_only'),
      ('TLV.RO', 30.2, -0.1, -0.3, 'RON', now(), 'bvb', 'redistribution');
    insert into public.market_recommendations (symbol, status, source, license) values ('AAPL', 'ok', 'yahoo', 'dev_only');
    insert into public.ingest_runs (job, started_at, ok, symbols) values ('intraday', now(), true, 3);`);
});
test.after(() => db && db.close());

async function as(role, sub, sql) {
  await db.exec(`set role ${role}; select set_config('request.jwt.claim.sub', '${sub || ''}', false);`);
  try { return await db.query(sql); } finally { await db.exec('reset role'); }
}
const symbols = r => r.rows.map(x => x.symbol).sort();

test('signed out (anon) sees licensed prices only, never dev_only data', async () => {
  assert.deepEqual(symbols(await as('anon', '', 'select symbol from public.market_quotes')), ['TLV.RO']);
  assert.deepEqual(symbols(await as('anon', '', 'select symbol from public.market_recommendations')), []);
});

test('an approved account sees dev_only data too', async () => {
  assert.deepEqual(symbols(await as('authenticated', APPROVED, 'select symbol from public.market_quotes')), ['SNP.RO', 'TLV.RO']);
  assert.deepEqual(symbols(await as('authenticated', APPROVED, 'select symbol from public.market_recommendations')), ['AAPL']);
});

test('an account still waiting for approval sees licensed prices only', async () => {
  assert.deepEqual(symbols(await as('authenticated', WAITING, 'select symbol from public.market_quotes')), ['TLV.RO']);
});

test('only the service role writes market data', async () => {
  for (const [role, sub] of [['anon', ''], ['authenticated', APPROVED]]) {
    await assert.rejects(as(role, sub, `insert into public.market_quotes (symbol, price, source, license) values ('X', 1, 'x', 'dev_only')`), /permission denied|row-level security/);
    await assert.rejects(as(role, sub, `update public.market_quotes set price = 0`), /permission denied/);
  }
  await as('service_role', '', `insert into public.market_quotes (symbol, price, source, license) values ('OKLO', 80, 'yahoo', 'dev_only')
    on conflict (symbol) do update set price = excluded.price`);
});

test('the jobs\' own tables are not readable from the browser', async () => {
  for (const t of ['ingest_runs', 'ingest_provider_state', 'ingest_usage'])
    for (const [role, sub] of [['anon', ''], ['authenticated', APPROVED]])
      await assert.rejects(as(role, sub, `select * from public.${t}`), /permission denied/, t + ' as ' + role);
});

test('a licence outside the three known ones, or a bad symbol, is refused', async () => {
  await assert.rejects(db.query(`insert into public.market_quotes (symbol, price, source, license) values ('ABC', 1, 'x', 'free')`), /violates check/);
  await assert.rejects(db.query(`insert into public.market_quotes (symbol, price, source, license) values ('a b', 1, 'x', 'dev_only')`), /violates check/);
});

test('stories get alerted_at, for the scan\'s alerts-only mode', async () => {
  const r = await db.query(`select column_name from information_schema.columns where table_name = 'stories' and column_name = 'alerted_at'`);
  assert.equal(r.rows.length, 1);
});

test('market_quotes carries the company name', async () => {
  await db.query(`update public.market_quotes set name = 'OMV Petrom' where symbol = 'SNP.RO'`);
  const r = await as('authenticated', APPROVED, `select name from public.market_quotes where symbol = 'SNP.RO'`);
  assert.equal(r.rows[0].name, 'OMV Petrom');
});
