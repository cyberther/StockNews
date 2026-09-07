const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const MAX_UPSTREAM_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 8000;
const WINDOW_MS = 60_000;
const CHART_RANGES = {
  '1d': '5m', '5d': '15m', '1mo': '60m', '6mo': '1d', ytd: '1d', '1y': '1d', '5y': '1wk'
};
const ENDPOINTS = new Set(['/quote', '/company-news', '/search', '/stock/recommendation', '/stock/earnings', '/chart']);
const cache = new Map();
const clients = new Map();

const securityHeaders = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()'
};

function json(data, status = 200, extraHeaders = {}) {
  return Response.json(data, { status, headers: { ...securityHeaders, ...extraHeaders } });
}

function validSymbol(value) {
  return /^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(value);
}

function isoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + 'T00:00:00Z'));
}

function allowedOrigin(request, configured) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  const self = new URL(request.url).origin;
  const extras = String(configured || '').split(',').map(x => x.trim()).filter(Boolean);
  return origin === self || extras.includes(origin);
}

function withinRateLimit(clientId, rawLimit) {
  const limit = Math.max(1, Math.min(Number(rawLimit) || 60, 600));
  const now = Date.now();
  const key = clientId || 'unknown';
  const entry = clients.get(key);
  if (!entry || now - entry.started >= WINDOW_MS) {
    if (clients.size > 10_000) {
      for (const [client, value] of clients) if (now - value.started >= WINDOW_MS) clients.delete(client);
    }
    clients.set(key, { started: now, count: 1 });
    return true;
  }
  entry.count += 1;
  return entry.count <= limit;
}

function validatedTarget(url, apiKey) {
  const path = url.searchParams.get('path') || '';
  if (!ENDPOINTS.has(path)) return { error: 'path not allowed' };

  if (path === '/chart') {
    const symbol = (url.searchParams.get('symbol') || '').toUpperCase();
    const range = url.searchParams.get('range') || '6mo';
    if (!validSymbol(symbol) || !CHART_RANGES[range]) return { error: 'invalid chart request' };
    const target = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
    target.searchParams.set('range', range);
    target.searchParams.set('interval', CHART_RANGES[range]);
    target.searchParams.set('includePrePost', 'false');
    return { target, ttl: 300 };
  }

  if (!apiKey) return { error: 'market data is not configured', status: 503 };
  const target = new URL(FINNHUB_BASE + path);

  if (path === '/search') {
    const q = (url.searchParams.get('q') || '').trim();
    if (!q || q.length > 64) return { error: 'invalid search query' };
    target.searchParams.set('q', q);
  } else {
    const symbol = (url.searchParams.get('symbol') || '').toUpperCase();
    if (!validSymbol(symbol)) return { error: 'invalid symbol' };
    target.searchParams.set('symbol', symbol);
  }

  if (path === '/company-news') {
    const from = url.searchParams.get('from') || '';
    const to = url.searchParams.get('to') || '';
    if (!isoDate(from) || !isoDate(to) || from > to) return { error: 'invalid date range' };
    const days = (Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000;
    if (days > 31) return { error: 'date range too large' };
    target.searchParams.set('from', from);
    target.searchParams.set('to', to);
  }
  if (path === '/stock/earnings') target.searchParams.set('limit', '24');
  target.searchParams.set('token', apiKey);
  return { target, ttl: path === '/quote' ? 30 : 300 };
}

async function fetchJson(target) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(target, {
      headers: { accept: 'application/json', 'user-agent': 'StockNews/0.2' },
      signal: controller.signal
    });
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > MAX_UPSTREAM_BYTES) throw new Error('response too large');
    const body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > MAX_UPSTREAM_BYTES) throw new Error('response too large');
    let parsed;
    try { parsed = JSON.parse(body); } catch { throw new Error('invalid upstream response'); }
    return { status: response.status, parsed };
  } finally {
    clearTimeout(timer);
  }
}

export async function handleMarketRequest(request, options = {}) {
  if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405, { allow: 'GET' });
  if (!allowedOrigin(request, options.allowedOrigins)) return json({ error: 'origin not allowed' }, 403);
  if (!withinRateLimit(options.clientId, options.rateLimit)) {
    return json({ error: 'rate limit exceeded' }, 429, { 'retry-after': '60' });
  }

  const checked = validatedTarget(new URL(request.url), options.apiKey);
  if (checked.error) return json({ error: checked.error }, checked.status || 400);
  const cacheKey = checked.target.toString().replace(options.apiKey || '', '[key]');
  const hit = cache.get(cacheKey);
  if (hit && hit.expires > Date.now()) {
    return json(hit.data, hit.status, { 'cache-control': `public, max-age=${checked.ttl}`, 'x-stocknews-cache': 'hit' });
  }

  try {
    const result = await fetchJson(checked.target);
    if (result.status >= 200 && result.status < 300) {
      cache.set(cacheKey, { data: result.parsed, status: result.status, expires: Date.now() + checked.ttl * 1000 });
    }
    return json(result.parsed, result.status, {
      'cache-control': `public, max-age=${checked.ttl}`,
      'netlify-cdn-cache-control': `public, durable, max-age=${checked.ttl}`,
      'x-stocknews-cache': 'miss'
    });
  } catch (error) {
    const timeout = error && error.name === 'AbortError';
    return json({ error: timeout ? 'market data timed out' : 'market data unavailable' }, 502);
  }
}

export function resetProxyStateForTests() {
  cache.clear();
  clients.clear();
}
