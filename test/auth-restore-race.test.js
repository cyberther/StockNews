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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEMPLATES = {
  web: { path: 'templates/stock-news-web/StockNewsWeb.dc.html', key: 'hif.web.v2' },
  published: { path: 'published/templates/stock-news-web/StockNewsWeb.dc.html', key: 'hif.web.v2' },
  dark: { path: 'templates/stock-news-dark/StockNewsDark.dc.html', key: 'hif.dark.v2' },
};
// Guards against a hang, not a wait: every step below waits for an event, not a duration.
const TIMEOUT = 60000;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

async function loadPlaywright() {
  const spec = process.env.PLAYWRIGHT_MODULE;
  try {
    const mod = await import(spec ? pathToFileURL(join(spec, 'index.js')).href : 'playwright');
    return mod.chromium || (mod.default && mod.default.chromium);
  } catch (e) { return null; }
}

// resetOnce: a path pattern whose first request gets its connection reset (the CI failure of
// 2026-10-24: one ECONNRESET on route.fetch left the page waiting for hif-store.js until the
// test timed out).
function serveRepo({ resetOnce = null } = {}) {
  const server = createServer(async (req, res) => {
    const rel = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    if (resetOnce && resetOnce.test(rel)) { resetOnce = null; req.socket.destroy(); return; }
    if (rel.startsWith('..')) { res.writeHead(403).end(); return; }
    try {
      const published = rel.startsWith('published/');
      const body = await readFile(join(published ? publishedRoot : ROOT, published ? rel.slice(10) : rel));
      res.writeHead(200, { 'content-type': TYPES[extname(rel)] || 'application/octet-stream' }).end(body);
    } catch (e) { res.writeHead(404).end(); }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// One page load plus a reload; returns the persisted record after each, and every
// watchlist/holdings DELETE the app sent to the stub.
async function run(browser, base, tpl, { savedAccount, sessUser, late, latePush = tpl === 'published' }) {
  const { path, key } = TEMPLATES[tpl];
  const ctx = await browser.newContext();
  const deletes = [], errors = [];
  // A load is settled once it has mirrored both tables: each sync ends with a DELETE, and
  // both run (after their debounce) only once the session has been applied to the restored
  // record. Waiting for them, not for a fixed time, holds under any CPU load.
  let onDelete = () => {}, settleNow = () => {};
  const settled = () => {
    const from = deletes.length;
    return new Promise(resolve => {
      settleNow = resolve;
      onDelete = () => {
        const seen = new Set(deletes.slice(from).map(q => q.split('?')[0]));
        if (seen.has('watchlist') && seen.has('holdings')) resolve();
      };
    });
  };
  await ctx.route('**/api/config', r => r.fulfill({ json: { supabaseUrl: 'https://stub.supabase.co', supabaseAnonKey: 'anon' } }));
  await ctx.route('https://stub.supabase.co/**', r => {
    const url = r.request().url(), method = r.request().method();
    const table = (url.match(/\/rest\/v1\/(watchlist|holdings)\b/) || [])[1];
    if (table && method === 'DELETE') { deletes.push(table + decodeURIComponent(url.split(table)[1])); onDelete(); }
    if (/\/auth\/v1\/settings/.test(url)) return r.fulfill({ json: {} });
    if (/account_status/.test(url)) return r.fulfill({ json: [{ plan: 'free', suspended: false }] });
    if (method === 'GET') return r.fulfill({ json: [] }); // empty server watchlist and holdings: the worst case
    return r.fulfill({ status: 204, body: '' });
  });
  // Define window.HIFStore only once bootAuth has offered the session to the app (it sets
  // __hifAuthSub right after applyAuthSession), so the session wins the race on every run.
  // A fixed delay could expire before HIFAuth.ready under load and test nothing.
  // A script served through the route, wrapped or not. A reset connection (seen on CI) is tried
  // again; one that keeps failing is aborted and reported, never left without an answer (the
  // page would wait for it until the test times out).
  const serve = async (r, wrap) => {
    let last;
    for (let i = 0; i < 3; i++) {
      try { const res = await r.fetch(), src = await res.text(); return await r.fulfill({ response: res, body: wrap ? wrap(src) : src }); }
      catch (e) { last = e; }
    }
    errors.push('could not serve ' + r.request().url() + ': ' + (last && last.message));
    await r.abort().catch(() => {});
    onDelete = () => {}; settleNow();
  };
  const afterSession = src => `(function wait(){ if (!window.__hifAuthSub) return setTimeout(wait, 10);\n${src}\n})();`;
  await ctx.route(/\/hif-store\.js(?:\?.*)?$/, r => serve(r, late ? afterSession : null));
  // Published boot must survive the account adapter arriving after the session.
  if (latePush) await ctx.route(/\/hif-push\.js(?:\?.*)?$/, r => serve(r, afterSession));
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
  let done = settled();
  await page.goto(base + '/' + path);
  await done;
  const first = await saved();
  done = settled();
  await page.reload();
  await done;
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

let server, base, publishedRoot, faultServer, faultBase;
test.before(async () => {
  if (skip) return;
  publishedRoot = mkdtempSync(join(tmpdir(), 'marketpulse-published-test-'));
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: ROOT, env: { ...process.env, BUILD_OUT: publishedRoot, CF_PAGES: '0' }, stdio: 'pipe' });
  server = await serveRepo();
  base = 'http://127.0.0.1:' + server.address().port;
  faultServer = await serveRepo({ resetOnce: /^published\/templates\/shared\/hif-store\.js$/ });
  faultBase = 'http://127.0.0.1:' + faultServer.address().port;
});
test.after(async () => {
  if (browser) await browser.close();
  if (server) server.close();
  if (faultServer) faultServer.close();
  if (publishedRoot) rmSync(publishedRoot, {recursive:true,force:true});
});

// Each case has its own browser context, so they can run side by side.
describe('auth session vs. late restore', { concurrency: true }, () => {
  // CI, 2026-10-24: one reset connection while the test served hif-store.js left the page
  // waiting for it, and the case timed out. The script is now fetched again.
  test('published: a reset connection while serving a script is tried again, not left hanging', { skip, timeout: TIMEOUT }, async () => {
    const r = await run(browser, faultBase, 'published', { savedAccount: 'user-1', sessUser: 'user-1', late: false });
    assert.deepEqual(r.errors, []);
    for (const d of r.loads) { assert.equal(d.accountId, 'user-1'); assert.deepEqual(d.follows, ['MSFT', 'AMD']); }
  });

  for (const tpl of Object.keys(TEMPLATES)) {
    for (const late of [false, true]) {
      const when = late ? 'store loads after the session' : 'store loads first';
      test(`${tpl}: a returning account keeps its saved state (${when})`, { skip, timeout: TIMEOUT }, async () => {
        const r = await run(browser, base, tpl, { savedAccount: 'user-1', sessUser: 'user-1', late });
        assert.deepEqual(r.errors, []);
        for (const d of r.loads) {
          assert.equal(d.accountId, 'user-1');
          assert.equal(d.onboarded, true);
          assert.deepEqual(d.follows, ['MSFT', 'AMD']);
          assert.deepEqual(Object.keys(d.positions), ['AMD']);
        }
        // Server rows are only pruned against the kept list, never wiped.
        for (const q of r.deletes) assert.match(q, /ticker=not\.in\./);
      });

      test(`${tpl}: a different account starts fresh (${when})`, { skip, timeout: TIMEOUT }, async () => {
        const r = await run(browser, base, tpl, { savedAccount: 'user-0', sessUser: 'user-1', late });
        assert.deepEqual(r.errors, []);
        for (const d of r.loads) {
          assert.equal(d.accountId, 'user-1');
          assert.equal(d.onboarded, false);
          assert.deepEqual(d.follows, []);
          assert.deepEqual(d.positions, {});
        }
      });

      test(`${tpl}: a first sign-in with no saved record applies the session (${when})`, { skip, timeout: TIMEOUT }, async () => {
        const r = await run(browser, base, tpl, { savedAccount: undefined, sessUser: 'user-1', late });
        assert.deepEqual(r.errors, []);
        for (const d of r.loads) {
          assert.equal(d.accountId, 'user-1');
          assert.deepEqual(d.follows, []);
        }
      });
    }
  }
});
