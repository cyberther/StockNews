// Supabase Edge Function "billing" (Phase D): the payment provider's webhooks, and checkout
// links for the signed-in reader. Plans are decided in the database (supabase/billing.sql);
// this only checks and forwards.
//
//   POST ?action=webhook   Lemon Squeezy → signature checked → billing_apply. 401 if unsigned.
//   POST ?action=checkout&interval=month|year   with the reader's access token → { url }.
//        Refused until LEGAL_REVIEWED=true, and while the provider is not configured.
//
// Deploy with JWT verification off (webhooks carry a signature, not a user token):
//   supabase functions deploy billing --no-verify-jwt
// Secrets (`supabase secrets set`, never in the repo or the browser):
//   LEMONSQUEEZY_API_KEY, LEMONSQUEEZY_WEBHOOK_SECRET, LEMONSQUEEZY_STORE_ID,
//   LEMONSQUEEZY_VARIANT_MONTH, LEMONSQUEEZY_VARIANT_YEAR, LEMONSQUEEZY_TEST_MODE ('true' while testing),
//   LEGAL_REVIEWED ('true' only after the legal check), APP_URL (where the reader returns).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { verifySignature, bodyHash, checkoutRequest, checkoutUrl } from './lemon.js';

const env = (k: string) => (Deno.env.get(k) || '').trim();
const MAX_BODY = 65536;

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') || '';
  const ok = /^https:\/\/(?:(?:[a-z0-9-]+\.)?aa-market-pulse\.pages\.dev|(?:www\.|staging\.)?marketpulse\.ro)$/.test(origin);
  return ok ? { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, apikey', vary: 'origin' } : { vary: 'origin' };
}
const answer = (req: Request, body: unknown, status = 200) => Response.json(body, { status, headers: { ...cors(req), 'cache-control': 'no-store' } });

Deno.serve(async (req: Request) => {
  const action = new URL(req.url).searchParams.get('action');
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== 'POST') return answer(req, { error: 'method not allowed' }, 405);
  const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });

  if (action === 'webhook') {
    const raw = await req.text();
    if (raw.length > MAX_BODY) return answer(req, { error: 'too large' }, 413);
    if (!(await verifySignature(raw, req.headers.get('x-signature') || '', env('LEMONSQUEEZY_WEBHOOK_SECRET'))))
      return answer(req, { error: 'bad signature' }, 401);
    let payload: unknown;
    try { payload = JSON.parse(raw); } catch { return answer(req, { error: 'bad json' }, 400); }
    const { data, error } = await db.rpc('billing_apply', { p_hash: await bodyHash(raw), p_payload: payload });
    // A database error is a 500, so the provider retries the delivery later.
    if (error) { console.log(JSON.stringify({ evt: 'billing.apply_failed', message: error.message })); return answer(req, { error: 'not applied' }, 500); }
    return answer(req, data);
  }

  if (action === 'checkout') {
    if (env('LEGAL_REVIEWED') !== 'true') return answer(req, { error: 'sales are not open yet' }, 403);
    const interval = new URL(req.url).searchParams.get('interval') === 'year' ? 'year' : 'month';
    const apiKey = env('LEMONSQUEEZY_API_KEY'), storeId = env('LEMONSQUEEZY_STORE_ID');
    const variantId = env(interval === 'year' ? 'LEMONSQUEEZY_VARIANT_YEAR' : 'LEMONSQUEEZY_VARIANT_MONTH');
    if (!apiKey || !storeId || !variantId) return answer(req, { error: 'billing is not configured' }, 503);
    // The account comes from the verified token, never from the request's body or query.
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: who, error: authErr } = await db.auth.getUser(token);
    if (authErr || !who || !who.user) return answer(req, { error: 'sign in required' }, 401);
    const { data: st } = await db.from('account_status').select('approved,suspended').eq('user_id', who.user.id).maybeSingle();
    if (!st || !st.approved || st.suspended) return answer(req, { error: 'account not approved' }, 403);
    const appUrl = (env('APP_URL') || 'https://www.marketpulse.ro/').replace(/#.*$/, '');
    const { url, init } = checkoutRequest({ apiKey, storeId, variantId, userId: who.user.id, email: who.user.email,
      testMode: env('LEMONSQUEEZY_TEST_MODE') !== 'false', redirectUrl: appUrl + '#account' });
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
      const link = res.ok ? checkoutUrl(await res.json()) : null;
      if (!link) { console.log(JSON.stringify({ evt: 'billing.checkout_failed', status: res.status })); return answer(req, { error: 'checkout failed' }, 502); }
      return answer(req, { url: link });
    } catch {
      return answer(req, { error: 'checkout failed' }, 502);
    }
  }

  return answer(req, { error: 'unknown action' }, 404);
});
