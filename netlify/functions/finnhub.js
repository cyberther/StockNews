// Netlify Function: server-side proxy for Finnhub.
// The API key lives in the site env (FINNHUB_KEY) and never reaches the browser.
//
// Setup: Netlify → Site configuration → Environment variables → FINNHUB_KEY = <your 20-char Finnhub key>
// Call it as: /api/finnhub?path=/quote&symbol=NVDA
//
// Only the endpoints this prototype needs are allowed through.
const ALLOWED = new Set(['/quote', '/company-news', '/search', '/stock/recommendation', '/stock/earnings', '/chart']);
const BASE = 'https://finnhub.io/api/v1';

const CHART_RANGES = {
  '1d': '5m', '5d': '15m', '1mo': '60m', '6mo': '1d', ytd: '1d', '1y': '1d', '5y': '1wk'
};

export default async (request) => {
  const url = new URL(request.url);
  const path = url.searchParams.get('path') || '';
  if (!ALLOWED.has(path)) {
    return Response.json({ error: 'path not allowed', path }, { status: 400 });
  }
  const key = process.env.FINNHUB_KEY;
  if (path === '/chart') {
    const symbol = (url.searchParams.get('symbol') || '').toUpperCase().replace(/[^A-Z0-9.-]/g, '');
    const range = url.searchParams.get('range') || '6mo';
    if (!symbol || !CHART_RANGES[range]) return Response.json({ error: 'invalid chart request' }, { status: 400 });
    const chartUrl = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
    chartUrl.searchParams.set('range', range);
    chartUrl.searchParams.set('interval', CHART_RANGES[range]);
    chartUrl.searchParams.set('includePrePost', 'false');
    try {
      const res = await fetch(chartUrl, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' } });
      return new Response(await res.text(), {
        status: res.status,
        headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' }
      });
    } catch (e) {
      return Response.json({ error: 'chart upstream failed', detail: String(e) }, { status: 502 });
    }
  }
  if (!key) {
    return Response.json({ error: 'FINNHUB_KEY is not set on this site' }, { status: 500 });
  }
  const out = new URL(BASE + path);
  for (const [k, v] of url.searchParams) if (k !== 'path') out.searchParams.set(k, v);
  out.searchParams.set('token', key);

  try {
    const res = await fetch(out, { headers: { accept: 'application/json' } });
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: {
        'content-type': 'application/json',
        // quotes go stale fast; news and analyst trends do not
        'cache-control': path === '/quote' ? 'public, max-age=30' : 'public, max-age=300'
      }
    });
  } catch (e) {
    return Response.json({ error: 'upstream failed', detail: String(e) }, { status: 502 });
  }
};

export const config = { path: '/api/finnhub' };
