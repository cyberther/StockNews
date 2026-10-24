// A page left open after a deploy (a home-screen app on iPhone is brought back, not reloaded:
// 2026-10-24) reloads when the live build (/version.json) is another one: back on screen, at
// most every 5 minutes, never while the reader types or a dialog is open, never in development.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const page = readFileSync(new URL('../templates/stock-news-web/StockNewsWeb.dc.html', import.meta.url), 'utf8');
const src = page.match(/<meta name="mp-build" content="dev">\s*<script>([\s\S]*?)<\/script>/)[1];

function boot({ build = 'b1', live = 'b2', active = null, dialog = false } = {}) {
  const on = {}, calls = [];
  let reloads = 0, now = 1e12;
  const doc = { visibilityState: 'visible', activeElement: active,
    querySelector: s => s.includes('mp-build') ? { content: build } : (dialog ? {} : null),
    addEventListener: (k, f) => { on[k] = f; } };
  const ctx = vm.createContext({ document: doc, location: { reload: () => { reloads++; } },
    window: { fetch: true, addEventListener: (k, f) => { on[k] = f; } },
    fetch: async (url, o) => { calls.push([url, o && o.cache]); return { ok: true, json: async () => ({ build: live }) }; },
    Date: { now: () => now } });
  vm.runInContext(src, ctx);
  const flush = () => new Promise(r => setTimeout(r, 0));
  return { on, calls, doc, reloads: () => reloads, later: ms => { now += ms; }, flush };
}

test('back on screen with another build live: one uncached check, then a reload', async () => {
  const b = boot();
  b.on.visibilitychange(); await b.flush(); await b.flush();
  assert.deepEqual(b.calls, [['/version.json', 'no-store']]);
  assert.equal(b.reloads(), 1);
});

test('the same build live: no reload; checks at most every 5 minutes', async () => {
  const b = boot({ live: 'b1' });
  b.on.visibilitychange(); b.on.focus(); await b.flush(); await b.flush();
  assert.equal(b.calls.length, 1); assert.equal(b.reloads(), 0);
  b.later(5 * 60000 + 1); b.on.focus(); await b.flush();
  assert.equal(b.calls.length, 2);
});

test('hidden, typing, a dialog open, or a development page: no reload', async () => {
  const hidden = boot(); hidden.doc.visibilityState = 'hidden'; hidden.on.visibilitychange(); await hidden.flush();
  assert.equal(hidden.calls.length, 0);
  for (const b of [boot({ active: { tagName: 'INPUT' } }), boot({ dialog: true })]) {
    b.on.visibilitychange(); await b.flush(); await b.flush();
    assert.equal(b.calls.length, 1); assert.equal(b.reloads(), 0);
  }
  const dev = boot({ build: 'dev' });
  assert.equal(dev.on.visibilitychange, undefined, 'not even listening');
});

test('the build writes the id into the page and /version.json, never cached', () => {
  const b = readFileSync(new URL('../scripts/build.mjs', import.meta.url), 'utf8');
  assert.match(b, /<meta name="mp-build" content="\$\{build\}">/);
  assert.match(b, /version\.json[\s\S]*Cache-Control: no-store/);
});
