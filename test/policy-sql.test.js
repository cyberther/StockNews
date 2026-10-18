import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { supabaseDb, as, APPROVED, WAITING } from './helpers/supabase-pg.js';

const SQL = readFileSync(new URL('../supabase/policy.sql', import.meta.url), 'utf8');
let db;
test.before(async () => {
  db = await supabaseDb(SQL, SQL);
  await db.exec(`insert into public.policy_events (id, title, event_date, institution, initiator, source_url, status, certainty, sectors, companies)
    values ('cdep:1', 'Proiect de Lege privind accizele', '2026-10-01', 'Camera Deputaților', 'Guvern', 'https://www.cdep.ro/x', 'draft', 'official_procedure',
      '{petrol-gaze}', '[{"ticker":"SNP.RO","why":"sector","sector":"petrol-gaze"}]');
    insert into public.policy_event_history (event_id, field, old_value, new_value) values ('cdep:1', 'status', null, 'draft');`);
});
test.after(() => db && db.close());

test('approved accounts read events; signed out and waiting accounts do not', async () => {
  assert.equal((await as(db, 'authenticated', APPROVED, 'select id from public.policy_events')).rows.length, 1);
  assert.equal((await as(db, 'authenticated', WAITING, 'select id from public.policy_events')).rows.length, 0);
  await assert.rejects(as(db, 'anon', '', 'select id from public.policy_events'), /permission denied/);
});

test('filters the app uses work: by sector and by company', async () => {
  const q = s => as(db, 'authenticated', APPROVED, s).then(r => r.rows.length);
  assert.equal(await q(`select 1 from public.policy_events where sectors @> '{petrol-gaze}'`), 1);
  assert.equal(await q(`select 1 from public.policy_events where companies @> '[{"ticker":"SNP.RO"}]'`), 1);
  assert.equal(await q(`select 1 from public.policy_events where companies @> '[{"ticker":"TLV.RO"}]'`), 0);
});

test('only the service role writes; the history is not readable from the browser', async () => {
  await assert.rejects(as(db, 'authenticated', APPROVED, `update public.policy_events set status = 'adopted'`), /permission denied/);
  await assert.rejects(as(db, 'authenticated', APPROVED, `select * from public.policy_event_history`), /permission denied/);
  await as(db, 'service_role', '', `update public.policy_events set status = 'adopted' where id = 'cdep:1'`);
});

test('status and certainty only take the documented values', async () => {
  const ins = (st, ce) => db.query(`insert into public.policy_events (id, title, event_date, institution, source_url, status, certainty)
    values ('x:${st}${ce}', 't', '2026-10-01', 'i', 'https://e.ro', '${st}', '${ce}')`);
  await assert.rejects(ins('rumour', 'official_act'), /violates check/);
  await assert.rejects(ins('draft', 'probably'), /violates check/);
  for (const st of ['statement', 'draft', 'adopted', 'in_force', 'implemented', 'stopped']) await ins(st, 'official_act');
  await assert.rejects(db.query(`insert into public.policy_events (id, title, event_date, institution, source_url, status, certainty)
    values ('y', 't', '2026-10-01', 'i', 'javascript:alert(1)', 'draft', 'official_act')`), /violates check/);
});
