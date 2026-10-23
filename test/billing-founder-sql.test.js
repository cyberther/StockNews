// The founder price (supabase/billing.sql): 49 lei a month or 490 a year for the first 200
// subscribers, kept while the subscription stays active. Seats are counted on the server: a
// founder subscription that still gives access holds one, and so does a checkout started in
// the last two hours; the count shown is never above what is left.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { supabaseDb, as, APPROVED } from './helpers/supabase-pg.js';
import { PAYER, BILLING_STUBS, BILLING_SQL } from './helpers/billing-stubs.js';

const config = JSON.parse(readFileSync(new URL('../config/billing.json', import.meta.url), 'utf8'));
const FOUNDER_M = '501', FOUNDER_Y = '502', OTHER = '777';
const day = n => new Date(Date.now() + n * 864e5).toISOString();
let db, n = 0;
const svc = async (sql, params) => { await db.exec('set role service_role'); try { return await db.query(sql, params); } finally { await db.exec('reset role'); } };
const claim = async (u, v = FOUNDER_M) => (await svc('select public.founder_claim($1, $2) r', [u, v])).rows[0].r;
const offer = async () => (await as(db, 'anon', null, 'select public.founder_offer() o')).rows[0].o;
const sub = (status, variant, user = PAYER, attrs = {}) => ({
  meta: { event_name: 'subscription_updated', custom_data: { user_id: user } },
  data: { type: 'subscriptions', id: 's-' + user.slice(-4), attributes: { status, variant_id: variant, customer_id: 9, renews_at: day(30),
    ends_at: null, trial_ends_at: day(14), updated_at: new Date(Date.now() + (++n) * 1000).toISOString(), urls: {}, ...attrs } } });
const apply = p => svc('select public.billing_apply($1, $2) r', [('f' + (++n)).padEnd(16, '0'), JSON.stringify(p)]).then(r => r.rows[0].r);
const users = k => Array.from({ length: k }, (_, i) => '10000000-0000-0000-0000-' + String(i).padStart(12, '0'));

test.before(async () => {
  db = await supabaseDb(BILLING_STUBS, BILLING_SQL, BILLING_SQL);
  await db.exec(`insert into auth.users (id) select u::uuid from unnest(array['${users(5).join("','")}']) u`);
  await db.exec(`update public.app_config set value = '["${FOUNDER_M}", "${FOUNDER_Y}"]' where key = 'founder_variants'`);
});
test.after(() => db && db.close());
test.beforeEach(async () => { await db.exec(`delete from public.founder_claims; delete from public.entitlements; update public.app_config set value = '200' where key = 'founder_seats'`); });

test('the seats are the ones in config/billing.json, and the founder variants are left to the owner', async () => {
  assert.equal(config.founder.seats, 200);
  assert.equal(config.prices.month, 49); assert.equal(config.prices.year, 490);
  const fresh = await supabaseDb(BILLING_STUBS, BILLING_SQL);
  assert.equal((await fresh.query(`select value from public.app_config where key = 'founder_seats'`)).rows[0].value, 200);
  assert.deepEqual((await fresh.query(`select value from public.app_config where key = 'founder_variants'`)).rows[0].value, []);
  await fresh.close();
  // Running the file again keeps the variants the owner set.
  assert.deepEqual((await db.query(`select value from public.app_config where key = 'founder_variants'`)).rows[0].value, [FOUNDER_M, FOUNDER_Y]);
});

test('anyone can see how many seats are left; nothing else', async () => {
  assert.deepEqual(await offer(), { seats: 200, left: 200 });
  await claim(PAYER);
  assert.deepEqual(await offer(), { seats: 200, left: 199 });
  for (const role of ['anon', 'authenticated']) {
    await assert.rejects(as(db, role, APPROVED, 'select * from public.founder_claims'), /permission denied/);
    await assert.rejects(as(db, role, APPROVED, `select public.founder_claim('${APPROVED}', '${FOUNDER_M}')`), /permission denied/);
    await assert.rejects(as(db, role, APPROVED, 'select public.founder_taken()'), /permission denied/);
  }
});

test('a checkout holds a seat; the last seat goes to one reader only', async () => {
  await db.exec(`update public.app_config set value = '2' where key = 'founder_seats'`);
  const [a, b, c] = users(3);
  assert.equal(await claim(a), 'ok');
  assert.equal(await claim(a), 'ok', 'the same reader again keeps the same seat');
  assert.equal(await claim(b, FOUNDER_Y), 'ok');
  assert.equal(await claim(c), 'full');
  assert.deepEqual(await offer(), { seats: 2, left: 0 });
  // A checkout left unpaid frees its seat after two hours.
  await db.exec(`update public.founder_claims set created_at = now() - interval '3 hours' where user_id = '${a}'`);
  assert.equal(await claim(c), 'ok');
});

test('only the founder prices can be claimed', async () => {
  assert.equal(await claim(PAYER, OTHER), 'not_configured');
  assert.equal(await claim(PAYER, null), 'not_configured');
  assert.deepEqual(await offer(), { seats: 200, left: 200 });
});

test('a founder subscription holds the seat (its claim is replaced), while it gives access', async () => {
  await db.exec(`update public.app_config set value = '1' where key = 'founder_seats'`);
  const [other] = users(1);
  assert.equal(await claim(PAYER), 'ok');
  assert.equal((await apply(sub('on_trial', Number(FOUNDER_M)))).applied, true);
  const e = (await db.query(`select founder, variant_id from public.entitlements where user_id = '${PAYER}'`)).rows[0];
  assert.deepEqual(e, { founder: true, variant_id: FOUNDER_M });
  assert.equal((await db.query('select count(*)::int n from public.founder_claims')).rows[0].n, 0);
  assert.deepEqual(await offer(), { seats: 1, left: 0 });
  assert.equal(await claim(other), 'full');
  assert.equal(await claim(PAYER), 'ok', 'the founder themself is not refused');
  // An update without the variant keeps what is known.
  await apply(sub('active', null));
  assert.equal((await db.query(`select founder from public.entitlements where user_id = '${PAYER}'`)).rows[0].founder, true);
  // Cancelled: the seat stays until the paid period ends, then it is free again.
  await apply(sub('cancelled', Number(FOUNDER_M), PAYER, { ends_at: day(10) }));
  assert.deepEqual(await offer(), { seats: 1, left: 0 });
  await apply(sub('expired', Number(FOUNDER_M), PAYER, { ends_at: day(-1) }));
  assert.deepEqual(await offer(), { seats: 1, left: 1 });
  assert.equal(await claim(other), 'ok');
});

test('another price is not a founder subscription and holds no seat', async () => {
  await apply(sub('active', Number(OTHER)));
  assert.equal((await db.query(`select founder from public.entitlements where user_id = '${PAYER}'`)).rows[0].founder, false);
  assert.deepEqual(await offer(), { seats: 200, left: 200 });
});

test('my_plan says whether the reader is a founder', async () => {
  await db.exec(`update public.app_config set value = 'true' where key = 'commercial_mode'`);
  try {
    await apply(sub('active', Number(FOUNDER_Y)));
    assert.equal((await as(db, 'authenticated', PAYER, 'select public.my_plan() p')).rows[0].p.founder, true);
    assert.equal((await as(db, 'authenticated', APPROVED, 'select public.my_plan() p')).rows[0].p.founder, false);
  } finally {
    await db.exec(`update public.app_config set value = 'false' where key = 'commercial_mode'`);
  }
});

test('my_plan gives the interval bought (founder_variants is [monthly, yearly]), for the trial reminder', async () => {
  await db.exec(`update public.app_config set value = 'true' where key = 'commercial_mode'`);
  try {
    await apply(sub('on_trial', Number(FOUNDER_M)));
    assert.equal((await as(db, 'authenticated', PAYER, 'select public.my_plan() p')).rows[0].p.interval, 'month');
    await apply(sub('on_trial', Number(FOUNDER_Y)));
    assert.equal((await as(db, 'authenticated', PAYER, 'select public.my_plan() p')).rows[0].p.interval, 'year');
    await apply(sub('on_trial', Number(OTHER)));
    assert.equal((await as(db, 'authenticated', PAYER, 'select public.my_plan() p')).rows[0].p.interval, null);
  } finally {
    await db.exec(`update public.app_config set value = 'false' where key = 'commercial_mode'`);
  }
});
