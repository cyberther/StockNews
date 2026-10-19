// Clean addresses (scripts/build.mjs _redirects): the app lives at www.marketpulse.ro/, so its
// own links and the manifest name root paths, and an old /templates/... address is tidied in
// the address bar.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const app = read('templates/stock-news-web/StockNewsWeb.dc.html');

test('the home-screen manifest starts at / and keeps the installed app\'s identity', () => {
  const m = JSON.parse(read('templates/stock-news-web/manifest.webmanifest'));
  assert.equal(m.start_url, '/');
  assert.equal(m.scope, '/');
  // Without an id, Chrome takes start_url as the app's identity: the old one keeps it.
  assert.equal(m.id, '/templates/stock-news-web/StockNewsWeb.dc.html');
});

test('the pages link each other by their clean addresses', () => {
  assert.doesNotMatch(app, /'\.\/(legal|intelligence)\.html/);
  assert.match(app, /'\/legal\?lang='/);
  assert.match(app, /'\/calculator'/);
  assert.match(read('templates/stock-news-web/legal.html'), /class="brand" href="\/"/);
  assert.match(read('templates/stock-news-web/intelligence.html'), /href="\/#policy"/);
});

test('an old address is replaced by / in the bar (not in an installed app), and /login opens sign-in', () => {
  assert.match(app, /cleanAddress\(\)/);
  assert.match(app, /stocknewsweb\\\.dc/i);
  assert.match(app, /display-mode: standalone/);
  assert.match(app, /p === '\/login'/);
});

// The design-system stylesheet that named the font was removed (16c0058); the app then fell
// back to the browser's serif. The font is served from the site (the CSP allows no other).
test('the app names its font and serves Archivo itself, with Romanian letters', () => {
  assert.match(app, /--font-heading:'Archivo'/);
  assert.match(app, /--font-body:'Archivo'/);
  // The start page sits outside .app: the page and .lp name the font too.
  assert.match(app, /body\{margin:0;background:var\(--s-bg\);font-family:var\(--font-body\)\}\.lp\{font-family:var\(--font-body\);/);
  for (const f of ['archivo-latin.woff2', 'archivo-latin-ext.woff2']) {
    assert.match(app, new RegExp(`url\\('/templates/shared/fonts/${f.replace('.', '\\.')}'\\)`));
    assert.ok(readFileSync(new URL('../templates/shared/fonts/' + f, import.meta.url)).length > 10000, f);
  }
  // ș and ț (U+0219, U+021B) are in the latin-ext range.
  assert.match(app, /unicode-range:U\+0100-02BA/);
});
