import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { supabaseDb, as, APPROVED } from './helpers/supabase-pg.js';

const SQL = readFileSync(new URL('../supabase/ingest-cron.sql', import.meta.url), 'utf8');
// What Supabase provides: pg_net's http_post, the vault, pg_cron.
const STUBS = `
create schema net; create table net.calls (id bigserial primary key, url text, headers jsonb, body jsonb, timeout_milliseconds int);
create function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', params jsonb default '{}', timeout_milliseconds int default 5000) returns bigint
  language sql as $$ insert into net.calls (url, headers, body, timeout_milliseconds) values (url, headers, body, timeout_milliseconds) returning id $$;
create schema vault; create table vault.secrets (name text primary key, secret text);
create view vault.decrypted_secrets as select name, secret as decrypted_secret from vault.secrets;
create schema cron; create table cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text);
create function cron.schedule(n text, s text, c text) returns bigint language sql as $$
  insert into cron.job (jobname, schedule, command) values (n, s, c) on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid $$;
create function cron.unschedule(n text) returns boolean language sql as $$ delete from cron.job where jobname = n returning true $$;
`;
let db;
const svc = sql => as(db, 'service_role', '', sql);
test.before(async () => { db = await supabaseDb(STUBS, SQL, SQL); });
test.after(() => db && db.close());

test('three schedules, in UTC, the same as the workflows had; safe to run again', async () => {
  const rows = (await db.query('select jobname, schedule, command from cron.job order by jobname')).rows;
  assert.deepEqual(rows.map(r => [r.jobname, r.schedule]), [['ingest-eod', '40 21 * * 1-5'], ['ingest-health', '15 6 * * *'], ['ingest-intraday', '7,22,37,52 7-21 * * 1-5']]);
  assert.match(rows.find(r => r.jobname === 'ingest-intraday').command, /ingest_dispatch\('ingest\.yml', 'intraday'\)/);
});

test('without the token nothing is sent, and the error says what is missing', async () => {
  await assert.rejects(svc(`select public.ingest_dispatch('ingest.yml', 'intraday')`), /github_dispatch_token is not set/);
  assert.equal((await db.query('select count(*)::int n from net.calls')).rows[0].n, 0);
});

test('a dispatch: the workflow on main, the job as input, the token only in the header', async () => {
  await db.exec(`insert into vault.secrets values ('github_dispatch_token', 'github_pat_${'x'.repeat(40)}')`);
  await svc(`select public.ingest_dispatch('ingest.yml', 'intraday')`);
  await svc(`select public.ingest_dispatch('health.yml')`);
  const calls = (await db.query('select url, headers, body from net.calls order by id')).rows;
  assert.equal(calls[0].url, 'https://api.github.com/repos/cyberther/StockNews/actions/workflows/ingest.yml/dispatches');
  assert.deepEqual(calls[0].body, { ref: 'main', inputs: { job: 'intraday' } });
  assert.equal(calls[0].headers.authorization, 'Bearer github_pat_' + 'x'.repeat(40));
  assert.equal(calls[0].headers.accept, 'application/vnd.github+json');
  assert.deepEqual(calls[1].body, { ref: 'main' });
  assert.match(calls[1].url, /health\.yml\/dispatches$/);
});

test('only known workflows and jobs; only the service role (and cron) may call it', async () => {
  await assert.rejects(svc(`select public.ingest_dispatch('deploy.yml')`), /unknown workflow/);
  await assert.rejects(svc(`select public.ingest_dispatch('ingest.yml', 'rm -rf')`), /unknown job/);
  await assert.rejects(as(db, 'authenticated', APPROVED, `select public.ingest_dispatch('ingest.yml', 'intraday')`), /permission denied/);
  await assert.rejects(as(db, 'anon', '', `select public.ingest_dispatch('ingest.yml', 'intraday')`), /permission denied/);
});
