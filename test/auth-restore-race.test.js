// The Supabase session can arrive before the saved local record has been restored
// (hif-store.js may load after the template logic is evaluated). applyAuthSession must
// wait for that record, or it compares against the default accountId (null) and treats a
// returning user as a new account. This loads both templates in Chromium against a
// stubbed Supabase, with window.HIFStore deferred so the session wins the race.
//
// Needs Playwright with Chromium (`npx playwright install chromium`). Locally it is
// skipped when either is missing; under CI it fails instead, so it can't silently stop
// running. Point PLAYWRIGHT_MODULE at a playwright package directory to use one outside
// node_modules.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEMPLATES = {
  web: { path: 'templates/stock-news-web/StockNewsWeb.dc.html', key: 'hif.web.v2' },
  dark: { path: 'templates/stock-news-dark/StockNewsDark.dc.html', key: 'hif.dark.v2' },
};
const STORE_DELAY = 1500;
const SETTLE = 4000;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

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
    try {
      const body = await readFile(join(ROOT, rel));
      res.writeHead(200, { 'content-type': TYPES[extname(rel)] || 'application/octet-stream' }).end(body);
    } catch (e) { res.writeHead(404).end(); }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// One page load plus a reload; returns the persisted record after each, and every
// watchlist DELETE filter the app sent to the stub.
async function run(browser, base, tpl, { savedAccount, sessUser, storeDelay }) {
  const { path, key } = TEMPLATES[tpl];
  const ctx = await browser.newContext();
  const deletes = [], errors = [];
  await ctx.route('**/api/config', r => r.fulfill({ json: { supabaseUrl: 'https://stub.supabase.co', supabaseAnonKey: 'anon' } }));
  await ctx.route('https://stub.supabase.co/**', r => {
    const url = r.request().url(), method = r.request().method();
    if (/\/watchlist/.test(url) && method === 'DELETE') deletes.push(decodeURIComponent(url.split('watchlist')[1]));
    if (/\/auth\/v1\/settings/.test(url)) return r.fulfill({ json: {} });
    if (/account_status/.test(url)) return r.fulfill({ json: [{ plan: 'free', suspended: false }] });
    if (method === 'GET') return r.fulfill({ json: [] }); // empty server watchlist: the worst case
    return r.fulfill({ status: 204, body: '' });
  });
  // Define window.HIFStore only after the logic has run and HIFAuth.ready has resolved.
  await ctx.route('**/hif-store.js', async r => {
    const res = await r.fetch(), src = await res.text();
    r.fulfill({ response: res, body: storeDelay ? `setTimeout(function(){${src}\n}, ${storeDelay});` : src });
  });
  const record = savedAccount === undefined ? null : { accountId: savedAccount, onboarded: true, follows: ['MSFT', 'AMD'], selected: 'AMD',
    positions: { AMD: { shares: 5, cost: '100' } }, screen: 'feed' };
  const auth = { access_token: 'a', refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 86400,
    user: { id: sessUser, email: 'u@example.com', user_metadata: {}, app_metadata: { provider: 'email' } } };
  await ctx.addInitScript(([key, rec, auth]) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    if (rec) localStorage.setItem(key, JSON.stringify({ v: 2, d: rec }));
    localStorage.setItem('hif.auth.v1', JSON.stringify(auth));
  }, [key, record, auth]);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  const saved = () => page.evaluate(k => { const o = JSON.parse(localStorage.getItem(k) || 'null'); return o && o.d; }, key);
  await page.goto(base + '/' + path);
  await page.waitForTimeout(storeDelay + SETTLE);
  const first = await saved();
  await page.reload();
  await page.waitForTimeout(storeDelay + SETTLE);
  const second = await saved();
  await ctx.close();
  return { loads: [first, second], deletes, errors };
}

const chromium = await loadPlaywright();
let browser = null;
let launchError = chromium ? null : new Error('the playwright package is not installed');
if (chromium) { try { browser = await chromium.launch(); } catch (e) { launchError = e; } }
if (!browser && process.env.CI) throw launchError;
const skip = browser ? false : 'Playwright with Chromium is not available';

let server, base;
test.before(async () => {
  if (skip) return;
  server = await serveRepo();
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(async () => {
  if (browser) await browser.close();
  if (server) server.close();
});

// Each case has its own browser context, so they can share the waits.
describe('auth session vs. late restore', { concurrency: true }, () => {
  for (const tpl of Object.keys(TEMPLATES)) {
    for (const storeDelay of [0, STORE_DELAY]) {
      const when = storeDelay ? 'store loads after the session' : 'store loads first';
      test(`${tpl}: a returning account keeps its saved state (${when})`, { skip }, async () => {
        const r = await run(browser, base, tpl, { savedAccount: 'user-1', sessUser: 'user-1', storeDelay });
        assert.deepEqual(r.errors, []);
        for (const d of r.loads) {
          assert.equal(d.accountId, 'user-1');
          assert.equal(d.onboarded, true);
          assert.deepEqual(d.follows, ['MSFT', 'AMD']);
          if (tpl === 'web') assert.deepEqual(Object.keys(d.positions), ['AMD']);
        }
        // Rows are only pruned against the kept list, never wiped.
        for (const q of r.deletes) assert.match(q, /ticker=not\.in\./);
      });

      test(`${tpl}: a different account starts fresh (${when})`, { skip }, async () => {
        const r = await run(browser, base, tpl, { savedAccount: 'user-0', sessUser: 'user-1', storeDelay });
        assert.deepEqual(r.errors, []);
        for (const d of r.loads) {
          assert.equal(d.accountId, 'user-1');
          assert.equal(d.onboarded, false);
          assert.deepEqual(d.follows, []);
          if (tpl === 'web') assert.deepEqual(d.positions, {});
        }
      });

      test(`${tpl}: a first sign-in with no saved record applies the session (${when})`, { skip }, async () => {
        const r = await run(browser, base, tpl, { savedAccount: undefined, sessUser: 'user-1', storeDelay });
        assert.deepEqual(r.errors, []);
        for (const d of r.loads) {
          assert.equal(d.accountId, 'user-1');
          assert.deepEqual(d.follows, []);
        }
      });
    }
  }
});
