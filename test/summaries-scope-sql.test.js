// The local model's summaries and day digests (supabase/summaries.sql, supabase/digests.sql)
// cover Bucharest listings only for now: the other stories are still stored and shown, just
// not summarised. public.summary_scope(ticker) is the one place that decides.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { supabaseDb } from './helpers/supabase-pg.js';

const SECRET = 's'.repeat(40);
const STUBS = `
create table auth.users (id uuid primary key, raw_user_meta_data jsonb default '{}');
create schema vault; create view vault.decrypted_secrets as select 'summary_secret'::text as name, '${SECRET}'::text as decrypted_secret;
create table public.watchlist (user_id uuid, ticker text, push boolean default true);
create table public.holdings (user_id uuid, ticker text, shares numeric);
create schema cron; create table cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text);
create function cron.schedule(n text, s text, c text) returns bigint language sql as $$
  insert into cron.job (jobname, schedule, command) values (n, s, c) on conflict (jobname) do update set schedule = excluded.schedule returning jobid $$;
create function cron.unschedule(n text) returns boolean language sql as $$ delete from cron.job where jobname = n returning true $$;
create function cron.unschedule(i bigint) returns boolean language sql as $$ delete from cron.job where jobid = i returning true $$;
` + readFileSync(new URL('../supabase/push.sql', import.meta.url), 'utf8').match(/create or replace function public\.business_day_start[\s\S]*?\$\$;/)[0];
const read = f => readFileSync(new URL('../supabase/' + f, import.meta.url), 'utf8');
let db;
test.before(async () => {
  db = await supabaseDb(STUBS, read('summaries.sql'), read('digests.sql'));
  // Yesterday's and today's stories on a Bucharest, a US, a German and a London listing.
  await db.exec(`insert into public.stories (id, ticker, headline, source, url, published_at) values
    ('SNP.RO:1', 'SNP.RO', 'Petrom anunță rezultatele', 'ZF', 'https://zf.ro/1', now() - interval '1 hour'),
    ('AAPL:1', 'AAPL', 'Apple launches a phone', 'CNBC', 'https://cnbc.com/1', now() - interval '1 hour'),
    ('BMW.DE:1', 'BMW.DE', 'BMW sales rise', 'Reuters', 'https://reuters.com/1', now() - interval '1 hour'),
    ('BARC.L:1', 'BARC.L', 'Barclays results', 'FT', 'https://ft.com/1', now() - interval '1 hour')`);
  const w = (await db.query('select t0, t1 from public.digest_window()')).rows[0];
  await db.query(`insert into public.stories (id, ticker, headline, source, url, published_at) values
    ('SNP.RO:2', 'SNP.RO', 'Petrom: dividend', 'ZF', 'https://zf.ro/2', $1), ('AAPL:2', 'AAPL', 'Apple earnings', 'CNBC', 'https://cnbc.com/2', $1)`,
    [new Date((Date.parse(w.t0) + Date.parse(w.t1)) / 2).toISOString()]);
});
test.after(() => db && db.close());

test('only .RO tickers are in scope', async () => {
  const ok = async t => (await db.query('select public.summary_scope($1) ok', [t])).rows[0].ok;
  assert.equal(await ok('SNP.RO'), true);
  for (const t of ['AAPL', 'BMW.DE', 'BARC.L', 'RO', 'X.ROX']) assert.equal(await ok(t), false, t);
});

test('story summaries: Bucharest stories only, in every language', async () => {
  for (const lang of ['ro', 'en', 'de']) {
    const rows = (await db.query(`select ticker from public.summaries_pending('${SECRET}', '${lang}', 50, 48)`)).rows.map(r => r.ticker);
    assert.ok(rows.length > 0 || lang !== 'ro', lang);
    assert.ok(rows.every(t => t.endsWith('.RO')), lang + ': ' + rows.join(','));
  }
});

test('day digests: Bucharest tickers only', async () => {
  const rows = (await db.query(`select ticker from public.digests_pending('${SECRET}', 'ro', 20)`)).rows.map(r => r.ticker);
  assert.deepEqual(rows, ['SNP.RO']);
  assert.deepEqual((await db.query(`select ticker from public.digests_pending('${SECRET}', 'ro', 20, 'AAPL')`)).rows, []);
});

// 2026-10-19, the owner's call: US and EU stories are summarised again, at the lowest priority.
// The batch asks for them separately (p_scope 'other') and only when nothing else is waiting.
test('story summaries for the other markets, only when asked for (p_scope other); the default stays Bucharest', async () => {
  const q = scope => db.query(`select ticker from public.summaries_pending('${SECRET}', 'ro', 50, 48${scope ? `, '${scope}'` : ''})`).then(r => r.rows.map(x => x.ticker).sort());
  assert.deepEqual([...new Set(await q())], ['SNP.RO']);
  assert.deepEqual([...new Set(await q('bvb'))], ['SNP.RO']);
  assert.deepEqual([...new Set(await q('other'))], ['AAPL', 'BARC.L', 'BMW.DE']);
});
