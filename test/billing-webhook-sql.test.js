import test from 'node:test';
import assert from 'node:assert/strict';
import { supabaseDb, as, APPROVED } from './helpers/supabase-pg.js';
import { PAYER, BILLING_STUBS, BILLING_SQL } from './helpers/billing-stubs.js';

let db;
const day = n => new Date(Date.now() + n * 864e5).toISOString();
// A Lemon Squeezy subscription webhook, as it arrives (the fields billing_apply reads).
const sub = (event, attrs, { user = PAYER, id = '1001', type = 'subscriptions' } = {}) => ({
  meta: { event_name: event, custom_data: user ? { user_id: user } : {} },
  data: { type, id, attributes: { store_id: 1, customer_id: 77, status: 'active', renews_at: day(30), ends_at: null, trial_ends_at: null,
    updated_at: new Date().toISOString(), test_mode: true, urls: { customer_portal: 'https://store.lemonsqueezy.com/billing?x=1', update_payment_method: 'https://u' }, ...attrs } } });
let n = 0;
const apply = async (payload, hash = ('h' + (++n)).padEnd(16, '0')) => {
  await db.exec(`set role service_role`);
  try { return (await db.query('select public.billing_apply($1, $2) r', [hash, JSON.stringify(payload)])).rows[0].r; } finally { await db.exec('reset role'); }
};
const ent = async () => (await db.query(`select status, current_period_end, portal_url, subscription_id, customer_id from public.entitlements where user_id = $1 and source = 'payment'`, [PAYER])).rows[0];
const plan = async () => (await db.query('select public.current_plan($1) p', [PAYER])).rows[0].p;
test.before(async () => { db = await supabaseDb(BILLING_STUBS, BILLING_SQL); });
test.after(() => db && db.close());
test.beforeEach(async () => { await db.exec('delete from public.entitlements; delete from public.billing_events;'); });

test('a trial, then paid, then cancelled (access to the end), then expired', async () => {
  let t = Date.now();
  const at = () => new Date(t += 1000).toISOString();
  assert.equal((await apply(sub('subscription_created', { status: 'on_trial', trial_ends_at: day(14), renews_at: day(14), updated_at: at() }))).applied, true);
  assert.equal((await ent()).status, 'trialing'); assert.equal(await plan(), 'pro');
  assert.equal((await ent()).portal_url, 'https://store.lemonsqueezy.com/billing?x=1');
  assert.equal((await ent()).subscription_id, '1001');
  await apply(sub('subscription_updated', { status: 'active', renews_at: day(44), updated_at: at() }));
  assert.equal((await ent()).status, 'active');
  assert.ok(Date.parse((await ent()).current_period_end) > Date.now() + 40 * 864e5);
  await apply(sub('subscription_cancelled', { status: 'cancelled', ends_at: day(44), updated_at: at() }));
  assert.equal((await ent()).status, 'cancelled'); assert.equal(await plan(), 'pro', 'paid until ends_at');
  await apply(sub('subscription_expired', { status: 'expired', ends_at: day(-1), updated_at: at() }));
  assert.equal((await ent()).status, 'expired'); assert.equal(await plan(), 'free');
});

test('a failed payment keeps access until the period ends', async () => {
  await apply(sub('subscription_updated', { status: 'past_due', renews_at: day(3) }));
  assert.equal((await ent()).status, 'past_due'); assert.equal(await plan(), 'pro');
  await apply(sub('subscription_updated', { status: 'unpaid', renews_at: day(-1), updated_at: new Date(Date.now() + 5000).toISOString() }));
  assert.equal(await plan(), 'free');
});

test('the same webhook twice is applied once; an older one after a newer one changes nothing', async () => {
  const p = sub('subscription_updated', { status: 'active', renews_at: day(30) });
  assert.equal((await apply(p, 'same-hash-0001')).applied, true);
  const again = await apply(p, 'same-hash-0001');
  assert.deepEqual(again, { applied: false, note: 'duplicate' });
  const older = await apply(sub('subscription_updated', { status: 'expired', ends_at: day(-1), updated_at: new Date(Date.now() - 864e5).toISOString() }));
  assert.deepEqual(older, { applied: false, note: 'stale' });
  assert.equal((await ent()).status, 'active');
  assert.equal((await db.query('select count(*)::int c from public.billing_events')).rows[0].c, 2);
});

test('an unknown or missing user, a payment (invoice) event, an unmapped status: recorded, not applied', async () => {
  assert.deepEqual(await apply(sub('subscription_created', {}, { user: '00000000-0000-0000-0000-0000000000ff' })), { applied: false, note: 'unknown user' });
  assert.deepEqual(await apply(sub('subscription_created', {}, { user: 'not-a-uuid' })), { applied: false, note: 'unknown user' });
  assert.deepEqual(await apply(sub('subscription_created', {}, { user: null })), { applied: false, note: 'unknown user' });
  assert.deepEqual(await apply(sub('subscription_payment_success', {}, { type: 'subscription-invoices' })), { applied: false, note: 'not a subscription' });
  assert.deepEqual(await apply(sub('subscription_updated', { status: 'galactic' })), { applied: false, note: 'unknown status' });
  assert.equal(await ent(), undefined);
  assert.equal((await db.query('select count(*)::int c from public.billing_events where not applied')).rows[0].c, 5);
});

test('a portal link that is not https is not kept', async () => {
  await apply(sub('subscription_created', { urls: { customer_portal: 'javascript:alert(1)' } }));
  assert.equal((await ent()).portal_url, null);
});

test('only the service role applies webhooks; the browser cannot read the events', async () => {
  await assert.rejects(as(db, 'authenticated', APPROVED, `select public.billing_apply('x', '{}')`), /permission denied/);
  await assert.rejects(as(db, 'authenticated', APPROVED, `select * from public.billing_events`), /permission denied/);
});
