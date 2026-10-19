// The start page (StockNewsWeb.dc.html, .lp): every text it shows exists in RO, EN and DE, and it
// shows no market data to visitors (the stored quotes are dev_only, readable by approved
// accounts only: supabase market_quotes policy), only an illustration marked as one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../templates/stock-news-web/StockNewsWeb.dc.html', import.meta.url), 'utf8');
const data = readFileSync(new URL('../templates/shared/hif-data.js', import.meta.url), 'utf8');
const KEYS = ['lpPoint1', 'lpPoint2', 'lpPoint3', 'lpMockLabel', 'lpStepsTitle', 'lpStep1t', 'lpStep3d', 'lpHiTitle', 'lpHi1t', 'lpHi3d',
  'lpMoreTitle', 'lpWho1t', 'lpWho3t', 'lpFaqTitle', 'lpQ1', 'lpA5', 'lpEndTitle', 'lpEndSub'];

test('each new start-page text exists in Romanian, English and German', () => {
  for (const lang of ['EN', 'RO', 'DE']) {
    const i = data.indexOf(`  ${lang}: { lpTag:`);
    assert.ok(i >= 0, lang);
    const block = data.slice(i, data.indexOf('lpF10d:', i));
    for (const k of KEYS) assert.match(block, new RegExp(`\\b${k}:'`), `${lang} ${k}`);
  }
});

test('the start page shows no live quotes or stories to visitors, and labels its illustration', () => {
  const lp = app.slice(app.indexOf('data-screen-label="Landing"'), app.indexOf('<footer style="flex:none;margin-top:auto'));
  assert.doesNotMatch(lp, /lpTickers|lpFeat\b|lpFeat\./);
  assert.doesNotMatch(app, /LANDING_TICKERS/);
  assert.match(lp, /ui\.lpMockLabel/);
  for (const k of ['lpPoints', 'lpSteps', 'lpHighlights', 'lpFaq']) assert.match(lp, new RegExp(`list="\\{\\{ ${k} \\}\\}"`), k);
});
