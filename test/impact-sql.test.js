import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { supabaseDb, as, APPROVED, WAITING } from './helpers/supabase-pg.js';

const POLICY = readFileSync(new URL('../supabase/policy.sql', import.meta.url), 'utf8');
const IMPACT = readFileSync(new URL('../supabase/impact.sql', import.meta.url), 'utf8');
const ADMIN = '00000000-0000-0000-0000-00000000000a';
const OTHER = '00000000-0000-0000-0000-000000000003';
const SECRET = 's'.repeat(40);
// The parts of approval.sql, push.sql, holdings.sql and summaries.sql impact.sql relies on.
const STUBS = `
alter table public.account_status add column is_admin boolean not null default false;
insert into public.account_status values ('${ADMIN}', true, false, true), ('${OTHER}', true, false, false);
create function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.account_status s where s.user_id = auth.uid() and s.is_admin and s.approved and not s.suspended) $$;
grant execute on function public.is_admin() to authenticated;
create function public.summary_secret_ok(p_secret text) returns boolean language sql stable as $$ select p_secret = '${SECRET}' $$;
revoke all on function public.summary_secret_ok(text) from public, anon, authenticated;
create table public.watchlist (user_id uuid not null, ticker text not null, push boolean not null default true, primary key (user_id, ticker));
create table public.holdings (user_id uuid not null, ticker text not null, shares numeric not null, primary key (user_id, ticker));
create table public.push_subscriptions (endpoint text primary key, user_id uuid not null, p256dh text not null, auth text not null);
`;
const EXISTING = `insert into public.policy_events (id, title, event_date, institution, source_url, status, certainty, sectors, companies)
  values ('cdep:old', 'Lege veche', '2026-01-01', 'Camera Deputaților', 'https://www.cdep.ro/o', 'adopted', 'official_act', '{sanatate-farma}',
    '[{"ticker":"M.RO","why":"mentioned"}]');
  insert into public.policy_event_history (event_id, field, old_value, new_value) values ('cdep:old', 'status', 'draft', 'adopted');`;
const body = { id: 'sample-measure', version: 1, companies: [{ ticker: 'M.RO' }, { ticker: 'SNP.RO' }], sectors: ['fiscal-general'], events: ['cdep:new'] };

let db;
// The service role, for one statement or several.
const svc = async sql => {
  await db.exec(`set role service_role; select set_config('request.jwt.claim.sub', '', false);`);
  try { return /;\s*\S/.test(sql) ? (await db.exec(sql)).at(-1) : await db.query(sql); } finally { await db.exec('reset role'); }
};
const user = (u, sql) => as(db, 'authenticated', u, sql);
test.before(async () => {
  db = await supabaseDb(STUBS, POLICY);
  await db.exec(EXISTING);
  await db.exec(IMPACT);
  await db.exec(IMPACT);   // safe to run again
  await svc(`insert into public.company_financials (ticker, fiscal_year, revenue, operating_profit, source_url, provenance, verified) values
    ('M.RO', 2025, 1000, 150, 'https://x.ro/a.pdf', 'manual', true), ('SNP.RO', 2025, 1000, 150, 'https://x.ro/b.pdf', 'filing_auto', false);
    insert into public.policy_events (id, title, event_date, institution, source_url, status, certainty, sectors, companies) values
    ('cdep:new', 'Proiect nou', '2026-10-10', 'Camera Deputaților', 'https://www.cdep.ro/n', 'draft', 'official_procedure', '{fiscal-general}',
      '[{"ticker":"M.RO","why":"mentioned"},{"ticker":"SNP.RO","why":"sector","sector":"fiscal-general"}]');
    insert into public.impact_analyses (id, version, published_at, title, policy, events, sectors, body, content_hash)
      values ('sample-measure', 1, '2026-10-19', 'Măsură', 'sample-policy', '{cdep:new}', '{fiscal-general}', '${JSON.stringify(body)}', '${'a'.repeat(64)}');
    insert into public.impact_results (analysis_id, version, engine_version, scenario, subject, vals, formula) values
      ('sample-measure', 1, '1.0.0', 'full', 'M.RO', '{"profitDelta":-4.8,"pctOfProfit":-3.2,"byYear":{"2026":-4.8,"2027":-4.8}}', 'f'),
      ('sample-measure', 1, '1.0.0', 'full', 'budget', '{"net":-9e9,"byYear":{"2026":-9e9}}', 'f');
    insert into public.impact_outcomes (analysis_id, version, scenario, subject, metric, period, observed, source_url) values
      ('sample-measure', 1, 'full', 'M.RO', 'operating_profit_change', '2026', -4.0, 'https://x.ro/c.pdf');`);
});
test.after(() => db && db.close());

test('approved accounts read analyses, results, outcomes and verified figures; others read nothing', async () => {
  for (const t of ['impact_analyses', 'impact_results', 'impact_outcomes']) {
    assert.ok((await user(APPROVED, `select 1 from public.${t}`)).rows.length > 0, t);
    assert.equal((await user(WAITING, `select 1 from public.${t}`)).rows.length, 0, t);
    await assert.rejects(as(db, 'anon', '', `select 1 from public.${t}`), /permission denied/, t);
  }
  assert.deepEqual((await user(APPROVED, 'select ticker from public.company_financials')).rows.map(r => r.ticker), ['M.RO']);
  assert.equal((await user(ADMIN, 'select ticker from public.company_financials')).rows.length, 2);
});

test('the browser writes none of the new tables', async () => {
  for (const sql of [`insert into public.company_financials (ticker, fiscal_year, revenue, operating_profit, source_url) values ('M.RO', 2024, 1, 1, 'https://x.ro')`,
    `update public.impact_analyses set title = 'x'`, `delete from public.impact_results`, `insert into public.impact_outcomes (analysis_id) values ('x')`,
    `update public.ai_annotations set status = 'verified'`])
    await assert.rejects(user(ADMIN, sql), /permission denied/, sql);
});

test('a published analysis and its results never change; only alerted_at may be set', async () => {
  await assert.rejects(svc(`update public.impact_analyses set title = 'altul'`), /published analyses do not change/);
  await assert.rejects(svc(`update public.impact_analyses set body = '{}'`), /published analyses do not change/);
  await assert.rejects(svc(`delete from public.impact_analyses`), /published analyses do not change/);
  await assert.rejects(svc(`update public.impact_results set formula = 'x'`), /results do not change/);
  await assert.rejects(svc(`delete from public.impact_results`), /results do not change/);
  await svc(`update public.impact_analyses set alerted_at = null`);
});

test('the rows that existed before the migration count as alerted', async () => {
  assert.equal((await db.query(`select count(*)::int n from public.policy_events where id = 'cdep:old' and alerted_at is null`)).rows[0].n, 0);
  assert.equal((await db.query(`select count(*)::int n from public.policy_event_history where alerted_at is null`)).rows[0].n, 0);
});

async function due() {
  return (await svc(`select user_id, items from public.policy_alerts_due(now() - interval '1 day') order by user_id`)).rows;
}
test('policy alerts: who gets what', async () => {
  await svc(`delete from public.watchlist; delete from public.holdings; delete from public.push_subscriptions;
    insert into public.watchlist values ('${APPROVED}', 'M.RO', true), ('${OTHER}', 'SNP.RO', true);
    insert into public.holdings values ('${ADMIN}', 'M.RO', 10);
    insert into public.push_subscriptions values ('https://p/1', '${APPROVED}', 'k', 'a'), ('https://p/2', '${OTHER}', 'k', 'a'), ('https://p/3', '${ADMIN}', 'k', 'a');`);
  let rows = await due();
  // M.RO is mentioned in the new bill (any status) and in the new analysis; SNP.RO only by sector in a draft: no event alert.
  const forUser = id => rows.find(r => r.user_id === id);
  assert.equal(rows.filter(r => r.user_id === APPROVED).length, 1, 'one row per user');
  assert.deepEqual(forUser(APPROVED).items.map(i => i.type + ':' + i.id).sort(), ['analysis:sample-measure', 'event:cdep:new']);
  assert.ok(forUser(ADMIN), 'holdings count too');
  assert.deepEqual(forUser(OTHER).items.map(i => i.type + ':' + i.id), ['analysis:sample-measure'], 'sector link on a draft does not alert');
  // Adopted: the sector link alerts too.
  await svc(`update public.policy_events set status = 'adopted' where id = 'cdep:new'`);
  rows = await due();
  assert.deepEqual(forUser(OTHER).items.map(i => i.type + ':' + i.id).sort(), ['analysis:sample-measure', 'event:cdep:new']);
  // A device with policy alerts off, or push off for the ticker, takes the user out.
  await svc(`update public.push_subscriptions set policy_alerts = false where user_id = '${APPROVED}'`);
  rows = await due();
  assert.equal(forUser(APPROVED), undefined);
  await svc(`update public.push_subscriptions set policy_alerts = true; update public.watchlist set push = false where user_id = '${APPROVED}'`);
  rows = await due();
  assert.equal(forUser(APPROVED), undefined);
  await svc(`update public.watchlist set push = true`);
});

test('a status change of an event already alerted alerts again, once', async () => {
  await svc(`select public.policy_alerts_mark(now())`);
  assert.deepEqual(await due(), []);
  await svc(`insert into public.policy_event_history (event_id, field, old_value, new_value) values ('cdep:old', 'status', 'adopted', 'stopped')`);
  const rows = await due();
  assert.deepEqual(rows.find(r => r.user_id === APPROVED).items.map(i => i.type + ':' + i.id + ':' + i.status), ['event:cdep:old:stopped']);
  await svc(`select public.policy_alerts_mark(now())`);
  assert.deepEqual(await due(), []);
});

test('alert functions are for the service role only', async () => {
  await assert.rejects(user(ADMIN, `select * from public.policy_alerts_due(now())`), /permission denied/);
  await assert.rejects(user(ADMIN, `select public.policy_alerts_mark(now())`), /permission denied/);
});

test('AI annotations: saved unverified with the secret, reviewed by an admin, shown once verified', async () => {
  const rows = JSON.stringify([{ target_id: 'cdep:new', kind: 'summary', content: { text: 'Rezumat.' }, model: 'm' },
    { target_id: 'cdep:none', kind: 'summary', content: { text: 'x' }, model: 'm' }, { target_id: 'cdep:new', kind: 'opinion', content: {}, model: 'm' }]);
  await assert.rejects(svc(`select public.ai_annotations_save('wrong', '${rows}')`), /not allowed/);
  assert.equal((await svc(`select public.ai_annotations_save('${SECRET}', '${rows}') n`)).rows[0].n, 1, 'unknown targets and kinds are skipped');
  assert.equal((await db.query(`select status from public.ai_annotations`)).rows[0].status, 'unverified');
  assert.equal((await user(APPROVED, 'select 1 from public.ai_annotations')).rows.length, 0);
  assert.equal((await user(ADMIN, 'select * from public.admin_ai_pending()')).rows.length, 1);
  await assert.rejects(user(APPROVED, 'select * from public.admin_ai_pending()'), /not allowed/);
  const id = (await db.query('select id from public.ai_annotations')).rows[0].id;
  await assert.rejects(user(APPROVED, `select public.admin_ai_review(${id}, 'verified')`), /not allowed/);
  await assert.rejects(user(ADMIN, `select public.admin_ai_review(${id}, 'great')`), /decision/);
  assert.equal((await user(ADMIN, `select public.admin_ai_review(${id}, 'verified') n`)).rows[0].n, 1);
  assert.equal((await user(APPROVED, 'select 1 from public.ai_annotations')).rows.length, 1);
  // A verified annotation is not overwritten by the next batch.
  await svc(`select public.ai_annotations_save('${SECRET}', '[{"target_id":"cdep:new","kind":"summary","content":{"text":"Alt."},"model":"m"}]')`);
  assert.equal((await db.query(`select content->>'text' t, status from public.ai_annotations`)).rows[0].t, 'Rezumat.');
});

test('the knowledge graph links events, sectors, companies, instruments, policies, scenarios and outcomes', async () => {
  const edges = (await user(APPROVED, 'select src_type, relation, dst_type from public.knowledge_edges')).rows.map(r => r.src_type + '-' + r.relation + '-' + r.dst_type);
  for (const e of ['event-classified_as-sector', 'event-affects-company', 'policy-evidenced_by-event', 'policy-targets-sector',
    'policy-modelled_as-scenario', 'scenario-estimates-company', 'company-listed_as-instrument', 'outcome-observes-scenario'])
    assert.ok(edges.includes(e), e);
  assert.equal((await user(WAITING, 'select 1 from public.knowledge_edges')).rows.length, 0);
  const nodes = (await user(APPROVED, `select type, id, label from public.knowledge_nodes where type = 'event' and id = 'cdep:new'`)).rows;
  assert.deepEqual(nodes, [{ type: 'event', id: 'cdep:new', label: 'Proiect nou' }]);
});

test('accuracy compares the frozen estimate with the observed result', async () => {
  const r = (await user(APPROVED, 'select subject, period, estimated::float8 e, observed::float8 o, error::float8 err, rel_error::float8 rel, direction from public.analysis_accuracy')).rows;
  assert.deepEqual(r, [{ subject: 'M.RO', period: '2026', e: -4.8, o: -4, err: 0.8, rel: 0.1666666667, direction: true }]);
});

test('company exposure counts the events and analyses behind each company', async () => {
  const r = (await user(APPROVED, `select * from public.company_exposure where ticker = 'M.RO'`)).rows[0];
  assert.equal(r.mentioned, 2);
  assert.equal(r.analyses, 1);
});
