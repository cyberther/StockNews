// Measures what an open web app asks the network for over simulated hours, in Chromium with
// a fake clock and a stubbed Supabase and gateway (nothing leaves the machine):
//
//   node scripts/measure-client.mjs [--root=/path/to/a/checkout] [--hours=2]
//
// Scenarios: a page left open and untouched while markets trade (the old 5-minute poll's
// worst case, e.g. a browser pane that always counts as visible), the same page in use
// (a click every 4 minutes), and an untouched page on a Saturday. Counts requests to
// /api/finnhub (a serverless invocation each, and usually a provider call) and to Supabase.
// Run it against an older checkout (git worktree) for the before/after comparison.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (n, d) => { const a = process.argv.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const ROOT = resolve(arg('root', fileURLToPath(new URL('..', import.meta.url))));
const HOURS = Number(arg('hours', '2'));
const PAGE = 'templates/stock-news-web/StockNewsWeb.dc.html', KEY = 'hif.web.v2';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
// The baseline's watchlist and a portfolio.
const FOLLOWS = ['ABAT', 'ASTS', 'BMW.DE', 'BVB.RO', 'EOSE', 'FLY', 'OKLO', 'SNG.RO', 'SNP.RO', 'VRT'];
const POSITIONS = { SNP: null, 'SNP.RO': { shares: 1000, cost: '0.6' }, 'TLV.RO': { shares: 100, cost: '25' }, OKLO: { shares: 5, cost: '60' } };
delete POSITIONS.SNP;

const { chromium } = await import('playwright');

function serve() {
  const server = createServer(async (req, res) => {
    const rel = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    if (rel.startsWith('..')) { res.writeHead(403).end(); return; }
    let body;
    try { body = await readFile(join(ROOT, rel)); } catch { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(rel)] || 'application/octet-stream' }).end(body);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

async function scenario(browser, base, { start, active }) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const counts = { gateway: 0, gatewayPaths: {}, supabaseMarket: 0, supabaseOther: 0 };
  const errors = [];
  const cfg = { supabaseUrl: 'https://stub.supabase.co', supabaseAnonKey: 'anon' };
  await ctx.route('**/api/config', r => r.fulfill({ json: cfg }));
  await ctx.route('**/config.json', r => r.fulfill({ json: cfg }));
  await ctx.route('**/api/content', r => r.fulfill({ status: 404, body: '' }));
  await ctx.route('**/api/finnhub**', r => {
    const p = new URL(r.request().url()).searchParams.get('path') || '?';
    counts.gateway++; counts.gatewayPaths[p] = (counts.gatewayPaths[p] || 0) + 1;
    if (p === '/quotes') return r.fulfill({ json: { quotes: {} } });
    if (p === '/quote') return r.fulfill({ json: { c: 10, dp: 1, d: 0.1 } });
    return r.fulfill({ json: [] });
  });
  await ctx.route('https://stub.supabase.co/**', r => {
    const url = r.request().url();
    if (/\/rest\/v1\/(market_quotes|market_recommendations|stories)\b/.test(url)) counts.supabaseMarket++; else counts.supabaseOther++;
    if (/\/auth\/v1\/settings/.test(url)) return r.fulfill({ json: {} });
    if (/\/auth\/v1\/user/.test(url)) return r.fulfill({ json: { id: 'u1', email: 'u@example.com' } });
    if (/rpc\/is_approved/.test(url)) return r.fulfill({ json: true });
    if (/account_status/.test(url)) return r.fulfill({ json: [{ plan: 'free', suspended: false, approved: true }] });
    if (/\/rest\/v1\/watchlist/.test(url) && r.request().method() === 'GET') return r.fulfill({ json: FOLLOWS.map(t => ({ ticker: t, push: false })) });
    if (/\/rest\/v1\/market_quotes/.test(url)) return r.fulfill({ json: FOLLOWS.map(s => ({ symbol: s, price: 10, change: 0.1, change_pct: 1, currency: 'USD',
      market_time: new Date(start.getTime()).toISOString(), fetched_at: new Date(start.getTime()).toISOString(), source: 'yahoo' })) });
    if (r.request().method() === 'GET') return r.fulfill({ json: [] });
    return r.fulfill({ status: 204, body: '' });
  });
  const record = { accountId: 'u1', onboarded: true, follows: FOLLOWS, selected: '', positions: POSITIONS, screen: 'feed', feedTab: 'following' };
  const auth = { access_token: 'a', refresh_token: 'r', expires_at: Math.floor(start.getTime() / 1000) + 30 * 86400,
    user: { id: 'u1', email: 'u@example.com', user_metadata: {}, app_metadata: { provider: 'email' } } };
  await ctx.addInitScript(([key, rec, auth]) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem(key, JSON.stringify({ v: 2, d: rec }));
    localStorage.setItem('hif.auth.v1', JSON.stringify(auth));
  }, [KEY, record, auth]);
  // Animations at one frame a second: hours of simulated time stay fast, and they make no requests.
  await ctx.addInitScript(() => { window.requestAnimationFrame = cb => setTimeout(() => cb(performance.now()), 1000); });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.clock.install({ time: start });
  await page.goto(base + '/' + PAGE);
  // Let the app start and do its opening requests.
  await page.clock.runFor(20000);
  await page.waitForTimeout(1500);
  const opening = { ...counts, gatewayPaths: { ...counts.gatewayPaths } };
  const step = 60000, total = HOURS * 3600000;
  for (let t = 0; t < total; t += step) {
    if (active && t % (4 * 60000) === 0) await page.mouse.click(5, 5);
    // Jump a minute: every timer due fires once (enough for 60-second and 5-minute intervals).
    await page.clock.fastForward(step);
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(1500);
  await ctx.close();
  const after = { gateway: counts.gateway - opening.gateway, supabaseMarket: counts.supabaseMarket - opening.supabaseMarket, supabaseOther: counts.supabaseOther - opening.supabaseOther };
  return { opening: { gateway: opening.gateway, supabaseMarket: opening.supabaseMarket, supabaseOther: opening.supabaseOther }, after, gatewayPaths: counts.gatewayPaths, errors: errors.slice(0, 5) };
}

const server = await serve();
const base = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch();
const out = { root: ROOT, hours: HOURS };
try {
  // Tuesday 2026-10-20 13:40Z: Bucharest, Frankfurt, London and New York all trading.
  out.untouchedOpenMarkets = await scenario(browser, base, { start: new Date('2026-10-20T13:40:00Z'), active: false });
  out.inUseOpenMarkets = await scenario(browser, base, { start: new Date('2026-10-20T13:40:00Z'), active: true });
  out.untouchedSaturday = await scenario(browser, base, { start: new Date('2026-10-24T10:00:00Z'), active: false });
} finally {
  await browser.close();
  server.close();
}
console.log(JSON.stringify(out, null, 2));
