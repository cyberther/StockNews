import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMarketRequest, resetGatewayForTests, publicRequest } from '../netlify/functions/_shared/market/gateway.js';
import { classify, dealing, roFilings, resetRoFilingsForTests, ISSUERS } from '../netlify/functions/_shared/market/ro-filings.js';
import { RO_FEEDS, allItems } from '../netlify/functions/_shared/market/ro-news.js';

const originalFetch = globalThis.fetch;
const now = Math.floor(Date.now() / 1000);
const day = off => new Date(Date.now() + off * 86400000);
const rss = items => `<?xml version="1.0"?><rss><channel>${items.map(i => `<item><title><![CDATA[${i.title}]]></title>` +
  `<link>${i.link}</link><description></description><pubDate>${(i.at || day(0)).toUTCString()}</pubDate></item>`).join('')}</channel></rss>`;
test.beforeEach(() => { resetGatewayForTests(); resetRoFilingsForTests(); allItems.reset(); });
test.afterEach(() => { globalThis.fetch = originalFetch; });

test('titles are told apart: dealings, reports, marketing', () => {
  assert.equal(classify('Tranzacții PDMR în Oferta de răscumpărare acțiuni BNET (OPC)'), 'insider');
  assert.equal(classify('Notificare tranzacții persoane cu responsabilități de conducere - art. 19 MAR'), 'insider');
  assert.equal(classify('Convocare AGOA&AGEA din data de 28/29.10.2026'), 'filing');
  assert.equal(classify('Rezultate financiare S1 2026'), 'filing');
  assert.equal(classify('OMV Petrom Trading Update T3 2026'), 'filing');
  assert.equal(classify('Prima editie Shadow Volt'), null);
  assert.equal(classify('Prima editie Shadow Volt', { all: true }), 'filing');
  // The press: a named manager's dealing, or a current report; not every story about shares.
  assert.equal(classify('Directorul general al Bittnet a cumpărat acțiuni de 200.000 lei', { press: true }), 'insider');
  assert.equal(classify('Petrom anunță, printr-un raport curent, un contract de 300 mil. lei', { press: true }), 'filing');
  assert.equal(classify('Acțiunile Petrom cresc după rezultatele trimestriale', { press: true }), null);
  assert.equal(dealing('Directorul general al Bittnet a cumpărat acțiuni'), 'buy');
  assert.equal(dealing('Fondatorul a vândut acțiuni'), 'sell');
});

test('a .RO company: its own feed and the press, with no bvb.ro', async () => {
  const seen = [];
  // Every date from one instant: a feed stamped "now" when it is read made the press item a
  // second newer than the company's whenever the clock ticked between the two reads.
  const t0 = new Date(), before = h => new Date(t0.getTime() - h * 3600000);
  globalThis.fetch = async url => {
    const u = String(url); seen.push(u);
    if (u === ISSUERS['BNET.RO'].feed) return new Response(rss([
      { title: 'Tranzacții PDMR în Oferta de răscumpărare acțiuni BNET (OPC)', link: 'https://investors.bittnet.ro/tranzactii-pdmr/', at: t0 },
      { title: 'Plata cupon 13 BNET27A', link: 'https://investors.bittnet.ro/plata-cupon-13/', at: day(-3) },
      { title: 'Raport anual 2025', link: 'https://investors.bittnet.ro/raport-anual-2025/', at: day(-60) }]), { status: 200 });
    const f = RO_FEEDS.find(x => x.url === u);
    if (f) return new Response(rss(f.source === 'Profit.ro' ? [
      { title: 'Directorul general al Bittnet a cumpărat acțiuni BNET de 200.000 lei', link: 'https://www.profit.ro/bnet-1', at: before(1) },
      { title: 'Bittnet lansează un curs nou de inteligență artificială', link: 'https://www.profit.ro/bnet-2', at: before(1) }] : []), { status: 200 });
    throw new Error('unexpected ' + u);
  };
  const r = await roFilings('BNET.RO', 30);
  assert.equal(r.coverage, 'issuer');
  assert.deepEqual(r.items.map(x => [x.type, x.act, x.source, x.official]), [
    ['insider', '', 'Bittnet', true], ['insider', 'buy', 'Profit.ro', false], ['filing', '', 'Bittnet', true]]);
  assert.ok(!seen.some(u => /bvb\.ro/.test(u)));
  // Through the gateway: public, cached.
  const res = await handleMarketRequest(new Request('http://localhost/api/finnhub?path=/filings&symbol=BNET.RO'), { log: () => {} });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).items.length, 3);
  assert.equal(publicRequest('filings', { symbol: 'BNET.RO' }), true);
  assert.equal(publicRequest('filings', { symbol: 'NVDA' }), false);
});

test('a US company: Form 4 buys and sales per person and day, and SEC filings', async () => {
  const d = day(-2).toISOString().slice(0, 10);
  globalThis.fetch = async url => {
    const u = new URL(String(url));
    if (u.pathname.endsWith('/stock/insider-transactions')) return new Response(JSON.stringify({ symbol: 'NVDA', data: [
      { name: 'KRESS COLETTE', change: -5000, transactionCode: 'S', transactionPrice: 180, filingDate: d, transactionDate: d },
      { name: 'KRESS COLETTE', change: -7500, transactionCode: 'S', transactionPrice: 182, filingDate: d, transactionDate: d },
      { name: 'HUANG JEN HSUN', change: 20000, transactionCode: 'M', transactionPrice: 0, filingDate: d, transactionDate: d }] }), { status: 200 });
    if (u.pathname.endsWith('/stock/filings')) return new Response(JSON.stringify([
      { form: '8-K', acceptedDate: d + ' 16:05:00', filedDate: d + ' 00:00:00', reportUrl: 'https://www.sec.gov/Archives/edgar/data/1/a.htm' },
      { form: '4', acceptedDate: d + ' 18:00:00', reportUrl: 'https://www.sec.gov/Archives/edgar/data/1/b.xml' }]), { status: 200 });
    throw new Error('unexpected ' + u);
  };
  const res = await handleMarketRequest(new Request('http://localhost/api/finnhub?path=/filings&symbol=NVDA'), { apiKey: 'k', log: () => {} });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.coverage, 'sec');
  const ins = body.items.filter(x => x.type === 'insider');
  assert.deepEqual(ins.map(x => [x.who, x.act, x.shares, x.value]), [['Kress Colette', 'sell', 12500, 2265000]]);
  assert.deepEqual(body.items.filter(x => x.type === 'filing').map(x => x.form), ['8-K']);
});

test('German and London listings have no source yet', async () => {
  globalThis.fetch = async url => { throw new Error('unexpected ' + url); };
  const res = await handleMarketRequest(new Request('http://localhost/api/finnhub?path=/filings&symbol=SAP.DE'), { log: () => {} });
  assert.deepEqual(await res.json(), { items: [], coverage: 'none' });
});
