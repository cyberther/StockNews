import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMarketRequest, resetGatewayForTests } from '../netlify/functions/_shared/market/gateway.js';
import { euCompanyNews, resetEuNewsForTests, EU_FEEDS } from '../netlify/functions/_shared/market/eu-news.js';
import { yahoo } from '../netlify/functions/_shared/market/providers/yahoo.js';

const originalFetch = globalThis.fetch;
const req = q => new Request('http://localhost:8080/api/finnhub?' + q);
const now = Math.floor(Date.now() / 1000);
const rss = items => `<?xml version="1.0"?><rss><channel>${items.map(i => `<item><title><![CDATA[${i.title}]]></title>` +
  `<link>${i.link}</link><description><![CDATA[${i.desc || ''}]]></description><pubDate>${new Date(now * 1000).toUTCString()}</pubDate></item>`).join('')}</channel></rss>`;
function feeds(items, extra) {
  const seen = [];
  globalThis.fetch = async url => {
    const u = String(url);
    seen.push(u);
    if (EU_FEEDS.some(f => f.url === u)) return new Response(rss(items), { status: 200 });
    if (extra) return extra(new URL(u));
    throw new Error('unexpected ' + u);
  };
  return seen;
}
test.beforeEach(() => { resetGatewayForTests(); resetEuNewsForTests(); });
test.afterEach(() => { globalThis.fetch = originalFetch; });

test('German and British companies are matched by name, compounds included, ordinary words not', async () => {
  feeds([
    { title: 'Siemens-Aktie legt nach Zahlen zu', link: 'https://a.de/1' },
    { title: 'Siemens Energy erhält Großauftrag', link: 'https://a.de/2' },
    { title: 'Eine Allianz für den Mittelstand', link: 'https://a.de/3' },
    { title: 'Allianz steigert den Gewinn', link: 'https://a.de/4' },
    { title: 'Tesco and Sainsbury\'s raise prices', link: 'https://a.co.uk/5' },
    { title: 'What the next Budget means for savers', link: 'https://a.co.uk/6' }
  ]);
  assert.deepEqual((await euCompanyNews('SIE.DE')).map(x => x.url), ['https://a.de/1']);
  assert.deepEqual((await euCompanyNews('ENR.DE')).map(x => x.url), ['https://a.de/2']);
  assert.deepEqual((await euCompanyNews('ALV.DE')).map(x => x.url), ['https://a.de/4']);
  assert.deepEqual((await euCompanyNews('TSCO.L')).map(x => x.url), ['https://a.co.uk/5']);
  assert.deepEqual((await euCompanyNews('SBRY.L')).map(x => x.url), ['https://a.co.uk/5']);
  assert.deepEqual(await euCompanyNews('NXT.L'), []);
  const [s] = await euCompanyNews('TSCO.L');
  assert.equal(s.related, 'TSCO.L');
  assert.ok(Number.isSafeInteger(s.id));
});

test('.DE and .L news comes from the press, without sign-in and without Finnhub', async () => {
  const seen = feeds([{ title: 'BMW verlagert Produktion nach Ungarn', link: 'https://a.de/1' }]);
  const r = await handleMarketRequest(req(`path=/company-news&symbol=BMW.DE&from=${new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10)}&to=${new Date(Date.now() + 86400000).toISOString().slice(0, 10)}`), { keys: {}, log: () => {} });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(await r.text()).map(x => x.url), ['https://a.de/1']);
  assert.ok(!seen.some(u => u.includes('finnhub')));
});

test('London prices in pence become pounds, in quotes and charts', async () => {
  const data = { chart: { result: [{ meta: { currency: 'GBp', regularMarketPrice: 7250, chartPreviousClose: 7100, longName: 'Vodafone Group' },
    timestamp: [1, 2], indicators: { quote: [{ close: [7100, 7250], volume: [10, 20] }] } }] } };
  const q = await yahoo.transform('quote', data, { symbol: 'VOD.L' });
  assert.equal(q.c, 72.5);
  assert.equal(q.pc, 71);
  const c = await yahoo.transform('chart', data, { symbol: 'VOD.L' });
  assert.equal(c.chart.result[0].meta.currency, 'GBP');
  assert.deepEqual(c.chart.result[0].indicators.quote[0].close, [71, 72.5]);
  assert.deepEqual(c.chart.result[0].indicators.quote[0].volume, [10, 20]);
  const p = await yahoo.transform('profile', data, { symbol: 'VOD.L' });
  assert.equal(p.currency, 'GBP');
  // Euros are left alone.
  const eur = { chart: { result: [{ meta: { currency: 'EUR', regularMarketPrice: 197.3, chartPreviousClose: 194.5 } }] } };
  assert.equal((await yahoo.transform('quote', eur, { symbol: 'SAP.DE' })).c, 197.3);
});
