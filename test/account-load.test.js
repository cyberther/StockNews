// Signing in, in Chromium against a stubbed Supabase (2026-10-24, the owner on an iPhone):
// - on a device with nothing saved, the ticker picker flashed up before the account's own
//   watchlist arrived, then the portfolio filled in piece by piece: the watchlist, positions
//   and settings are now read together, behind a short "loading" screen;
// - the account's saved settings (theme, the chart's set-up per ticker) are applied, and a
//   device's settings go up when the account has none;
// - the screens shown over the app (lock, onboarding, loading) had black text on the dark
//   background and ignored the light theme: they now take the app's theme.
//
// Needs Playwright with Chromium, like auth-restore-race.test.js: skipped locally without it,
// a failure under CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PAGE = '/templates/stock-news-web/StockNewsWeb.dc.html';
const TIMEOUT = 60000;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const UID = '00000000-0000-0000-0000-0000000000a1';

async function loadPlaywright() {
  const spec = process.env.PLAYWRIGHT_MODULE;
  try {
    const mod = await import(spec ? pathToFileURL(join(spec, 'index.js')).href : 'playwright');
    return mod.chromium || (mod.default && mod.default.chromium);
  } catch (e) { return null; }
}
function serveRepo() {
  const server = createServer(async (req, res) => {
    const rel = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    if (rel.startsWith('..')) { res.writeHead(403).end(); return; }
    try { const body = await readFile(join(ROOT, rel)); res.writeHead(200, { 'content-type': TYPES[extname(rel)] || 'application/octet-stream' }).end(body); }
    catch (e) { res.writeHead(404).end(); }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// One page load as a signed-in reader. `server` is what the stubbed Supabase holds for the
// account; `record` what this device has saved (null: nothing). Every screen label that was
// ever on the page is recorded, and every settings row the app wrote.
async function open(browser, base, { server, record = null, scheme = 'dark', delay = 600 }) {
  const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width: 390, height: 800 } });
  const writes = [], errors = [];
  await ctx.route('**/api/config', r => r.fulfill({ json: { supabaseUrl: 'https://stub.supabase.co', supabaseAnonKey: 'anon' } }));
  await ctx.route('https://stub.supabase.co/**', async r => {
    const url = r.request().url(), method = r.request().method();
    if (/\/auth\/v1\/settings/.test(url)) return r.fulfill({ json: {} });
    if (/account_status/.test(url)) return r.fulfill({ json: [{ plan: 'free', suspended: false, approved: true }] });
    const table = (url.match(/\/rest\/v1\/(watchlist|holdings|user_settings)\b/) || [])[1];
    if (table && method === 'GET') {
      await new Promise(res => setTimeout(res, delay));
      return r.fulfill({ json: server[table] || [] });
    }
    if (table === 'user_settings' && method === 'POST') writes.push(JSON.parse(r.request().postData() || '[]'));
    if (method === 'GET') return r.fulfill({ json: [] });
    return r.fulfill({ status: 204, body: '' });
  });
  const auth = { access_token: 'a', refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 86400,
    user: { id: UID, email: 'u@example.com', user_metadata: {}, app_metadata: { provider: 'email' } } };
  await ctx.addInitScript(([rec, auth]) => {
    if (rec) localStorage.setItem('hif.web.v2', JSON.stringify({ v: 2, d: rec }));
    localStorage.setItem('hif.auth.v1', JSON.stringify(auth));
    // A screen counts once it is on view (laid out, not hidden) for 150 ms.
    window.__screens = new Set();
    const look = () => setTimeout(() => document.querySelectorAll('[data-screen-label]').forEach(el => {
      const k = el.getAttribute('data-screen-label');
      if (!el.getClientRects().length) return;
      if (!window.__screens.has(k)) { window.__screens.add(k); (window.__log = window.__log || []).push(k + '@' + Math.round(performance.now())); }
    }), 150);
    new MutationObserver(look).observe(document, { subtree: true, childList: true });
  }, [record, auth]);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + PAGE);
  const saved = () => page.evaluate(() => { const o = JSON.parse(localStorage.getItem('hif.web.v2') || 'null'); return o && o.d; });
  return { ctx, page, writes, errors, saved, screens: () => page.evaluate(() => [...window.__screens]) };
}

const chromium = await loadPlaywright();
let browser = null;
let launchError = chromium ? null : new Error('the playwright package is not installed');
if (chromium) { try { browser = await chromium.launch(); } catch (e) { launchError = e; } }
if (!browser && process.env.CI) throw launchError;
const skip = browser ? false : 'Playwright with Chromium is not available';

let server, base;
test.before(async () => { if (skip) return; server = await serveRepo(); base = 'http://127.0.0.1:' + server.address().port; });
test.after(async () => { if (browser) await browser.close(); if (server) server.close(); });

test('a device with nothing saved: no ticker picker while the account loads, then its watchlist, positions and settings at once', { skip, timeout: TIMEOUT }, async () => {
  const r = await open(browser, base, { server: {
    watchlist: [{ ticker: 'AMD', push: true }, { ticker: 'TLV.RO', push: false }],
    holdings: [{ ticker: 'AMD', shares: 5, avg_price: 100 }, { ticker: 'TLV.RO', shares: 10, avg_price: null }],
    user_settings: [{ data: { theme: 'light', lcView: { AMD: { iv: '1d', ind: { rsi: true } } }, admin: true } }] } });
  try {
    await r.page.waitForFunction(() => { const o = JSON.parse(localStorage.getItem('hif.web.v2') || 'null'); return o && o.d && o.d.onboarded; }, null, { timeout: 20000 });
    const d = await r.saved();
    assert.deepEqual(d.follows, ['AMD', 'TLV.RO']);
    assert.deepEqual(Object.keys(d.positions).sort(), ['AMD', 'TLV.RO']);
    assert.equal(d.theme, 'light');
    assert.deepEqual(d.lcView, { AMD: { iv: '1d', ind: { rsi: true } } });
    assert.equal(d.admin, undefined);
    const screens = await r.screens();
    assert.ok(screens.includes('Loading account'), 'the loading screen showed: ' + screens);
    assert.ok(!screens.includes('Onboarding'), 'the ticker picker never showed: ' + (await r.page.evaluate(() => window.__log)));
    // What goes back up keeps the account's settings (this device's defaults only fill gaps).
    await r.page.waitForTimeout(2000);
    for (const w of r.writes) {
      assert.equal(w[0].data.theme, 'light');
      assert.deepEqual(w[0].data.lcView, { AMD: { iv: '1d', ind: { rsi: true } } });
      assert.equal(w[0].data.admin, undefined);
    }
    assert.deepEqual(r.errors, []);
  } finally { await r.ctx.close(); }
});

test('a new account with nothing on the server gets the ticker picker, and this device\'s settings go up', { skip, timeout: TIMEOUT }, async () => {
  const r = await open(browser, base, { server: {}, record: { accountId: UID, onboarded: false, theme: 'light', timeoutMin: 15 } });
  try {
    await r.page.waitForSelector('[data-screen-label="Onboarding"]', { timeout: 20000 });
    for (let i = 0; i < 40 && !r.writes.length; i++) await r.page.waitForTimeout(250);
    assert.equal(r.writes.length, 1);
    assert.equal(r.writes[0][0].user_id, UID);
    assert.equal(r.writes[0][0].data.theme, 'light');
    assert.equal(r.writes[0][0].data.timeoutMin, 15);
    assert.deepEqual(r.errors, []);
  } finally { await r.ctx.close(); }
});

for (const [theme, scheme] of [['dark', 'dark'], ['light', 'light'], ['system', 'light']]) {
  test(`the lock screen's text takes the ${theme} theme (${scheme} system), not black on the background`, { skip, timeout: TIMEOUT }, async () => {
    const r = await open(browser, base, { scheme, server: { watchlist: [{ ticker: 'AMD', push: true }] },
      record: { accountId: UID, onboarded: true, follows: ['AMD'], selected: 'AMD', positions: {}, locked: true, theme,
        session: { provider: 'email', email: 'u@example.com', userId: UID, since: Date.now() } } });
    try {
      const el = await r.page.waitForSelector('[data-screen-label="Locked"]', { timeout: 20000 });
      const c = await el.evaluate(n => ({ bg: getComputedStyle(n).backgroundColor, ink: getComputedStyle(n).color }));
      const light = scheme === 'light';
      assert.equal(c.bg, light ? 'rgb(247, 246, 244)' : 'rgb(18, 18, 18)');
      assert.equal(c.ink, light ? 'rgb(26, 26, 26)' : 'rgb(245, 245, 247)');
    } finally { await r.ctx.close(); }
  });
}
