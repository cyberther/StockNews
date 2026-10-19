import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis;
const rest = [], fetched = [];
let restReply = () => ({ ok: true, status: 200, body: { commercial: false, plan: 'pro', source: 'early_access', limits: { tickers: 100, positions: 100 } } });
let fetchReply = () => Response.json({ url: 'https://store.lemonsqueezy.com/checkout/custom/abc' });
window.HIFAuth = { rest: async (path, init) => { rest.push([path, init]); return restReply(path); }, token: async () => 'jwt', publicConfig: () => ({ supabaseUrl: 'https://p.supabase.co/' }), enabled: () => true };
globalThis.fetch = async (url, init) => { fetched.push([String(url), init]); return fetchReply(); };
await import('../templates/shared/hif-billing.js');
const B = window.HIFBilling;

test('load: one RPC (my_plan), its answer as is', async () => {
  rest.length = 0;
  const p = await B.load();
  assert.deepEqual(rest.map(r => r[0]), ['rpc/my_plan']);
  assert.equal(rest[0][1].method, 'POST');
  assert.equal(p.plan, 'pro');
  restReply = () => ({ ok: false, status: 404, body: null });
  assert.equal(await B.load(), null, 'no such function yet: null, the app keeps working');
});

test('checkout: the billing function with the reader\'s token, the interval only; the link or the reason', async () => {
  fetched.length = 0;
  assert.deepEqual(await B.checkout('year'), { url: 'https://store.lemonsqueezy.com/checkout/custom/abc' });
  assert.equal(fetched[0][0], 'https://p.supabase.co/functions/v1/billing?action=checkout&interval=year');
  assert.equal(fetched[0][1].method, 'POST');
  assert.equal(fetched[0][1].headers.authorization, 'Bearer jwt');
  assert.equal(fetched[0][1].body, undefined, 'nothing about the account is sent: the server reads it from the token');
  await B.checkout('forever');
  assert.match(fetched[1][0], /interval=month$/);
  fetchReply = () => Response.json({ error: 'sales are not open yet' }, { status: 403 });
  assert.deepEqual(await B.checkout('month'), { error: 'sales are not open yet' });
  fetchReply = () => Response.json({ url: 'javascript:alert(1)' });
  assert.deepEqual(await B.checkout('month'), { error: 'checkout failed' });
});

test('the limits the app shows come from the same config the server uses', () => {
  assert.equal(B.limits('free').tickers, 5);
  assert.equal(B.limits('pro').tickers, 100);
});
