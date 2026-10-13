import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanSummary, fixRomanian, looksWrong, trimSentences, usable } from '../tools/summarize-batch.mjs';

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
