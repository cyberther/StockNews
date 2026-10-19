// templates/shared/hif-sw.js: a tapped alert opens the app that received it (its own origin),
// whatever host the alert's link names — so an app saved from one address never sends the
// reader to another one, where they are signed out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function loadSw(origin, windows) {
  const handlers = {}, opened = [], posted = [];
  const self = {
    location: { origin }, registration: { showNotification: async () => {} },
    addEventListener: (t, f) => { handlers[t] = f; }, skipWaiting() {},
    clients: { claim: async () => {}, openWindow: async u => { opened.push(u); },
      matchAll: async () => windows.map(url => ({ url, postMessage: m => posted.push([url, m]), focus: async () => {} })) }
  };
  new Function('self', readFileSync(new URL('../templates/shared/hif-sw.js', import.meta.url), 'utf8'))(self);
  const tap = async data => { let p; handlers.notificationclick({ notification: { data, close() {} }, waitUntil: x => { p = x; } }); await p; };
  return { tap, opened, posted };
}

test('an alert whose link names another host opens on the app\'s own host', async () => {
  const sw = loadSw('https://staging.aa-market-pulse.pages.dev', []);
  await sw.tap({ url: 'https://www.marketpulse.ro/#policy' });
  assert.deepEqual(sw.opened, ['https://staging.aa-market-pulse.pages.dev/#policy']);
});

test('an open app tab gets the alert\'s screen instead of a new window', async () => {
  const sw = loadSw('https://www.marketpulse.ro', ['https://www.marketpulse.ro/templates/stock-news-web/StockNewsWeb.dc']);
  await sw.tap({ url: 'https://www.marketpulse.ro/#alert=1,2' });
  assert.deepEqual(sw.opened, []);
  assert.deepEqual(sw.posted[0][1], { type: 'hif-open', hash: '#alert=1,2' });
});

test('an article link still opens the article', async () => {
  const sw = loadSw('https://www.marketpulse.ro', []);
  await sw.tap({ url: 'https://www.marketpulse.ro/', article: 'https://www.zf.ro/a' });
  assert.deepEqual(sw.opened, ['https://www.zf.ro/a']);
});

test('the app at the site root (/) is found as the open tab; the legal page is not', async () => {
  const sw = loadSw('https://www.marketpulse.ro', ['https://www.marketpulse.ro/legal', 'https://www.marketpulse.ro/']);
  await sw.tap({ url: 'https://www.marketpulse.ro/#policy' });
  assert.deepEqual(sw.opened, []);
  assert.equal(sw.posted[0][0], 'https://www.marketpulse.ro/');
});
