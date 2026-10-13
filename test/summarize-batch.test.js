import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanSummary, fixRomanian, usable } from '../tools/summarize-batch.mjs';

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
