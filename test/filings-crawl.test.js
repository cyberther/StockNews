import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyKind, classifyPress, datesIn, publishedDay, linksIn, linkTitle, isEnglishCopy, offLimits, looksLikeFiling, stripSiteName } from '../tools/filings-lib.mjs';
import { checkFigures, parseJson } from '../tools/filings-extract.mjs';

test('filings are sorted by kind; forms and governance texts are not filings', () => {
  assert.equal(classifyKind('Notificare tranzacții persoane cu responsabilități de conducere - art. 19 MAR'), 'insider');
  assert.equal(classifyKind('Tranzactii Management'), 'insider');
  assert.equal(classifyKind('Notificare privind depășirea pragului de deținere de 5%'), 'holding');
  assert.equal(classifyKind('Comunicat plata dividende an financiar 2025'), 'dividend');
  assert.equal(classifyKind('Convocator AGOA 29 octombrie 2026'), 'agm');
  assert.equal(classifyKind('AGA din 16 noiembrie 2026'), 'agm');
  assert.equal(classifyKind('Doctor Aga Roxana'), null);
  assert.equal(classifyKind('Rezultate financiare S1 2026'), 'results');
  assert.equal(classifyKind('OMV Petrom Trading Update T3 2026'), 'results');
  assert.equal(classifyKind('Raport curent – Modificare calendar financiar 2026'), 'report');
  assert.equal(classifyKind('Formular de vot prin corespondență AGOA'), null);
  assert.equal(classifyKind('Împuternicire specială'), null);
  assert.equal(classifyKind('Model of Special Power-of-Attorney Extraordinary General Meeting'), null);
  assert.equal(classifyKind('Declaratie de avere 2025'), null);
  // A document whose link says only "Document": its file name decides.
  assert.equal(classifyKind('Document', 'https://x.ro/files/Raport%20curent%20-%20Hotarare%20AGOA%2023.09.2026.pdf'), 'agm');
  assert.equal(classifyKind('Despre noi', 'https://x.ro/despre-noi'), null);
  assert.ok(looksLikeFiling('https://x.ro/raport-curent-hotarare-agoa-23092026'));
  assert.equal(classifyPress('Directorul general al Bittnet a cumpărat acțiuni de 200.000 lei'), 'insider');
  assert.equal(classifyPress('Acțiunile Petrom cresc după rezultate'), null);
});

test('the day a filing was published', () => {
  assert.deepEqual(datesIn('Raport curent 09.10.2026 privind AGA din 6 noiembrie 2026'), ['2026-10-09', '2026-11-06']);
  assert.deepEqual(datesIn('RC_20261012_ELSA.pdf'), ['2026-10-12']);
  assert.deepEqual(datesIn('October 9, 2026 and 2026-02-30'), ['2026-10-09']);
  // The meeting's own date is in the future: the publication day comes from elsewhere.
  assert.equal(publishedDay('Convocare AGA 6 noiembrie 2026', 'https://x.ro/2026/09/22/convocare.pdf', '2026-10-15'), '2026-09-22');
  // A report on 2019, uploaded in March 2021: the upload month, not the period.
  assert.equal(publishedDay('Situatii financiare la 31.12.2019', 'https://x.ro/wp-content/uploads/2021/03/sf.pdf', '2026-10-15'), '2021-03-01');
  assert.equal(publishedDay('fără dată', 'https://x.ro/doc.pdf'), null);
});

test('links on an investor page: titles, English copies, bvb.ro', () => {
  const html = `<table><tr><td>09.10.2026</td><td><a href="/files/RC%20AGA.pdf">Descarcă</a></td></tr>
    <tr><td>Raport curent privind rezultatele T3 2026</td><td><a href="/files/T3_RO.pdf">PDF</a> <a href="/files/T3_EN.pdf">EN</a></td></tr></table>
    <a href="https://bvb.ro/x">BVB</a><a href="mailto:a@b.ro">mail</a>`;
  const ls = linksIn(html, 'https://www.x.ro/investitori/');
  assert.deepEqual(ls.map(l => l.url), ['https://www.x.ro/files/RC%20AGA.pdf', 'https://www.x.ro/files/T3_RO.pdf', 'https://www.x.ro/files/T3_EN.pdf', 'https://bvb.ro/x']);
  assert.equal(linkTitle(ls[0]), 'RC AGA');
  assert.equal(linkTitle(ls[1]), 'Raport curent privind rezultatele T3 2026');
  assert.ok(isEnglishCopy(ls[2].url, ls[2].text));
  assert.ok(!isEnglishCopy(ls[1].url, ls[1].text));
  assert.ok(offLimits('https://www.bvb.ro/infocont/x.pdf'));
  assert.ok(!offLimits('https://www.omvpetrom.com/x.pdf'));
  assert.equal(stripSiteName('AGA din 16 noiembrie 2026 | MedLife'), 'AGA din 16 noiembrie 2026');
});

test('figures from the model are checked before they are kept', () => {
  assert.equal(checkFigures('insider', { transactions: [{ date: '2026-10-08', person: 'Ion Popescu', role: 'CEO', type: 'buy', shares: 1000, price: 1.2, currency: 'RON', value: 1200 }] }), '');
  assert.equal(checkFigures('insider', { transactions: [] }), 'no transaction');
  assert.equal(checkFigures('results', { period: 'T3 2026', period_end: '2026-09-30', consolidated: true, currency: 'RON', revenue: 9876.5, revenue_prev: 9000, net_profit: 1234, net_profit_prev: 1100, ebitda: null, eps: 0.02 }), '');
  assert.equal(checkFigures('results', { period: 'T3', period_end: null, consolidated: null, currency: 'RON', revenue: 9876543210, revenue_prev: null, net_profit: null, net_profit_prev: null, ebitda: null, eps: null }), 'not in millions');
  assert.equal(checkFigures('dividend', { fiscal_year: 2025, gross_dps: 0.0485, currency: 'RON', status: 'approved', record_date: '2026-05-20', ex_date: '2026-05-19', payment_date: '2026-06-10' }), '');
  assert.equal(checkFigures('dividend', { fiscal_year: 2025, gross_dps: null, currency: null, status: 'approved', record_date: null, ex_date: null, payment_date: null }), 'no dividend');
  assert.equal(checkFigures('holding', { holder: 'NN Group', before_pct: 4.9, after_pct: 5.1, date: '2026-05-20' }), '');
  assert.equal(checkFigures('holding', { holder: 'NN Group', before_pct: 4.9, after_pct: 150, date: null }), 'bad values');
  assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
});
