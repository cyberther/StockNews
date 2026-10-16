import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanSummary, dedupeQueue, dropFiller, fixRomanian, httpGet, isPublicAddress, looksWrong, trimSentences, usable } from '../tools/summarize-batch.mjs';

test('the real Tesla summary loses its English "close"', () => {
  assert.equal(fixRomanian('Tesla (TSLA) s-a încheiat la 378,03$, cu o scădere de 1,22% față de ultimul close.'),
    'Tesla (TSLA) s-a încheiat la 378,03$, cu o scădere de 1,22% față de închiderea anterioară.');
});

test('common finance anglicisms become grammatical Romanian', () => {
  const cases = [
    ['Acțiunile au scăzut la close.', 'Acțiunile au scăzut la închidere.'],
    ['Piața a avut un rally puternic.', 'Piața a avut un avans puternic.'],
    ['Sell-off-ul a continuat, după un sell-off similar ieri.', 'Valul de vânzări a continuat, după un val de vânzări similar ieri.'],
    ['Investitorii așteaptă raportul de earnings și noul guidance.', 'Investitorii așteaptă raportul de rezultate și noua prognoză.'],
    ['Analiștii au ridicat price target-ul la 250$.', 'Analiștii au ridicat prețul-țintă la 250$.'],
    ['Compania a anunțat un buyback de 5 miliarde.', 'Compania a anunțat un program de răscumpărare de 5 miliarde.'],
    ['Volumul de trading a crescut; sentimentul e bullish.', 'Volumul de tranzacționare a crescut; sentimentul e optimist.'],
    ['Rally-ul a continuat, iar market cap-ul a depășit 4.000 de miliarde.', 'Avansul a continuat, iar valoarea de piață a depășit 4.000 de miliarde.']
  ];
  for (const [input, want] of cases) assert.equal(fixRomanian(input), want);
});

test('the real NVDA summaries come out in plain Romanian', () => {
  const cases = [
    ['În premergerea rapoartelor trimestriale, futures-urile Nasdaq au scăzut cu 0,6%.',
      'Înaintea rapoartelor trimestriale, contractele futures Nasdaq au scăzut cu 0,6%.'],
    ['Navitas a crescut după lansarea unui board de alimentare cu putere de 24 kW.',
      'Navitas a crescut după lansarea unei plăci de alimentare cu putere de 24 kW.'],
    ['Investitorii retail pe Stocktwits rămân optimist, iar analiștii sunt bearish.',
      'Investitorii retail pe Stocktwits rămân optimiști, iar analiștii sunt pesimiști.'],
    ['Futures-urile au scăzut în premergerea deschiderii.', 'Contractele futures au scăzut înaintea deschiderii.']
  ];
  for (const [input, want] of cases) assert.equal(fixRomanian(input), want);
  // The model's non-breaking hyphen ("data‑centerelor") is normalised first.
  assert.equal(cleanSummary('Nvidia a pierdut cota de piață a cipurilor AI ale data\u2011centerelor din China.', 'ro'),
    'Nvidia a pierdut cota de piață a cipurilor AI ale centrelor de date din China.');
});

test('gender and spelling slips from the real ASTS and TSLA summaries', () => {
  const cases = [
    ['Compania a raportat un pierdere netă de 342 de milioane, rezultând un marjă negativă de 482%.',
      'Compania a raportat o pierdere netă de 342 de milioane, rezultând o marjă negativă de 482%.'],
    ['Tesla acționările au scăzut cu aproximativ 13%, iar un lună mai târziu au revenit.',
      'Acțiunile Tesla au scăzut cu aproximativ 13%, iar o lună mai târziu au revenit.'],
    ['Acțiunile au crescut cu 4,72%, superând sectorul; estimările analistilor prevăd un profit.',
      'Acțiunile au crescut cu 4,72%, depășind sectorul; estimările analiștilor prevăd un profit.']
  ];
  for (const [input, want] of cases) assert.equal(fixRomanian(input), want);
});

test('long summaries are cut after the last whole sentence', () => {
  const s = 'Prima propoziție are 1.500% creștere și aprox. 13 unități. ' + 'A doua propoziție e ceva mai lungă. '.repeat(30);
  const out = trimSentences(s, 120);
  assert.ok(out.length <= 120, out);
  assert.ok(out.endsWith('.'), out);
  assert.ok(out.startsWith('Prima propoziție are 1.500% creștere și aprox. 13 unități.'), out);
  assert.equal(trimSentences('Scurt.', 650), 'Scurt.');
});

test('names and words that only contain the terms are left alone', () => {
  const keep = [
    'Close Brothers și Rally Health au raportat rezultate.',        // capitalised names
    'Prețul s-a apropiat de închidere, iar enclosed nu se schimbă.', // Romanian word, longer English word
    'Raportul closely-held al companiei.',
    'Indicele Earnings Yield a urcat.'
  ];
  for (const s of keep) assert.equal(fixRomanian(s), s);
});

test('cleanSummary fixes diacritics and anglicisms for Romanian only', () => {
  assert.equal(cleanSummary('Rezumat: „Acţiunile au scăzut faţă de ultimul close.”', 'ro'), 'Acțiunile au scăzut față de închiderea anterioară.');
  assert.equal(cleanSummary('Shares fell at the close.', 'en'), 'Shares fell at the close.');
});

test('tool-call and JSON replies are not usable', () => {
  assert.equal(usable('{"name": "summarize", "parameters": {"text": "x"}}'), false);
  assert.equal(usable('Apple și-a crescut cota de piață la 22% în trimestrul al treilea.'), true);
});

import { robotsAllow, extractArticleText, isPaywall } from '../tools/summarize-batch.mjs';

test('robots.txt: the "*" group applies, the longest rule wins, Allow wins a tie', () => {
  const txt = 'User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /private/\nAllow: /private/press/\nDisallow: /*.pdf$\n';
  assert.equal(robotsAllow(txt, '/news/story-1'), true);
  assert.equal(robotsAllow(txt, '/private/notes'), false);
  assert.equal(robotsAllow(txt, '/private/press/release'), true);
  assert.equal(robotsAllow(txt, '/files/report.pdf'), false);
  assert.equal(robotsAllow('', '/anything'), true);
  assert.equal(robotsAllow('User-agent: *\nDisallow:\n', '/x'), true);
  assert.equal(robotsAllow('User-agent: MarketPulseSummarizer\nDisallow: /\nUser-agent: *\nAllow: /\n', '/x'), false);
});

test('article text: JSON-LD articleBody first, then <article> paragraphs, then an article-body block', () => {
  const body = 'Compania a raportat un profit de 120 de milioane de lei în trimestrul al treilea, în creștere cu 15%. '.repeat(6);
  const ld = `<script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', articleBody: body })}</script>`;
  assert.ok(extractArticleText(`<html>${ld}<p>other</p></html>`).startsWith('Compania a raportat'));
  const paras = '<article><p>Advertisement</p>' + `<p>${body}</p>`.repeat(2) + '</article><p>Cookie policy text that is long enough to count as a paragraph here.</p>';
  const t = extractArticleText(paras);
  assert.ok(t.length > 400 && !/Advertisement|Cookie/.test(t));
  const div = `<div class="article-body"><script>var x=1</script><span>${body}</span></div>`;
  assert.ok(extractArticleText(div).startsWith('Compania a raportat'));
  assert.equal(extractArticleText('<p>short</p>'), '');
  assert.ok(extractArticleText(`<article><p>${body.repeat(20)}</p></article>`).length <= 3500);
});

test('a subscription wall is not taken for the article', () => {
  assert.equal(isPaywall('Poți să accesezi acest articol doar dacă ești abonat ZFCorporate.ro - platforma completă de informații.'), true);
  assert.equal(isPaywall('Subscribe to read the full story. Already a subscriber? Sign in.'), true);
  assert.equal(isPaywall('Nvidia a livrat 678.000 de cipuri în China în primul semestru, cu 44% mai puține decât anul trecut.'), false);
});

test('a Romanian summary in English, or repeating the headline, is retried', () => {
  const story = { headline: 'Tesla (TSLA) Declines More Than Market: Some Information for Investors' };
  assert.equal(looksWrong('Tesla shares fell 1.2% and the stock is down for the week, with analysts said to be cautious.', story, 'ro'), 'English words');
  assert.equal(looksWrong('Tesla (TSLA) declines more than market: some information for investors, potrivit sursei.', story, 'ro'), 'repeats the headline');
  assert.equal(looksWrong('Acțiunile Tesla au scăzut cu 1,22%, la 378,03 dolari, mai mult decât indicele S&P 500.', story, 'ro'), '');
  assert.equal(looksWrong('Tesla shares fell 1.2% and the stock is down for the week, with analysts said to be cautious.', story, 'en'), '');
});

test('currency written twice and spaced numbers from the real NVDA and ASTS summaries', () => {
  assert.equal(fixRomanian('Compania e evaluată la circa $6,2 trilioni de dolari.'), 'Compania e evaluată la circa 6,2 trilioane de dolari.');
  assert.equal(fixRomanian('Venituri în creștere de aproximativ 1 500 %, marja negativă fiind de 482 %.'),
    'Venituri în creștere de aproximativ 1.500%, marja negativă fiind de 482%.');
  assert.equal(fixRomanian('Lucid a livrat 3 806 vehicule în 2026, între 7 000 și 8 000 de unități.'), 'Lucid a livrat 3.806 vehicule în 2026, între 7.000 și 8.000 de unități.');
  assert.equal(fixRomanian('În 2026 120 de magazine, din 2025 până în 2026.'), 'În 2026 120 de magazine, din 2025 până în 2026.');
  assert.equal(fixRomanian('Tesla dispune de un rețea extinsă și un companie nouă.'), 'Tesla dispune de o rețea extinsă și o companie nouă.');
});

test('a closing comment of the model\'s own is dropped, facts are kept', () => {
  const facts = 'Piper Sandler a redus ratingul AST SpaceMobile de la Overweight la Neutral și ținta de la 98$ la 54$. Acțiunile au închis la 51,46$ luni.';
  assert.equal(dropFiller(facts + ' Această schimbare reflectă o reevaluare a perspectivelor financiare ale firmei.'), facts);
  assert.equal(dropFiller(facts + ' Acest pas reflectă o perspectivă mai precaută.'), facts);
  assert.equal(dropFiller(facts + ' Decizia poate influența deciziile investitorilor privind titlul.'), facts);
  assert.equal(dropFiller(facts), facts);
  assert.equal(dropFiller(facts + ' Aceste cifre arată că veniturile au crescut cu 20%.'), facts + ' Aceste cifre arată că veniturile au crescut cu 20%.');
  assert.equal(dropFiller('Această schimbare reflectă cererea mai slabă.'), 'Această schimbare reflectă cererea mai slabă.');
  assert.equal(cleanSummary(facts + ' Aceste cifre arată o poziție solidă.', 'ro'), facts);
});

test('article links may not reach this PC or its network', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.20.0.5', '169.254.169.254', '100.64.1.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::5', '::ffff:192.168.1.1'])
    assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ['8.8.8.8', '104.16.0.1', '2606:4700::1111']) assert.equal(isPublicAddress(ip), true, ip);
  await assert.rejects(httpGet('http://127.0.0.1/'), /blocked address/);
  await assert.rejects(httpGet('http://192.168.1.1/admin'), /blocked address/);
  await assert.rejects(httpGet('http://127.0.0.1:1234/v1/models'), /port 1234/);
  await assert.rejects(httpGet('http://localhost/'), /blocked address/);
  await assert.rejects(httpGet('file:///etc/passwd'), /not http/);
});

test('replies about what the article lacks are rejected (real VRT and OKLO replies)', () => {
  const story = { headline: 'Some headline' };
  assert.equal(looksWrong('Firefly Aerospace a raportat venituri de 30 de milioane de dolari. Articolul compară cele două companii și nu menționează compania VRT.', story, 'ro'), 'says what the story lacks');
  assert.equal(looksWrong('Nu există informații relevante în articol despre compania analizată.', story, 'ro'), 'says what the story lacks');
  // A fact about the company that happens to use "nu oferă" is a summary.
  assert.equal(looksWrong('Acțiunile Tesla au crescut cu 3%, iar compania nu oferă o prognoză nouă pentru livrări.', story, 'ro'), '');
});

test('an English closing sentence and "demovat" are cleaned from the real ASTS summary', () => {
  assert.equal(cleanSummary('Piper Sandler a demovat AST SpaceMobile de la Overweight la Neutral, cu o țintă de 54 de dolari. No other figures given.'),
    'Piper Sandler a retrogradat AST SpaceMobile de la Overweight la Neutral, cu o țintă de 54 de dolari.');
});

test('a closing sentence about what the article lacks is dropped (real ASTS summary)', () => {
  assert.equal(cleanSummary('Piper Sandler a retrogradat compania AST SpaceMobile (NASDAQ:ASTS) din Overweight în Neutral și a redus ținta de preț de la 98 la 54 dolari. Acțiunile AST SpaceMobile au închis la 51,46 dolari luni. Nicio altă informație financiară nu a fost furnizată în articol.'),
    'Piper Sandler a retrogradat compania AST SpaceMobile (NASDAQ:ASTS) din Overweight în Neutral și a redus ținta de preț de la 98 la 54 dolari. Acțiunile AST SpaceMobile au închis la 51,46 dolari luni.');
  // A fact that uses a negation stays.
  assert.equal(cleanSummary('Tesla a livrat 400.000 de vehicule. Compania nu a oferit o prognoză pentru 2026.'),
    'Tesla a livrat 400.000 de vehicule. Compania nu a oferit o prognoză pentru 2026.');
});

test('a closing "Concluzia ... este că" comment is dropped (real TSLA summary)', () => {
  assert.equal(dropFiller('Musk a acumulat 696 de miliarde de dolari. Concluzia prezentată este că contribuțiile politice ale lui Musk ar putea influența reputația companiei.'),
    'Musk a acumulat 696 de miliarde de dolari.');
});

test('German summaries: closing comments and "the article lacks" are handled too', () => {
  assert.equal(cleanSummary('BMW verlagert die Produktion nach Ungarn. Der Konzern spart dadurch 1 Mrd. Euro. Weitere Angaben wurden nicht genannt.', 'de'),
    'BMW verlagert die Produktion nach Ungarn. Der Konzern spart dadurch 1 Mrd. Euro.');
  assert.equal(cleanSummary('Siemens hat den Umsatz um 5% gesteigert. Dies unterstreicht die starke Position des Konzerns.', 'de'),
    'Siemens hat den Umsatz um 5% gesteigert.');
  assert.equal(looksWrong('Der Artikel behandelt den Markt für Kältemaschinen und erwähnt Vertiv nicht.', { headline: 'x' }, 'de'), 'says what the story lacks');
  assert.equal(looksWrong('Siemens hat den Umsatz im dritten Quartal um 5% auf 20 Mrd. Euro gesteigert.', { headline: 'x' }, 'de'), '');
});

test('a page marked as paid content is not read, however the flag is written (real Handelsblatt page)', async () => {
  const { isPaidPage } = await import('../tools/summarize-batch.mjs');
  assert.equal(isPaidPage('<script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":"False","articleBody":"…"}</script>'), true);
  assert.equal(isPaidPage('<script type="application/ld+json">{"isAccessibleForFree": false}</script>'), true);
  assert.equal(isPaidPage('<meta property="article:content_tier" content="locked">'), true);
  assert.equal(isPaidPage('<script type="application/ld+json">{"isAccessibleForFree":true}</script>'), false);
  assert.equal(isPaidPage('<meta property="article:content_tier" content="free">'), false);
});

test('an article filed under several tickers is written once per language', () => {
  const q = [['AAPL:142903568', 'ro'], ['NVDA:142903568', 'ro'], ['AAPL:142903568', 'de'], ['NVDA:142903568', 'de'], ['MSFT:1', 'ro']]
    .map(([id, lang]) => ({ story: { id }, lang }));
  assert.deepEqual(dedupeQueue(q).map(x => x.story.id + '|' + x.lang), ['AAPL:142903568|ro', 'AAPL:142903568|de', 'MSFT:1|ro']);
});

import { digestLooksWrong, digestKey, digestsToWrite } from '../tools/summarize-batch.mjs';

test('a day of two or three stories about one event may have a one-bullet digest', () => {
  const one = '• Commerzbank a anunțat răscumpărarea de acțiuni de 1 miliard de euro, aprobată de BCE.';
  assert.equal(digestLooksWrong(one, 'ro', 2), '');
  assert.equal(digestLooksWrong(one, 'ro', 3), '');
  assert.equal(digestLooksWrong(one, 'ro', 4), 'too few bullets');
  assert.equal(digestLooksWrong('', 'ro', 1), 'too few bullets');
});

test('a digest the model got wrong is passed over, and the ones behind it get their turn', () => {
  const rows = ['CBK.DE', 'ITV.L', 'TEL.RO', 'SNP.RO', 'BMW.DE'].map(ticker => ({ ticker, day: '2026-10-15', stories: [{}, {}] }));
  const rejected = { [digestKey(rows[0], 'ro')]: 1, [digestKey(rows[1], 'ro')]: 1, [digestKey(rows[2], 'ro')]: 1 };
  assert.deepEqual(digestsToWrite(rows, 'ro', rejected, 3).map(r => r.ticker), ['SNP.RO', 'BMW.DE']);
  // Another language, or the same day with more stories, is tried again.
  assert.equal(digestsToWrite(rows, 'de', rejected, 3).length, 3);
  const more = Object.assign({}, rows[0], { stories: [{}, {}, {}] });
  assert.deepEqual(digestsToWrite([more], 'ro', rejected, 3).map(r => r.ticker), ['CBK.DE']);
});
