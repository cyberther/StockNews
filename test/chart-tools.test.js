// The chart analysis tab's chart (templates/shared/hif-livechart.js) in Chromium: every drawing
// tool takes its clicks and hands back a drawing that is drawn again from storage, every chart
// type, the log scale, a compared share, and every overlay and indicator at once, without a
// page error. 2026-10-24: the tab gets the usual TradingView tools.
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
const TYPES = { '.html': 'text/html', '.js': 'text/javascript' };
async function loadPlaywright() {
  const spec = process.env.PLAYWRIGHT_MODULE;
  try { const mod = await import(spec ? pathToFileURL(join(spec, 'index.js')).href : 'playwright'); return mod.chromium || (mod.default && mod.default.chromium); }
  catch (e) { return null; }
}
const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;--s-bg:#121212;--s-ink:#F5F5F7">
<div id="host" style="width:800px;height:600px"></div>
<script src="../shared/hif-livechart.js"></script></body></html>`;
const chromium = await loadPlaywright();
let browser = null, launchError = chromium ? null : new Error('the playwright package is not installed');
if (chromium) { try { browser = await chromium.launch(); } catch (e) { launchError = e; } }
if (!browser && process.env.CI) throw launchError;
const skip = browser ? false : 'Playwright with Chromium is not available';

let server, base;
test.before(async () => {
  if (skip) return;
  server = createServer(async (req, res) => {
    const rel = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    if (rel === 'templates/test/chart.html') return res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    if (rel.startsWith('..')) return res.writeHead(403).end();
    try { const b = await readFile(join(ROOT, rel)); res.writeHead(200, { 'content-type': TYPES[extname(rel)] || 'application/octet-stream' }).end(b); }
    catch (e) { res.writeHead(404).end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(async () => { if (browser) await browser.close(); if (server) server.close(); });

async function chartPage() {
  const page = await browser.newPage({ viewport: { width: 820, height: 640 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/templates/test/chart.html');
  await page.evaluate(async () => {
    const bars = [], day = 86400, t0 = 1735689600;
    let p = 100;
    for (let i = 0; i < 250; i++) { const o = p; p = Math.max(5, p + Math.sin(i / 8) * 2); bars.push({ t: t0 + i * day, o, h: Math.max(o, p) + 1, l: Math.min(o, p) - 1, c: p, v: 1e6 + i * 1000 }); }
    window.saved = [];
    window.lc = await window.HIFLiveChart.create(document.getElementById('host'), { tz: 'UTC', intraday: false, step: day,
      onDraw: list => window.saved.push(list), askText: () => 'Breakout?' });
    window.lc.setBars(bars);
    window.bars = bars;
  });
  return { page, errors };
}

test('every drawing tool takes its clicks and its drawing comes back from storage', { skip, timeout: 60000 }, async () => {
  const { page, errors } = await chartPage();
  try {
    const tools = await page.evaluate(() => window.HIFLiveChart.POINTS);
    for (const [tool, n] of Object.entries(tools)) {
      await page.evaluate(t => window.lc.setTool(t), tool);
      for (let i = 0; i < n; i++) {
        const x = 200 + i * 120, y = 200 + (i % 2) * 80;
        await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.up();
      }
    }
    await page.evaluate(() => window.lc.setTool(null));
    const last = await page.evaluate(() => window.saved[window.saved.length - 1]);
    const kept = Object.keys(tools).filter(t => t !== 'measure');
    assert.deepEqual(last.map(d => d.type).sort(), kept.sort(), 'one of each, the measurement not kept');
    for (const d of last) {
      assert.ok(d.a && d.b && Number.isFinite(d.a.t) && Number.isFinite(d.a.p), d.type);
      if (tools[d.type] === 3) assert.ok(d.m && d.m.t > d.b.t, d.type + ' has its third point');
      if (d.type === 'text') assert.equal(d.text, 'Breakout?');
    }
    // Drawn again from storage (as JSON), as when the chart opens next time.
    if (process.env.CHART_SHOT) { await page.evaluate(list => window.lc.setDrawings(list), last); await page.waitForTimeout(300); await page.screenshot({ path: process.env.CHART_SHOT }); }
    const back = await page.evaluate(list => { window.lc.setDrawings(JSON.parse(JSON.stringify(list))); window.lc.clearDrawings(); return window.saved[window.saved.length - 1].length; }, last);
    assert.equal(back, 0);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('chart types, log scale, a compared share, and every overlay and indicator together', { skip, timeout: 60000 }, async () => {
  const { page, errors } = await chartPage();
  try {
    await page.evaluate(() => {
      const C = window.HIFLiveChart;
      window.lc.setAverages(Object.fromEntries(C.AVERAGES.concat(C.OVERLAYS).map(x => [x[0], true])));
      window.lc.setIndicators(Object.fromEntries(C.INDICATORS.map(x => [x[0], true])));
      for (const t of C.TYPES) window.lc.setType(t);
      window.lc.setLog(true);
      window.lc.setCompare('MSFT', window.bars.map(b => Object.assign({}, b, { c: b.c * 2 })));
      window.lc.mergeBars([Object.assign({}, window.bars[249], { t: window.bars[249].t + 86400 })]);
      window.lc.setTheme();
      window.lc.setCompare(null);
    });
    await page.waitForTimeout(300);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
