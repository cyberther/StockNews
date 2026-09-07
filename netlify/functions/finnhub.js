import { handleMarketRequest } from './_shared/market-proxy.js';

export default async (request, context) => handleMarketRequest(request, {
  apiKey: globalThis.Netlify?.env?.get('FINNHUB_KEY') || process.env.FINNHUB_KEY,
  allowedOrigins: globalThis.Netlify?.env?.get('ALLOWED_ORIGINS') || process.env.ALLOWED_ORIGINS,
  rateLimit: globalThis.Netlify?.env?.get('API_RATE_LIMIT') || process.env.API_RATE_LIMIT,
  clientId: context?.ip || request.headers.get('x-forwarded-for') || 'unknown'
});

export const config = { path: '/api/finnhub' };
