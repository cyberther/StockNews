// supabase/transparency.sql: the public methodology page's numbers. Anyone can read them,
// signed in or not: counts, every withdrawn analysis with its reason, and every estimate set
// against what was reported later (direction and relative error only, never the lei figures).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { supabaseDb, as } from './helpers/supabase-pg.js';

const read = f => readFileSync(new URL('../supabase/' + f, import.meta.url), 'utf8');
const STUBS = `
alter table public.account_status add column is_admin boolean not null default false;
create function public.is_admin() returns boolean language sql stable as $$ select false $$;
create function public.summary_secret_ok(p_secret text) returns boolean language sql stable as $$ select false $$;
create table public.watchlist (user_id uuid not null, ticker text not null, push boolean not null default true, primary key (user_id, ticker));
create table public.holdings (user_id uuid not null, ticker text not null, shares numeric not null, primary key (user_id, ticker));
create table public.push_subscriptions (endpoint text primary key, user_id uuid not null, p256dh text not null, auth text not null);
`;
const H = c => c.repeat(64);
let db;
test.before(async () => {
  db = await supabaseDb(STUBS, read('policy.sql'));
  for (const f of ['impact.sql', 'policy-auto.sql', 'transparency.sql', 'transparency.sql']) await db.exec(read(f));
  await db.exec(`
    insert into public.policy_events (id, title, event_date, institution, source_url, status, certainty) values
      ('gov:1', 'HG 1', '2026-10-01', 'Guvernul României', 'https://gov.ro/1', 'adopted', 'official_act'),
      ('gov:2', 'HG 2', '2026-10-02', 'Guvernul României', 'https://gov.ro/2', 'adopted', 'official_act');
    insert into public.policy_documents (event_id, sha256, url, text, chars, status) values
      ('gov:1', '${H('a')}', 'https://gov.ro/1', 'text', 4, 'ok'), ('gov:2', '${H('b')}', 'https://gov.ro/2', '', 0, 'unreadable');
    insert into public.fact_sheets (event_id) values ('gov:1'), ('gov:2');
    insert into public.impact_analyses (id, version, published_at, title, policy, body, content_hash, origin) values
      ('acciza', 1, '2026-03-01', 'Acciza la motorină', 'acciza', '{}', '${H('c')}', 'manual'),
      ('auto-1', 1, '2026-10-10', 'Schema de ajutor', 'auto-1', '{}', '${H('d')}', 'auto'),
      ('auto-2', 1, '2026-10-11', 'Cifră luată din alt context', 'auto-2', '{}', '${H('e')}', 'auto');
    update public.impact_analyses set withdrawn_at = '2026-10-12', withdrawn_reason = 'cifra era din anexa altui act' where id = 'auto-2';
    insert into public.impact_results (analysis_id, version, engine_version, scenario, subject, vals, formula) values
      ('acciza', 1, '1.0.0', 'full', 'SNP.RO', '{"byYear": {"2026": -100}}', 'f'),
      ('acciza', 1, '1.0.0', 'full', 'RRC.RO', '{"byYear": {"2026": 50}}', 'f');
    insert into public.impact_outcomes (analysis_id, version, scenario, subject, metric, period, observed, source_url) values
      ('acciza', 1, 'full', 'SNP.RO', 'operating_profit_change', '2026', -150, 'https://bvb.ro/snp'),
      ('acciza', 1, 'full', 'RRC.RO', 'operating_profit_change', '2026', -10, 'https://bvb.ro/rrc');`);
});
test.after(() => db && db.close());

const pub = async role => (await as(db, role, role === 'anon' ? '' : '00000000-0000-0000-0000-000000000001', 'select public.public_transparency() t')).rows[0].t;

test('anyone can read it, signed in or not', async () => {
  for (const role of ['anon', 'authenticated']) assert.equal((await pub(role)).events, 2, role);
});

test('the counts: events, documents read and unreadable, sheets, analyses (withdrawn ones apart)', async () => {
  const t = await pub('anon');
  assert.equal(t.documents, 1); assert.equal(t.unreadable, 1); assert.equal(t.sheets, 2);
  assert.equal(t.analyses, 2); assert.equal(t.analyses_auto, 1);
});

test('every withdrawn analysis, with its reason', async () => {
  const t = await pub('anon');
  assert.deepEqual(t.withdrawn.map(w => [w.title, w.reason, w.withdrawn]), [['Cifră luată din alt context', 'cifra era din anexa altui act', '2026-10-12']]);
});

test('estimates against what was reported: direction and relative error, never the lei figures', async () => {
  const t = await pub('anon');
  assert.equal(t.compared, 2); assert.equal(t.direction_ok, 1);
  const snp = t.comparisons.find(c => c.subject === 'SNP.RO'), rrc = t.comparisons.find(c => c.subject === 'RRC.RO');
  assert.equal(snp.direction, true); assert.equal(Number(snp.rel_error), -0.5);
  assert.equal(rrc.direction, false); assert.equal(Number(rrc.rel_error), -1.2);
  assert.equal(Number(t.median_abs_error), 0.85);
  for (const c of t.comparisons) assert.deepEqual(Object.keys(c).sort(), ['direction', 'period', 'rel_error', 'source_url', 'subject', 'title']);
  assert.ok(!JSON.stringify(t).includes('-100') && !JSON.stringify(t).includes('-150'));
});

test('the page: Romanian and English, live figures written as text only, links only https', () => {
  const page = readFileSync(new URL('../templates/stock-news-web/methodology.html', import.meta.url), 'utf8');
  assert.match(page, /rpc\/public_transparency/);
  assert.doesNotMatch(page, /innerHTML|insertAdjacentHTML|document\.write/);
  assert.match(page, /const safe = u => \(\/\^https:/);
  for (const id of ['principles', 'sources', 'summaries', 'policy', 'impact', 'gains', 'accuracy', 'limits'])
    assert.equal((page.match(new RegExp('<section id="' + id + '">', 'g')) || []).length, 2, id);
});
