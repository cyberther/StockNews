import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMarketRequest, resetGatewayForTests, publicRequest } from '../netlify/functions/_shared/market/gateway.js';
import { tickersIn, usCompanyNews, usMarketNews, namesFor, resetUsNewsForTests, US_FEEDS } from '../netlify/functions/_shared/market/us-news.js';

const originalFetch = globalThis.fetch;
const now = Math.floor(Date.now() / 1000);
const rss = items => `<?xml version="1.0"?><rss><channel>${items.map(i => `<item><title><![CDATA[${i.title}]]></title>` +
  `<link>${i.link}</link><description><![CDATA[${i.desc || ''}]]></description><pubDate>${new Date(now * 1000).toUTCString()}</pubDate></item>`).join('')}</channel></rss>`;
// Items per source name; every feed of that source answers with them.
function feeds(bySource, extra) {
  globalThis.fetch = async url => {
    const u = String(url), f = US_FEEDS.find(x => x.url === u);
    if (f) return new Response(rss(bySource[f.source] || []), { status: 200 });
    if (extra) return extra(new URL(u));
    throw new Error('unexpected ' + u);
  };
}
test.beforeEach(() => { resetGatewayForTests(); resetUsNewsForTests(); });
test.afterEach(() => { globalThis.fetch = originalFetch; });

test('exchange tags name the issuer of a press release', () => {
  assert.deepEqual(tickersIn('Oklo Inc. (NYSE: OKLO) announces ... with NuScale (NYSE:SMR)'), ['OKLO', 'SMR']);
  assert.deepEqual(tickersIn('Apple (Nasdaq: AAPL; NYSE: X) and (NYSE American: UEC), (OTCQX: ABCD)'), ['AAPL', 'X', 'UEC', 'ABCD']);
  assert.deepEqual(tickersIn('NYSE trading resumes at 9:30'), []);
  assert.deepEqual(namesFor('OKLO', 'Oklo Inc'), ['Oklo']);
  assert.deepEqual(namesFor('TGT', 'Target Corp'), []);
  assert.deepEqual(namesFor('GOOGL', 'Alphabet Inc Class A'), ['Google', 'Alphabet']);
});

test('a company gets its own releases and the press headlines that name it', async () => {
  feeds({
    'PR Newswire': [{ title: 'Oklo Signs Fuel Agreement', desc: 'SANTA CLARA, Calif. -- Oklo Inc. (NYSE: OKLO) today announced...', link: 'https://www.prnewswire.com/news-releases/oklo-1.html' },
      { title: 'Acme Partners With Oklo', desc: 'Acme Corp (NASDAQ: ACME) and Oklo...', link: 'https://www.prnewswire.com/news-releases/acme-2.html' }],
    'Business Wire': [{ title: 'Oklo to Report Third Quarter Results', desc: 'Oklo Inc. (NYSE: OKLO)', link: 'http://www.businesswire.com/news/home/2026/en/Oklo-Q3/?feedref=x' }],
    CNBC: [{ title: 'Oklo shares jump after reactor approval', link: 'https://www.cnbc.com/2026/10/15/oklo.html' },
      { title: 'Nuclear stocks rally as power demand grows', desc: 'Oklo and others rose.', link: 'https://www.cnbc.com/2026/10/15/nuclear.html' },
      { title: 'Oklo, Delta and more in Morning Squawk', link: 'https://www.cnbc.com/2026/10/15/squawk.html' }],
    MarketWatch: [{ title: 'Target cuts its outlook', link: 'https://www.marketwatch.com/story/target-1' }]
  });
  const rows = await usCompanyNews('OKLO', 'Oklo Inc', null, null);
  // The partner's release (ACME is the issuer) and a story naming Oklo only in its text are not Oklo's.
  assert.deepEqual(rows.map(x => x.url).sort(), ['https://www.businesswire.com/news/home/2026/en/Oklo-Q3/?feedref=x',
    'https://www.cnbc.com/2026/10/15/oklo.html', 'https://www.prnewswire.com/news-releases/oklo-1.html']);
  assert.ok(rows.every(x => x.related === 'OKLO' && Number.isSafeInteger(x.id)));
  // "Target" is an everyday word: not matched by name.
  assert.deepEqual(await usCompanyNews('TGT', 'Target Corp', null, null), []);
  // For the scan: releases under their issuer, press stories under the companies given.
  const all = await usMarketNews({ OKLO: 'Oklo Inc' }, 50);
  assert.deepEqual(all.map(x => x.related).sort(), ['ACME', 'OKLO', 'OKLO', 'OKLO']);
});

test('US company news is Finnhub\'s plus the press, and /us-news is public', async () => {
  feeds({ 'PR Newswire': [{ title: 'Oklo Signs Fuel Agreement', desc: 'Oklo Inc. (NYSE: OKLO)', link: 'https://www.prnewswire.com/news-releases/oklo-1.html' }] }, u => {
    if (u.pathname.endsWith('/company-news')) return new Response(JSON.stringify([{ id: 7, datetime: now - 3600, headline: 'Oklo stock rises', summary: '', source: 'Benzinga', url: 'https://www.benzinga.com/oklo', related: 'OKLO' }]), { status: 200 });
    if (u.pathname.endsWith('/stock/profile2')) return new Response(JSON.stringify({ name: 'Oklo Inc', ticker: 'OKLO' }), { status: 200 });
    throw new Error('unexpected ' + u);
  });
  const day = off => new Date(Date.now() + off * 86400000).toISOString().slice(0, 10);
  const r = await handleMarketRequest(new Request(`http://localhost/api/finnhub?path=/company-news&symbol=OKLO&from=${day(-5)}&to=${day(1)}`), { apiKey: 'k', log: () => {} });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(await r.text()).map(x => x.source), ['PR Newswire', 'Benzinga']);
  assert.equal(publicRequest('marketNewsUS', {}), true);
  const m = await handleMarketRequest(new Request('http://localhost/api/finnhub?path=/us-news&names=' + encodeURIComponent('OKLO:Oklo Inc')), { log: () => {} });
  assert.equal(m.status, 200);
  assert.equal(JSON.parse(await m.text())[0].related, 'OKLO');
  const bad = await handleMarketRequest(new Request('http://localhost/api/finnhub?path=/us-news&names=' + encodeURIComponent('OKLO:<script>')), { log: () => {} });
  assert.equal(bad.status, 400);
});
