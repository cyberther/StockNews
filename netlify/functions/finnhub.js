// Netlify Function: the market data gateway at /api/finnhub (see _shared/market/gateway.js).
// Keys live in the site env and never reach the browser.
//
// Setup: Netlify → Site configuration → Environment variables → FINNHUB_KEY.
// Call it as /api/finnhub?path=/quote&symbol=NVDA, or /api/finnhub?path=/quotes&symbols=AAPL,NVDA.
import { handleMarketRequest } from './_shared/market/gateway.js';

export default async (request, context) => handleMarketRequest(request, {
  apiKey: process.env.FINNHUB_KEY,
  allowedOrigins: process.env.ALLOWED_ORIGINS,
  // One page load asks for news, analysts and earnings per ticker; this only stops abuse.
  rateLimit: process.env.API_RATE_LIMIT || 600,
  clientId: context && context.ip
});

export const config = { path: '/api/finnhub' };
