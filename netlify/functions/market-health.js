// Netlify Function: gateway health at /api/market/health, for the site owner only.
//
//   curl -H "Authorization: Bearer $HEALTH_TOKEN" https://<site>/api/market/health
//
// Shows each provider's capabilities, limits and whether its key is set (never the key),
// plus usage for the last 7 days from the shared store (supabase/usage.sql): calls, 429s,
// errors and when the last 429 / error happened. Without HEALTH_TOKEN the endpoint does
// not exist (404).
import { timingSafeEqual } from 'node:crypto';
import { providerInfo, gatewayStatus } from './_shared/market/gateway.js';
import { usageStoreFromEnv } from './_shared/market/usage-store.js';

const usage = usageStoreFromEnv(process.env);
const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };

function authorized(request, token) {
  const got = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(got), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async request => {
  const token = process.env.HEALTH_TOKEN || '';
  if (token.length < 24) return new Response('Not found', { status: 404, headers });
  if (!authorized(request, token)) return Response.json({ error: 'unauthorized' }, { status: 401, headers: { ...headers, 'www-authenticate': 'Bearer' } });

  const keys = { finnhub: process.env.FINNHUB_KEY };
  let shared = { configured: !!usage };
  if (usage) {
    try {
      const rows = await usage.read(7);
      const today = new Date().toISOString().slice(0, 10);
      shared.today = (rows || []).filter(r => r.day === today);
      shared.days = rows || [];
    } catch (e) { shared.error = 'usage store unreachable'; }
  }
  return Response.json({
    generatedAt: new Date().toISOString(),
    providers: providerInfo(keys),
    usage: shared,
    // One function instance's view only; instances don't share memory.
    instance: gatewayStatus()
  }, { headers });
};

export const config = { path: '/api/market/health' };
