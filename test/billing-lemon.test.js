import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import * as nodeModule from 'node:module';
import { verifySignature, bodyHash, checkoutRequest, checkoutUrl } from '../supabase/functions/billing/lemon.js';

const SECRET = 'whsec_' + 'k'.repeat(30);
const body = JSON.stringify({ meta: { event_name: 'subscription_created', custom_data: { user_id: 'u' } }, data: { id: '1' } });
const sign = (b, s = SECRET) => createHmac('sha256', s).update(b).digest('hex');

test('the webhook signature: right one passes; wrong, missing, other secret, changed body do not', async () => {
  assert.equal(await verifySignature(body, sign(body), SECRET), true);
  assert.equal(await verifySignature(body, sign(body).toUpperCase(), SECRET), false);
  assert.equal(await verifySignature(body, '', SECRET), false);
  assert.equal(await verifySignature(body, sign(body, 'other'), SECRET), false);
  assert.equal(await verifySignature(body + ' ', sign(body), SECRET), false);
  assert.equal(await verifySignature(body, sign(body), ''), false, 'no secret configured: nothing passes');
  assert.equal(await verifySignature(body, 'zz', SECRET), false);
});

test('the body hash is the sha256 of the raw body', async () => {
  assert.equal(await bodyHash(body), createHash('sha256').update(body).digest('hex'));
});

test('the checkout request: the account from the token, test mode, the chosen variant, nothing else about the reader', () => {
  const r = checkoutRequest({ apiKey: 'KEY', storeId: 12, variantId: 345, userId: 'uuid-1', email: 'a@x.ro', testMode: true, redirectUrl: 'https://www.marketpulse.ro/#account' });
  assert.equal(r.url, 'https://api.lemonsqueezy.com/v1/checkouts');
  assert.equal(r.init.method, 'POST');
  assert.equal(r.init.headers.Authorization, 'Bearer KEY');
  assert.equal(r.init.headers['Content-Type'], 'application/vnd.api+json');
  const b = JSON.parse(r.init.body);
  assert.deepEqual(b.data.attributes.checkout_data, { email: 'a@x.ro', custom: { user_id: 'uuid-1' } });
  assert.equal(b.data.attributes.test_mode, true);
  assert.equal(b.data.attributes.product_options.redirect_url, 'https://www.marketpulse.ro/#account');
  assert.deepEqual(b.data.relationships.store.data, { type: 'stores', id: '12' });
  assert.deepEqual(b.data.relationships.variant.data, { type: 'variants', id: '345' });
  assert.throws(() => checkoutRequest({ apiKey: 'KEY', storeId: 1, variantId: 2, userId: '', email: 'a@x.ro', testMode: true }), /user/);
});

test('the checkout link from the answer: https only', () => {
  assert.equal(checkoutUrl({ data: { attributes: { url: 'https://store.lemonsqueezy.com/checkout/custom/abc' } } }), 'https://store.lemonsqueezy.com/checkout/custom/abc');
  assert.equal(checkoutUrl({ data: { attributes: { url: 'javascript:alert(1)' } } }), null);
  assert.equal(checkoutUrl({}), null);
});

const src = readFileSync(new URL('../supabase/functions/billing/index.ts', import.meta.url), 'utf8');
const { stripTypeScriptTypes } = nodeModule;
test('billing/index.ts is valid TypeScript syntax', { skip: !stripTypeScriptTypes && !process.env.CI && 'needs Node 22.13+' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'billing-')), file = join(dir, 'index.mjs');
  writeFileSync(file, stripTypeScriptTypes(src));
  execFileSync(process.execPath, ['--check', file]);
});

test('the function: signature before anything, no sales before the legal check, no key in any answer or log', () => {
  const hook = src.slice(src.indexOf("action === 'webhook'"), src.indexOf("action === 'checkout'"));
  assert.ok(hook.indexOf('verifySignature(') > 0 && hook.indexOf('verifySignature(') < hook.indexOf("rpc('billing_apply'"));
  assert.match(hook, /'bad signature' \}, 401\)/);
  const co = src.slice(src.indexOf("action === 'checkout'"));
  assert.ok(co.indexOf("env('LEGAL_REVIEWED') !== 'true'") > 0 && co.indexOf("env('LEGAL_REVIEWED') !== 'true'") < co.indexOf('fetch('));
  assert.match(co, /auth\.getUser\(/);
  assert.doesNotMatch(src, /console\.log\([^)]*(API_KEY|apiKey|SECRET|secret)/);
  assert.doesNotMatch(src, /Response\.json\([^)]*(apiKey|API_KEY)/);
});
