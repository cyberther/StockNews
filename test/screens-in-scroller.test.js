// Every screen of the web app sits inside .app-main, the one container that scrolls (.app
// itself hides what overflows). 2026-10-24: a stray </div> in the paywall (since 2026-10-19)
// closed .app-main early, so Account, Security, Alerts and Admin were outside it and could
// not be scrolled to the bottom on a phone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const lines = readFileSync(new URL('../templates/stock-news-web/StockNewsWeb.dc.html', import.meta.url), 'utf8').split('\n');
const start = lines.findIndex(l => /class="app-main"/.test(l));

test('each screen opens inside .app-main and leaves its <div>s balanced', () => {
  assert.ok(start > 0);
  let depth = 0, screens = [], closed = -1;
  for (let i = start; i < lines.length; i++) {
    const m = /^<sc-if value="\{\{ (is[A-Z]\w*) \}\}"/.exec(lines[i]);
    if (m && depth > 0) screens.push([m[1], depth]);
    depth += (lines[i].match(/<div\b/g) || []).length - (lines[i].match(/<\/div>/g) || []).length;
    if (depth === 0) { closed = i; break; }
  }
  const names = screens.map(s => s[0]);
  for (const s of ['isFeed', 'isDetail', 'isPolicy', 'isWatch', 'isPortfolio', 'isPaywall', 'isAccount', 'isAlertScreen', 'isAdminScreen', 'isSecurity'])
    assert.ok(names.includes(s), s + ' is inside .app-main (it closes at line ' + (closed + 1) + ')');
  for (const [name, d] of screens) if (name !== 'isFreeTier') assert.equal(d, 1, name + ' starts directly in .app-main');
});
