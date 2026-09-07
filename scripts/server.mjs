import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleMarketRequest } from '../netlify/functions/_shared/market-proxy.js';

const root = resolve(fileURLToPath(new URL('../dist', import.meta.url)));

function loadEnvFile() {
  const path = resolve(fileURLToPath(new URL('../.env', import.meta.url)));
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
loadEnvFile();

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8080);
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg'
};
const pageHeaders = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  // The generated DC runtime compiles component expressions with new Function.
  'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://finnhub.io; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
};

function clientId(req) {
  const forwarded = process.env.TRUST_PROXY === 'true' ? req.headers['x-forwarded-for'] : '';
  return String(forwarded || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
}

async function sendResponse(res, response) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

async function serveStatic(pathname, res) {
  const route = pathname === '/' ? '/templates/stock-news-web/StockNewsWeb.dc.html'
    : pathname === '/mobile' ? '/templates/stock-news-dark/StockNewsDark.dc.html' : pathname;
  let decoded;
  try { decoded = decodeURIComponent(route); } catch { res.writeHead(400, pageHeaders).end('Bad request'); return; }
  const file = resolve(root, '.' + decoded);
  if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403, pageHeaders).end('Forbidden'); return; }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(file);
    res.writeHead(200, { ...pageHeaders, 'content-type': mime[extname(file)] || 'application/octet-stream', 'cache-control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600' });
    res.end(body);
  } catch {
    res.writeHead(404, pageHeaders).end('Not found');
  }
}

const server = createServer(async (req, res) => {
  try {
    const base = `http://${req.headers.host || `${host}:${port}`}`;
    const url = new URL(req.url || '/', base);
    if (url.pathname === '/api/finnhub') {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      const request = new Request(url, { method: req.method, headers });
      const response = await handleMarketRequest(request, {
        apiKey: process.env.FINNHUB_KEY,
        allowedOrigins: process.env.ALLOWED_ORIGINS,
        rateLimit: process.env.API_RATE_LIMIT,
        clientId: clientId(req)
      });
      await sendResponse(res, response);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { ...pageHeaders, allow: 'GET, HEAD' }).end('Method not allowed'); return; }
    await serveStatic(url.pathname, res);
  } catch {
    res.writeHead(500, pageHeaders).end('Internal server error');
  }
});

server.listen(port, host, () => console.log(`StockNews listening on http://${host}:${port}`));
