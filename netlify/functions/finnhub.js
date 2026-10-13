// Netlify Function: the market data gateway at /api/finnhub (see _shared/market/gateway.js).
// Keys live in the site env and never reach the browser.
//
// Setup: Netlify → Site configuration → Environment variables → FINNHUB_KEY.
// Optional: TWELVEDATA_KEY, FMP_KEY, ALPHAVANTAGE_KEY add backup providers;
// MARKET_ORDER_<CAPABILITY> reorders them; USAGE_SECRET (supabase/usage.sql) shares call
// counts across instances.
// Call it as /api/finnhub?path=/quote&symbol=NVDA, or /api/finnhub?path=/quotes&symbols=AAPL,NVDA.
import { handleMarketRequest, keysFromEnv, orderFromEnv } from './_shared/market/gateway.js';
import { usageStoreFromEnv } from './_shared/market/usage-store.js';

const usage = usageStoreFromEnv(process.env);
const keys = keysFromEnv(process.env);
const order = orderFromEnv(process.env);

export default async (request, context) => handleMarketRequest(request, {
  keys,
  order,
  allowedOrigins: process.env.ALLOWED_ORIGINS,
  // One page load asks for news, analysts and earnings per ticker; this only stops abuse.
  rateLimit: process.env.API_RATE_LIMIT || 600,
  clientId: context && context.ip,
  usage,
  // Cache misses spend provider quota, so they need a signed-in user (see gateway.js).
  auth: { supabaseUrl: process.env.SUPABASE_URL, anonKey: process.env.SUPABASE_ANON_KEY, publicSymbols: process.env.PUBLIC_SYMBOLS },
  waitUntil: context && typeof context.waitUntil === 'function' ? p => context.waitUntil(p) : null
});

export const config = { path: '/api/finnhub' };
