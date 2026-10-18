// The static build for Cloudflare Pages (scripts/build.mjs) and the one Pages Function.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = new URL('..', import.meta.url).pathname;
const anonJwt = 'x.' + Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url') + '.y';
const serviceJwt = 'x.' + Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url') + '.y';
function build(env) {
  const out = mkdtempSync(join(tmpdir(), 'dist-'));
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: root, env: { PATH: process.env.PATH, BUILD_OUT: out, ...env } });
  return out;
}

test('a Cloudflare Pages build writes headers, redirects, routes and a static public config', () => {
  const out = build({ CF_PAGES: '1', SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_ANON_KEY: anonJwt });
  for (const f of ['_headers', '_redirects', '_routes.json', 'config.json', 'templates/stock-news-web/StockNewsWeb.dc.html', 'templates/shared/hif-flags.js'])
    assert.ok(existsSync(join(out, f)), f);
  assert.match(readFileSync(join(out, '_headers'), 'utf8'), /connect-src 'self' data: blob: abc\.supabase\.co/);
  const redirects = readFileSync(join(out, '_redirects'), 'utf8');
  assert.match(redirects, /^\/ \/templates\/stock-news-web\/StockNewsWeb\.dc\.html 302$/m);
  // Netlify serves paths in any case, so links use /stocknewsweb.dc; Cloudflare is
  // case-sensitive: a small page there forwards, keeping the #fragment (sign-in links).
  const fwd = readFileSync(join(out, 'templates/stock-news-web/stocknewsweb.dc.html'), 'utf8');
  assert.match(fwd, /location\.replace\('StockNewsWeb\.dc\.html' \+ location\.search \+ location\.hash\)/);
  // Functions run for /api/* only; every page and asset is served statically.
  assert.deepEqual(JSON.parse(readFileSync(join(out, '_routes.json'), 'utf8')), { version: 1, include: ['/api/*'], exclude: [] });
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'config.json'), 'utf8')), { supabaseUrl: 'https://abc.supabase.co', supabaseAnonKey: anonJwt, liveData: true, vapidPublicKey: null });
});

test('a service-role key put in the anon variable is never published', () => {
  const out = build({ CF_PAGES: '1', SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_ANON_KEY: serviceJwt });
  const cfg = JSON.parse(readFileSync(join(out, 'config.json'), 'utf8'));
  assert.equal(cfg.supabaseAnonKey, null);
  assert.equal(cfg.supabaseUrl, null);
});

test('a Netlify build writes no config.json (its secret scan refuses env values in the output)', () => {
  const out = build({ SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_ANON_KEY: anonJwt });
  assert.equal(existsSync(join(out, 'config.json')), false);
  assert.equal(existsSync(join(out, 'templates/stock-news-web/stocknewsweb.dc.html')), false);
  assert.ok(existsSync(join(out, '_headers')));
});

test('the Pages Function answers through the gateway, without Finnhub', async () => {
  const { createHandler, optionsFromEnv } = await import('../functions/api/finnhub.js');
  const o = optionsFromEnv({ FINNHUB_KEY: 'should-not-be-used', TWELVEDATA_KEY: 'td' }, new Request('https://x/api/finnhub'));
  assert.equal(o.keys.finnhub, undefined);
  assert.equal(o.keys.twelvedata, 'td');
  const seen = [];
  const h = createHandler(async (req, opts) => { seen.push(opts); return new Response('{"ok":1}', { status: 200 }); });
  const r = await h({ request: new Request('https://x/api/finnhub?path=/quote&symbol=AAPL', { headers: { 'cf-connecting-ip': '1.2.3.4' } }), env: {}, waitUntil: () => {} });
  assert.equal(r.status, 200);
  assert.equal(seen[0].clientId, '1.2.3.4');
});

test('the Pages Function fails open: an exception is a 503 JSON answer, never a crash', async () => {
  const { createHandler } = await import('../functions/api/finnhub.js');
  const h = createHandler(async () => { throw new Error('boom'); });
  const r = await h({ request: new Request('https://x/api/finnhub?path=/quote&symbol=AAPL'), env: {}, waitUntil: () => {} });
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { error: 'market data unavailable' });
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('the apps look for the static config first', () => {
  const src = readFileSync(join(root, 'templates/shared/hif-auth.js'), 'utf8');
  assert.match(src, /for \(const url of \['\/config\.json', '\/api\/config'\]\)/);
});
