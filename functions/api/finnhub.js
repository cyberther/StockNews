// Cloudflare Pages Function: the market data gateway at /api/finnhub (the same code as the
// Netlify function, netlify/functions/_shared/market/gateway.js), for what the reader asks
// for on screen: charts, candles, search, company profiles, earnings, filings. Prices,
// company news and analyst counts come from Supabase (ingest/), not from here.
//
// Finnhub is not used here even if a key is set. Fails open: any exception is a 503 JSON
// answer, which the apps treat as "no data", and nothing else on the page depends on it.
// _routes.json limits functions to /api/*, so pages and assets never invoke one.
import { handleMarketRequest, keysFromEnv, orderFromEnv, licensesFromEnv } from '../../netlify/functions/_shared/market/gateway.js';

export function optionsFromEnv(env, request) {
  const keys = keysFromEnv({ ...env, FINNHUB_KEY: '' });
  delete keys.finnhub;
  return {
    keys,
    order: orderFromEnv(env),
    licenses: licensesFromEnv(env),
    allowedOrigins: env.ALLOWED_ORIGINS,
    rateLimit: env.API_RATE_LIMIT || 600,
    clientId: request.headers.get('cf-connecting-ip') || '',
    // Cache misses spend provider quota, so they need a signed-in, approved user.
    auth: { supabaseUrl: env.SUPABASE_URL, anonKey: env.SUPABASE_ANON_KEY, publicSymbols: env.PUBLIC_SYMBOLS }
  };
}

export function createHandler(handle) {
  return async ({ request, env, waitUntil }) => {
    try {
      return await handle(request, { ...optionsFromEnv(env || {}, request), waitUntil: typeof waitUntil === 'function' ? p => waitUntil(p) : null });
    } catch (e) {
      console.log(JSON.stringify({ evt: 'market.function_error', message: String(e && e.message || e).slice(0, 200) }));
      return Response.json({ error: 'market data unavailable' }, { status: 503, headers: { 'cache-control': 'no-store' } });
    }
  };
}

export const onRequestGet = createHandler(handleMarketRequest);
