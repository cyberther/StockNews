import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { supabaseDb, as, APPROVED, WAITING } from './helpers/supabase-pg.js';

import { ADMIN, PAYER, BILLING_STUBS, BILLING_SQL } from './helpers/billing-stubs.js';
const config = JSON.parse(readFileSync(new URL('../config/billing.json', import.meta.url), 'utf8'));

let db;
const svc = async sql => { await db.exec(`set role service_role; select set_config('request.jwt.claim.sub', '', false);`); try { return /;\s*\S/.test(sql) ? (await db.exec(sql)).at(-1) : await db.query(sql); } finally { await db.exec('reset role'); } };
const user = (u, sql) => as(db, 'authenticated', u, sql);
const commercial = on => db.exec(`update public.app_config set value = '${on}' where key = 'commercial_mode'`);
const plan = async u => (await user(u, 'select public.my_plan() p')).rows[0].p;
test.before(async () => { db = await supabaseDb(BILLING_STUBS, BILLING_SQL, BILLING_SQL); });
test.after(() => db && db.close());

test('commercial mode off (the default): every approved account is Pro, as today', async () => {
  assert.equal((await db.query(`select value from public.app_config where key = 'commercial_mode'`)).rows[0].value, false);
  assert.equal((await user(APPROVED, 'select public.is_pro() p')).rows[0].p, true);
  assert.equal((await user(WAITING, 'select public.is_pro() p')).rows[0].p, false);
  const p = await plan(APPROVED);
  assert.equal(p.plan, 'pro'); assert.equal(p.source, 'early_access'); assert.equal(p.commercial, false);
  assert.deepEqual(p.limits, config.limits.pro);
});

test('the server limits are the ones in config/billing.json', async () => {
  assert.deepEqual((await db.query(`select value from public.app_config where key = 'limits'`)).rows[0].value, config.limits);
});

test('commercial mode on: the plan follows the entitlements', async () => {
  await commercial(true);
  try {
    assert.equal((await plan(PAYER)).plan, 'free');
    assert.deepEqual((await plan(PAYER)).limits, config.limits.free);
    const set = (status, end, source = 'payment') => db.query(`insert into public.entitlements (user_id, source, status, current_period_end) values ($1, $2, $3, $4)
      on conflict (user_id, source) do update set status = excluded.status, current_period_end = excluded.current_period_end`, [PAYER, source, status, end]);
    const future = new Date(Date.now() + 864e5).toISOString(), past = new Date(Date.now() - 864e5).toISOString();
    const cur = async () => (await db.query(`select public.current_plan($1) p`, [PAYER])).rows[0].p;
    await set('active', future); assert.equal(await cur(), 'pro');
    await set('active', past); assert.equal(await cur(), 'free');
    await set('past_due', future); assert.equal(await cur(), 'pro', 'grace until the period ends');
    await set('cancelled', future); assert.equal(await cur(), 'pro', 'cancelled keeps access until ends_at');
    await set('expired', future); assert.equal(await cur(), 'free');
    await db.query(`delete from public.entitlements`);
    await set('active', null, 'manual'); assert.equal(await cur(), 'pro', 'manual without an end');
    assert.equal((await user(PAYER, 'select public.is_pro() p')).rows[0].p, true);
    // The cached plan on account_status follows.
    assert.equal((await db.query(`select plan from public.account_status where user_id = $1`, [PAYER])).rows[0].plan, 'pro');
    await db.query(`delete from public.entitlements`);
    assert.equal((await db.query(`select plan from public.account_status where user_id = $1`, [PAYER])).rows[0].plan, 'free');
  } finally { await commercial(false); }
});

test('the browser reads its own entitlement, writes nothing', async () => {
  await db.query(`insert into public.entitlements (user_id, source, status, current_period_end, portal_url) values ($1, 'payment', 'active', now() + interval '30 days', 'https://x.lemonsqueezy.com/p')`, [PAYER]);
  assert.equal((await user(PAYER, 'select * from public.entitlements')).rows.length, 1);
  assert.equal((await user(APPROVED, 'select * from public.entitlements')).rows.length, 0);
  for (const sql of [`update public.entitlements set status = 'active'`, `insert into public.entitlements (user_id, source, status) values ('${APPROVED}', 'manual', 'active')`,
    `update public.app_config set value = 'false'`, `select * from public.app_config`])
    await assert.rejects(user(APPROVED, sql), /permission denied/, sql);
  await assert.rejects(as(db, 'anon', '', 'select public.my_plan()'), /permission denied/);
  await commercial(true);
  try {
    const p = await plan(PAYER);
    assert.equal(p.plan, 'pro'); assert.equal(p.source, 'payment'); assert.equal(p.status, 'active'); assert.equal(p.portal_url, 'https://x.lemonsqueezy.com/p');
    assert.ok(p.period_end);
  } finally { await commercial(false); await db.query('delete from public.entitlements'); }
});

test('admins give and take Pro by hand; nobody else can', async () => {
  await assert.rejects(user(APPROVED, `select public.admin_grant_pro('${PAYER}', null)`), /not allowed/);
  assert.equal((await user(ADMIN, `select public.admin_grant_pro('${PAYER}', now() + interval '30 days') n`)).rows[0].n, 1);
  await commercial(true);
  try {
    assert.equal((await plan(PAYER)).source, 'manual');
    await assert.rejects(user(APPROVED, `select public.admin_revoke_pro('${PAYER}')`), /not allowed/);
    assert.equal((await user(ADMIN, `select public.admin_revoke_pro('${PAYER}') n`)).rows[0].n, 1);
    assert.equal((await plan(PAYER)).plan, 'free');
  } finally { await commercial(false); }
});
