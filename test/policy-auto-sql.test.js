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
  await assert.rejects(user(APPROVED, `select 1 from public.state_sources`), /permission denied/);
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

test('the PC reads the Chamber: it lists events without documents and saves their text; a base sheet never replaces the batch\'s', async () => {
  await svc(`insert into public.policy_events (id, title, event_date, institution, source_url, status, certainty, sectors, companies) values
    ('cdep:10', 'Proiect 10', '2026-10-03', 'Camera Deputaților', 'https://www.cdep.ro/10', 'draft', 'official_procedure', '{}', '[]')`);
  const missing = (await anon(`select event_id, source_url from public.docs_missing('${SECRET}', 10)`)).rows;
  assert.deepEqual(missing.map(r => r.event_id), ['cdep:10']);
  const row = { event_id: 'cdep:10', sha256: 'e'.repeat(64), url: 'https://www.cdep.ro/10.pdf', parts: [{ kind: 'law', url: 'https://www.cdep.ro/10.pdf', status: 'ok', from: 0, to: 9 }], text: 'Art. 1. X', status: 'ok' };
  assert.equal((await anon(`select public.documents_save('${SECRET}', '${JSON.stringify([row, { ...row, event_id: 'cdep:nope' }])}'::jsonb) n`)).rows[0].n, 1);
  assert.equal((await anon(`select public.documents_save('${SECRET}', '${JSON.stringify([row])}'::jsonb) n`)).rows[0].n, 0, 'same text twice: nothing new');
  assert.equal((await anon(`select count(*)::int n from public.docs_missing('${SECRET}', 10)`)).rows[0].n, 0);
  await assert.rejects(anon(`select public.documents_save('wrong', '[]'::jsonb)`), /not allowed/);
  await assert.rejects(anon(`select public.documents_save('${SECRET}', '${JSON.stringify([{ ...row, url: 'http://x' }])}'::jsonb)`), /https/);
  // The ingestion's base sheet arrives after the batch's: the batch's stays.
  await svc(`update public.fact_sheets set base = '{"stage":"nou"}', reasons = '{ai_pending}', origin = 'cloud' where event_id = 'cdep:9'`);
  const s = (await svc(`select summary, origin, reasons from public.fact_sheets where event_id = 'cdep:9'`)).rows[0];
  assert.deepEqual([s.summary, s.origin, s.reasons], ['Ce schimbă.', 'auto', ['no_financial_sheet']]);
});

test('who gains: links with evidence, exposure per company, money per kind of purchase', async () => {
  await svc(`insert into public.policy_events (id, title, event_date, institution, source_url, status, certainty, sectors, companies) values
    ('cdep:20', 'Taxă nouă', '2026-09-01', 'Camera Deputaților', 'https://www.cdep.ro/20', 'adopted', 'official_act', '{petrol-gaze}',
     '[{"ticker":"SNP.RO","why":"mentioned"},{"ticker":"SNG.RO","why":"sector","sector":"petrol-gaze"}]');
    insert into public.company_financials (ticker, fiscal_year, revenue, operating_profit, source_url, provenance, verified) values
      ('TLV.RO', 2025, 100000, 50, 'https://x.ro/a.pdf', 'manual', true);
    insert into public.public_contracts (id, cui, ticker, authority, title, cpv, value_ron, signed_on, source_url) values
      ('seap:2', '5022670', 'TLV.RO', 'Primăria Y', 'Servicii', '66110000-4', 5000, current_date - 30, 'https://data.gov.ro/y'),
      ('seap:old', '5022670', 'TLV.RO', 'Primăria Z', 'Servicii', '66110000-4', 7000, current_date - 500, 'https://data.gov.ro/z');
    insert into public.impact_analyses (id, version, published_at, title, policy, events, sectors, body, content_hash, origin)
      values ('auto-cdep-20', 1, '2026-09-02', 'Taxă', 'auto-cdep-20', '{cdep:20}', '{petrol-gaze}', '{"facts":[{"source_url":"https://www.cdep.ro/20.pdf"}]}', '${'f'.repeat(64)}', 'auto');
    insert into public.impact_results (analysis_id, version, engine_version, scenario, subject, vals, formula) values
      ('auto-cdep-20', 1, '1.0.0', 'full', 'SNP.RO', '{"profitDelta":-100,"pctOfProfit":-2}', 'f'),
      ('auto-cdep-20', 1, '1.0.0', 'partial', 'SNP.RO', '{"profitDelta":-50}', 'f');`);
  const links = (await user(APPROVED, `select subject_ticker t, link_type, direction, evidence_url, amount_ron::float a from public.state_links order by t, link_type, a`)).rows;
  const has = (t, type, dir) => links.find(l => l.t === t && l.link_type === type && l.direction === dir);
  assert.ok(has('TLV.RO', 'contract', 'gains').evidence_url.startsWith('https://data.gov.ro/'));
  const tax = has('SNP.RO', 'tax_payer', 'loses');
  assert.equal(tax.evidence_url, 'https://www.cdep.ro/20.pdf');
  assert.equal(links.filter(l => l.t === 'SNP.RO' && l.link_type === 'tax_payer').length, 1, 'one link per analysis, from the full scenario');
  assert.ok(has('SNP.RO', 'named', 'neutral'));
  const titled = (await user(APPROVED, `select title from public.state_links where link_type = 'contract' and amount_ron = 5000`)).rows[0];
  assert.equal(titled.title, 'Primăria Y · CPV 66110000-4');
  assert.ok(has('SNG.RO', 'sector', 'neutral'), 'a sector link has no direction without a fact');
  const ex = (await user(APPROVED, `select ticker, contracts_12m_ron::float c, contracts_12m_pct_revenue::float p, measures_lose from public.company_state_exposure where ticker in ('TLV.RO','SNP.RO') order by ticker`)).rows;
  assert.deepEqual(ex.find(r => r.ticker === 'TLV.RO'), { ticker: 'TLV.RO', c: 6000, p: 6, measures_lose: 0 });   // 1000 (Task 5) + 5000; the 500-day-old one is out
  assert.equal(ex.find(r => r.ticker === 'SNP.RO').measures_lose, 1);
  assert.equal(ex.find(r => r.ticker === 'SNP.RO').p, null, 'no audited revenue: no percentage');
  const flows = (await user(APPROVED, `select dimension, key, inflow_ron::float i from public.sector_state_flows where dimension = 'cpv' and key = '66'`)).rows;
  assert.ok(flows.length >= 1 && flows.some(f => f.i === 5000));
  // Withdrawn: its links go.
  await user(ADMIN, `select public.admin_withdraw_analysis('auto-cdep-20', 1, 'Test retragere.')`);
  assert.equal((await user(APPROVED, `select count(*)::int n from public.state_links where link_type = 'tax_payer'`)).rows[0].n, 0);
  assert.equal((await user(WAITING, `select count(*)::int n from public.state_links`)).rows[0].n, 0);
});
