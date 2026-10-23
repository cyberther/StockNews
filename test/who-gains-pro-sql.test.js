// "Cine câștigă" in Pro (2026-10-24, the owner's call): with the commercial rules on, the
// contracts and state aid company by company are read by Pro accounts only; every approved
// reader keeps the measures and the sums by kind of purchase (sector_state_flows). With the
// rules off, nothing changes. Run order: policy-auto.sql, then billing.sql.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { supabaseDb, as, APPROVED, WAITING } from './helpers/supabase-pg.js';
import { PAYER, BILLING_STUBS, BILLING_SQL } from './helpers/billing-stubs.js';

const read = f => readFileSync(new URL('../supabase/' + f, import.meta.url), 'utf8');
const STUBS = BILLING_STUBS + `
create function public.summary_secret_ok(p_secret text) returns boolean language sql stable as $$ select false $$;
create table public.push_subscriptions (endpoint text primary key, user_id uuid not null, p256dh text not null, auth text not null);
`;
let db;
const q = async (u, sql) => (await as(db, 'authenticated', u, sql)).rows;
const commercial = on => db.exec(`update public.app_config set value = '${on}' where key = 'commercial_mode'`);
test.before(async () => {
  db = await supabaseDb(STUBS, read('policy.sql'));
  for (const f of ['impact.sql', 'policy-auto.sql']) await db.exec(read(f));
  await db.exec(BILLING_SQL);
  await db.exec(`
    insert into public.public_contracts (id, cui, ticker, authority, title, cpv, value_ron, signed_on, source_url) values
      ('c1', '1', 'TGN.RO', 'CNAIR', 'Lucrări', '45233000-9', 1000000, current_date - 10, 'https://e-licitatie.ro/c1'),
      ('c2', '2', 'H2O.RO', 'ANRE', 'Servicii', '71300000-1', 500000, current_date - 20, 'https://e-licitatie.ro/c2');
    insert into public.entitlements (user_id, source, status, current_period_end) values ('${PAYER}', 'payment', 'active', now() + interval '20 days');`);
});
test.after(() => db && db.close());

test('commercial rules off: every approved reader sees the contracts, as before', async () => {
  await commercial(false);
  assert.equal((await q(APPROVED, 'select * from public.public_contracts')).length, 2);
  assert.equal((await q(WAITING, 'select * from public.public_contracts')).length, 0);
});

test('commercial rules on: contracts, aid and their links are Pro; the sums by purchase stay for everyone approved', async () => {
  await commercial(true);
  try {
    assert.equal((await q(APPROVED, 'select * from public.public_contracts')).length, 0, 'Free');
    assert.equal((await q(APPROVED, 'select * from public.state_aid')).length, 0, 'Free');
    assert.equal((await q(APPROVED, "select * from public.state_links where link_type = 'contract'")).length, 0, 'Free: no contract links');
    assert.equal((await q(PAYER, 'select * from public.public_contracts')).length, 2, 'Pro');
    assert.equal((await q(PAYER, "select * from public.state_links where link_type = 'contract'")).length, 2, 'Pro');
    const flows = r => r.filter(x => x.dimension === 'cpv').reduce((a, x) => a + Number(x.inflow_ron), 0);
    assert.equal(flows(await q(APPROVED, 'select * from public.sector_state_flows')), 1500000, 'Free keeps the sums');
    assert.equal(flows(await q(WAITING, 'select * from public.sector_state_flows')), 0, 'not approved: nothing');
    await assert.rejects(as(db, 'anon', '', 'select * from public.sector_state_flows'), /permission denied/);
  } finally { await commercial(false); }
});

test('running policy-auto.sql again needs billing.sql after it (the order the files say)', () => {
  assert.match(BILLING_SQL, /policy-auto\.sql recreates these two policies: run this file after it/);
});
