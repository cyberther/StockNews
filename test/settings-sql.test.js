// Each account's settings (supabase/settings.sql), on the table server/schema.sql made for the
// app's UI state, which production already has (2026-10-24): an approved account reads and
// writes its own row only; a waiting account, another account and anon get nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { supabaseDb, as, APPROVED, WAITING } from './helpers/supabase-pg.js';

const read = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const OTHER = '00000000-0000-0000-0000-000000000003';
// The table as server/schema.sql made it (its policies did not ask for an approved account).
const OLD = read('server/schema.sql').split('-- security_events')[0].replace(/^[\s\S]*?(create table if not exists public\.user_settings)/, '$1');
let db;
test.before(async () => {
  db = await supabaseDb(`create table auth.users (id uuid primary key);
    insert into auth.users values ('${APPROVED}'), ('${WAITING}'), ('${OTHER}');
    insert into public.account_status values ('${OTHER}', true, false);
    grant all on all tables in schema public to authenticated;
    alter default privileges in schema public grant all on tables to authenticated;`, OLD, read('supabase/settings.sql'));
  await db.exec(`insert into public.user_settings (user_id, data) values ('${OTHER}', '{"theme":"light"}')`);
});
test.after(() => db && db.close());
const q = async (u, sql) => (await as(db, 'authenticated', u, sql)).rows;

test('an approved account saves and reads back its own settings, and only its own', async () => {
  await q(APPROVED, `insert into public.user_settings (user_id, data) values ('${APPROVED}', '{"theme":"dark","lcIv":"1d"}')
    on conflict (user_id) do update set data = excluded.data`);
  await q(APPROVED, `insert into public.user_settings (user_id, data) values ('${APPROVED}', '{"theme":"light"}')
    on conflict (user_id) do update set data = excluded.data`);
  assert.deepEqual((await q(APPROVED, 'select user_id, data from public.user_settings')).map(r => [r.user_id, r.data]), [[APPROVED, { theme: 'light' }]]);
  await assert.rejects(q(APPROVED, `insert into public.user_settings (user_id, data) values ('${OTHER}', '{}')`), /row-level security/);
  await q(APPROVED, `update public.user_settings set data = '{}' where user_id = '${OTHER}'`);
  assert.deepEqual((await db.query(`select data from public.user_settings where user_id = '${OTHER}'`)).rows[0].data, { theme: 'light' }, "another account's row is untouched");
});

test('a waiting account and anon get nothing; only objects of a sensible size are kept', async () => {
  assert.equal((await q(WAITING, 'select * from public.user_settings')).length, 0);
  await assert.rejects(q(WAITING, `insert into public.user_settings (user_id, data) values ('${WAITING}', '{}')`), /row-level security/);
  await assert.rejects(as(db, 'anon', '', 'select * from public.user_settings'), /permission denied/);
  await assert.rejects(q(APPROVED, `update public.user_settings set data = '[1]' where user_id = '${APPROVED}'`), /user_settings_is_object/);
  await assert.rejects(q(APPROVED, `update public.user_settings set data = (select jsonb_build_object('x', string_agg(md5(random()::text || i), '')) from generate_series(1, 4000) i) where user_id = '${APPROVED}'`), /user_settings_size/);
});

test('readers get no rights beyond reading and writing rows (no truncate)', async () => {
  const privs = (await db.query(`select privilege_type from information_schema.role_table_grants
    where table_name = 'user_settings' and grantee = 'authenticated' order by 1`)).rows.map(r => r.privilege_type);
  assert.deepEqual(privs, ['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
});

test('running the file again changes nothing', async () => {
  await db.exec(read('supabase/settings.sql'));
  assert.equal((await q(APPROVED, 'select * from public.user_settings')).length, 1);
});
