import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMarketRequest, resetGatewayForTests } from '../netlify/functions/_shared/market/gateway.js';
import { parseRss, storyId, companyNews, marketNews, resetRoNewsForTests, RO_FEEDS } from '../netlify/functions/_shared/market/ro-news.js';

const originalFetch = globalThis.fetch;
const req = q => new Request('http://localhost:8080/api/finnhub?' + q);
const J = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const now = Math.floor(Date.now() / 1000);
const rfc = sec => new Date(sec * 1000).toUTCString();

function rss(items) {
  return `<?xml version="1.0"?><rss><channel><title>x</title>${items.map(i => `<item><title><![CDATA[${i.title}]]></title>` +
    `<link>${i.link}</link><description><![CDATA[<p>${i.desc || ''}</p>]]></description><pubDate>${rfc(i.at || now)}</pubDate></item>`).join('')}</channel></rss>`;
}
// Every feed answers with the same items; anything else is unexpected.
function feeds(items, extra) {
  const seen = [];
  globalThis.fetch = async url => {
    const u = String(url);
    seen.push(u);
    if (RO_FEEDS.some(f => f.url === u)) return new Response(rss(items), { status: 200 });
    if (extra) return extra(new URL(u));
    throw new Error('unexpected ' + u);
  };
  return seen;
}
test.beforeEach(() => { resetGatewayForTests(); resetRoNewsForTests(); });
test.afterEach(() => { globalThis.fetch = originalFetch; });

test('RSS items are parsed: CDATA, entities, HTML stripped, cedilla text kept', () => {
  const items = parseRss(rss([{ title: 'Romgaz &amp; Petrom: profit &#8222;record&#8221;', link: 'https://www.zf.ro/a/1', desc: 'Acţiunile <b>au crescut</b> cu 2%.' }]), 'Ziarul Financiar');
  assert.equal(items.length, 1);
  assert.equal(items[0].headline, 'Romgaz & Petrom: profit „record”');
  assert.equal(items[0].summary, 'Acţiunile au crescut cu 2%.');
  assert.equal(items[0].source, 'Ziarul Financiar');
});

test('story ids are stable numbers from the link', () => {
  assert.equal(storyId('https://www.zf.ro/a/1'), storyId('https://www.zf.ro/a/1'));
  assert.notEqual(storyId('https://www.zf.ro/a/1'), storyId('https://www.zf.ro/a/2'));
  assert.ok(Number.isSafeInteger(storyId('https://www.zf.ro/a/1')));
});

test('a company is matched by its name or alias as the press writes it, not by ordinary words', async () => {
  feeds([
    { title: 'Electrica anunță investiții de 1 mld. lei', link: 'https://a.ro/1' },
    { title: 'Prețul la energie electrică a scăzut în octombrie', link: 'https://a.ro/2' },
    { title: 'ROMGAZ a început forajul la Caragele', link: 'https://a.ro/3' },
    { title: 'Apartamentele din Timișoara s-au scumpit', link: 'https://a.ro/4' },
    { title: 'Bursa: acțiunile Băncii (TLV) au urcat', link: 'https://a.ro/5' }
  ]);
  assert.deepEqual((await companyNews('EL.RO')).map(x => x.url), ['https://a.ro/1']);
  assert.deepEqual((await companyNews('SNG.RO')).map(x => x.url), ['https://a.ro/3']);
  assert.deepEqual((await companyNews('TLV.RO')).map(x => x.url), ['https://a.ro/5']);
  assert.deepEqual(await companyNews('ALCQ.RO'), []); // "Alcom Timisoara" is not "Timișoara"
});

test('the market feed files each story under the company named first', async () => {
  feeds([{ title: 'OMV Petrom redevine cea mai valoroasă companie, înaintea Hidroelectrica', link: 'https://a.ro/1' }]);
  const m = await marketNews(10);
  assert.equal(m.length, 1);
  assert.equal(m[0].related, 'SNP.RO');
  assert.equal(m[0].category, 'company');
});

test('.RO quotes come from Yahoo and never touch the backup providers', async () => {
  const seen = feeds([], u => {
    if (u.hostname.endsWith('yahoo.com')) return J({ chart: { result: [{ meta: { currency: 'RON', regularMarketPrice: 35.5, chartPreviousClose: 35, regularMarketDayHigh: 36, regularMarketDayLow: 34.9, regularMarketTime: 1791881331, longName: 'Banca Transilvania S.A.' } }] } });
    throw new Error('unexpected ' + u);
  });
  const keys = { finnhub: 'f', twelvedata: 't', fmp: 'm', alphavantage: 'a' };
  const r = await handleMarketRequest(req('path=/quote&symbol=TLV.RO'), { keys, log: () => {} });
  assert.equal(r.headers.get('x-market-source'), 'yahoo');
  const q = await r.json();
  assert.equal(q.c, 35.5); assert.equal(q.pc, 35); assert.ok(Math.abs(q.dp - 1.4286) < 0.001);
  const p = await (await handleMarketRequest(req('path=/stock/profile2&symbol=TLV.RO'), { keys, log: () => {} })).json();
  assert.equal(p.name, 'Banca Transilvania'); assert.equal(p.currency, 'RON');
  assert.ok(seen.every(u => u.includes('yahoo.com')));
});

test('.RO company news comes from the Romanian press, /ro-news lists the market', async () => {
  feeds([{ title: 'Hidroelectrica se apreciază cu 1,6%', link: 'https://www.zf.ro/h2o', at: now - 3600 }]);
  const today = new Date().toISOString().slice(0, 10);
  const r = await handleMarketRequest(req(`path=/company-news&symbol=H2O.RO&from=${today.slice(0, 8)}01&to=${today}`), { log: () => {} });
  assert.equal(r.headers.get('x-market-source'), 'ronews');
  const rows = await r.json();
  assert.equal(rows[0].related, 'H2O.RO');
  assert.equal(rows[0].id, storyId('https://www.zf.ro/h2o'));
  const m = await handleMarketRequest(req('path=/ro-news'), { log: () => {} });
  assert.equal(m.status, 200);
  assert.match(m.headers.get('netlify-cdn-cache-control'), /max-age=600/);
  assert.equal((await m.json())[0].related, 'H2O.RO');
});

test('a failing feed is skipped; the others still answer', async () => {
  globalThis.fetch = async url => {
    const u = String(url);
    if (u === RO_FEEDS[0].url) throw new Error('down');
    if (RO_FEEDS.some(f => f.url === u)) return new Response(rss([{ title: 'Transgaz semnează un contract', link: 'https://a.ro/tgn' }]));
    throw new Error('unexpected ' + u);
  };
  assert.equal((await companyNews('TGN.RO')).length, 1);
});

test('IAR Brașov is IARV, not the exchange named later in the headline', async () => {
  feeds([{ title: 'IAR Braşov, companie de stat, a pierdut aproape 100 mil. lei din capitalizare în două zile la Bursa de Valori Bucureşti', link: 'https://zf.ro/iar' },
    { title: 'Iar acțiunile au crescut, spune Bursa de Valori București', link: 'https://zf.ro/iar2' }]);
  const m = await marketNews(10);
  assert.equal(m.find(x => x.url === 'https://zf.ro/iar').related, 'IARV.RO');
  assert.equal(m.find(x => x.url === 'https://zf.ro/iar2').related, 'BVB.RO');
});

test('HTML escaped inside a feed (The Guardian) is stripped too', () => {
  const xml = '<rss><channel><item><title>Mercedes boss warns</title><link>https://www.theguardian.com/a</link>' +
    '<description>&lt;p&gt;Ola Källenius says it will &lt;a href="x"&gt;weaken&lt;/a&gt; the industry&lt;/p&gt;</description>' +
    '<pubDate>' + new Date().toUTCString() + '</pubDate></item></channel></rss>';
  assert.equal(parseRss(xml, 'The Guardian')[0].summary, 'Ola Källenius says it will weaken the industry');
});
