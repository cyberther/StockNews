// supabase/policy-auto.sql (Politici 2.0): documents, fact sheets, automatic analyses, public
// contracts and state aid; the local batch writes only through secret-checked functions, readers
// only read when approved, and a published analysis still never changes (withdrawal aside).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { supabaseDb, as, APPROVED, WAITING } from './helpers/supabase-pg.js';

const read = f => readFileSync(new URL('../supabase/' + f, import.meta.url), 'utf8');
const ADMIN = '00000000-0000-0000-0000-00000000000a';
const SECRET = 's'.repeat(40);
const STUBS = `
alter table public.account_status add column is_admin boolean not null default false;
insert into public.account_status values ('${ADMIN}', true, false, true);
create function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.account_status s where s.user_id = auth.uid() and s.is_admin and s.approved and not s.suspended) $$;
grant execute on function public.is_admin() to authenticated;
create function public.summary_secret_ok(p_secret text) returns boolean language sql stable as $$ select p_secret = '${SECRET}' $$;
revoke all on function public.summary_secret_ok(text) from public, anon, authenticated;
create table public.watchlist (user_id uuid not null, ticker text not null, push boolean not null default true, primary key (user_id, ticker));
create table public.holdings (user_id uuid not null, ticker text not null, shares numeric not null, primary key (user_id, ticker));
create table public.push_subscriptions (endpoint text primary key, user_id uuid not null, p256dh text not null, auth text not null);
`;
let db;
const svc = async sql => {
  await db.exec(`set role service_role; select set_config('request.jwt.claim.sub', '', false);`);
  try { return /;\s*\S/.test(sql) ? (await db.exec(sql)).at(-1) : await db.query(sql); } finally { await db.exec('reset role'); }
};
const user = (u, sql) => as(db, 'authenticated', u, sql);
const anon = sql => as(db, 'anon', '', sql);
const H1 = 'a'.repeat(64), H2 = 'b'.repeat(64);
const analysis = { id: 'auto-gov-hg-1', version: 1, origin: 'auto', title: 'HG 1', policy: 'auto-gov-hg-1', events: ['gov:hg-1'], sectors: [], companies: [], published_at: '2026-10-19' };
const results = [{ engine_version: '1.0.0', scenario: 'full', subject: 'budget', vals: { net: -1 }, formula: 'f' }];
const save = (payload, secret = SECRET) => anon(`select public.auto_save('${secret}', '${JSON.stringify(payload).replace(/'/g, "''")}'::jsonb) r`);

test.before(async () => {
  db = await supabaseDb(STUBS, read('policy.sql'));
  await db.exec(read('impact.sql'));
  await db.exec(read('policy-auto.sql'));
  await db.exec(read('policy-auto.sql'));   // safe to run again
  await svc(`insert into public.policy_events (id, title, event_date, institution, source_url, status, certainty, sectors, companies) values
    ('gov:hg-1', 'HG 1', '2026-10-01', 'Guvernul României', 'https://gov.ro/n1', 'adopted', 'official_act', '{}', '[]');
    insert into public.policy_documents (event_id, sha256, url, parts, text, chars, status) values
      ('gov:hg-1', '${H1}', 'https://gov.ro/n1', '[]', 'Bugetul este de 759 mil. lei.', 29, 'ok'),
      ('gov:hg-1', '${H2}', 'https://gov.ro/n1', '[]', 'Bugetul este de 800 mil. lei.', 29, 'ok');
    insert into public.fact_sheets (event_id, base, reasons, doc_sha256, origin) values ('gov:hg-1', '{"stage":"adopted"}', '{ai_pending}', '${H1}', 'cloud');
    insert into public.public_contracts (id, cui, ticker, authority, title, value_ron, signed_on, source_url) values
      ('seap:1', '5022670', 'TLV.RO', 'Primăria X', 'Servicii', 1000, '2026-09-01', 'https://data.gov.ro/x');`);
});
test.after(() => db && db.close());

test('the batch sees the documents still waiting, and saves an analysis once per document version', async () => {
  const pending = (await anon(`select event_id, doc_sha256 from public.auto_pending('${SECRET}', 10) order by doc_sha256`)).rows;
  assert.deepEqual(pending.map(r => r.doc_sha256), [H1, H2]);
  assert.equal((await save({ event_id: 'gov:hg-1', doc_sha256: H1, analysis, results })).rows[0].r.kind, 'analysis');
  assert.equal((await save({ event_id: 'gov:hg-1', doc_sha256: H1, analysis, results })).rows[0].r.kind, 'duplicate');
  const v2 = (await save({ event_id: 'gov:hg-1', doc_sha256: H2, analysis, results })).rows[0].r;
  assert.equal(v2.version, 2);
  const rows = (await svc(`select version, origin, doc_sha256, body->>'version' bv from public.impact_analyses where id = 'auto-gov-hg-1' order by version`)).rows;
  assert.deepEqual(rows.map(r => [r.version, r.origin, r.bv]), [[1, 'auto', '1'], [2, 'auto', '2']]);
  assert.equal((await svc(`select count(*)::int n from public.impact_results where analysis_id = 'auto-gov-hg-1'`)).rows[0].n, 2);
  assert.equal((await anon(`select count(*)::int n from public.auto_pending('${SECRET}', 10)`)).rows[0].n, 0);
});

test('a fact sheet with reasons; unknown reason codes and documents are refused', async () => {
  await svc(`insert into public.policy_events (id, title, event_date, institution, source_url, status, certainty, sectors, companies) values
    ('cdep:9', 'Proiect 9', '2026-10-02', 'Camera Deputaților', 'https://www.cdep.ro/9', 'draft', 'official_procedure', '{}', '[]');
    insert into public.policy_documents (event_id, sha256, url, parts, text, chars, status) values ('cdep:9', '${'c'.repeat(64)}', 'https://www.cdep.ro/9', '[]', 'x', 1, 'ok');`);
  const r = (await save({ event_id: 'cdep:9', doc_sha256: 'c'.repeat(64), summary: 'Ce schimbă.', reasons: ['no_financial_sheet', 'bogus'] })).rows[0].r;
  assert.equal(r.kind, 'sheet');
  const s = (await svc(`select summary, reasons, origin from public.fact_sheets where event_id = 'cdep:9'`)).rows[0];
  assert.deepEqual([s.summary, s.reasons, s.origin], ['Ce schimbă.', ['no_financial_sheet'], 'auto']);
  await assert.rejects(save({ event_id: 'cdep:9', doc_sha256: 'd'.repeat(64), reasons: [] }), /unknown document/);
  await assert.rejects(save({ event_id: 'cdep:9', doc_sha256: 'c'.repeat(64), reasons: [] }, 'wrong'), /not allowed/);
});

test('readers: approved only; nobody writes the tables directly', async () => {
  for (const t of ['policy_documents', 'fact_sheets', 'public_contracts', 'state_aid']) {
    assert.equal((await user(WAITING, `select 1 from public.${t}`)).rows.length, 0, t);
    await assert.rejects(anon(`select 1 from public.${t}`), /permission denied/, t);
    await assert.rejects(user(APPROVED, `insert into public.${t} default values`), /permission denied|violates/, t);
  }
  assert.ok((await user(APPROVED, `select 1 from public.fact_sheets`)).rows.length > 0);
  assert.ok((await user(APPROVED, `select 1 from public.public_contracts`)).rows.length > 0);
  await assert.rejects(user(APPROVED, `select public.auto_pending('${SECRET}', 1)`), /not allowed|permission/);
});

test('withdrawal: admins only, once, with a reason; the body still never changes', async () => {
  await assert.rejects(user(APPROVED, `select public.admin_withdraw_analysis('auto-gov-hg-1', 1, 'Cifră greșită în citat.')`), /not allowed/);
  assert.equal((await user(ADMIN, `select public.admin_withdraw_analysis('auto-gov-hg-1', 1, 'Cifră greșită în citat.') n`)).rows[0].n, 1);
  await assert.rejects(user(ADMIN, `select public.admin_withdraw_analysis('auto-gov-hg-1', 1, 'Din nou.')`), /already withdrawn/);
  const w = (await svc(`select withdrawn_reason, withdrawn_at is not null w from public.impact_analyses where id = 'auto-gov-hg-1' and version = 1`)).rows[0];
  assert.deepEqual([w.withdrawn_reason, w.w], ['Cifră greșită în citat.', true]);
  await assert.rejects(svc(`update public.impact_analyses set body = '{}' where id = 'auto-gov-hg-1' and version = 1`), /do not change/);
  await assert.rejects(svc(`update public.impact_analyses set withdrawn_reason = 'alt motiv' where id = 'auto-gov-hg-1' and version = 1`), /do not change/);
});
