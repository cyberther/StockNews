// Romanian figures and quotes (ingest/impact/quote.mjs): an automatic analysis may only use a
// number that is written in its quote, and a quote that is in the stored document.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normText, numbersIn, quoteFound, valueInQuote } from '../ingest/impact/quote.mjs';

test('Romanian number formats, with thousands, millions and billions', () => {
  assert.deepEqual(numbersIn('1.234,5 lei'), [1234.5]);
  assert.deepEqual(numbersIn('2,5 mld. lei'), [2500000000]);
  assert.deepEqual(numbersIn('3,2 miliarde lei'), [3200000000]);
  assert.deepEqual(numbersIn('120 mil. lei'), [120000000]);
  assert.deepEqual(numbersIn('45 milioane euro'), [45000000]);
  assert.deepEqual(numbersIn('500 mii lei'), [500000]);
  assert.deepEqual(numbersIn('1.234 lei'), [1234]);
  assert.deepEqual(numbersIn('cota de 9%'), [9]);
  const n = numbersIn('701,07 lei/1.000 litri');
  assert.ok(n.includes(701.07) && n.includes(1000));
  assert.deepEqual(numbersIn('anul 2026, art. 3'), [2026, 3]);
});

test('a value counts only if the quote writes it', () => {
  assert.equal(valueInQuote(1234, 'cota de 1,234%'), false);
  assert.equal(valueInQuote(1.234, 'cota de 1,234%'), true);
  assert.equal(valueInQuote(2500000000, 'un cost de 2,5 mld. lei'), true);
  assert.equal(valueInQuote(2500000, 'un cost de 2,5 mld. lei'), false);
  assert.equal(valueInQuote(9, 'TVA de 9%'), true);
});

test('a quote is found despite diacritics, cedillas and line breaks, not with a changed figure', () => {
  const doc = 'Art. 2. — Impactul\n asupra bugetului de stat este de 1.250,5 mil. lei în anul 2026, conform fişei financiare.';
  assert.equal(quoteFound(doc, 'Impactul asupra bugetului de stat este de 1.250,5 mil. lei în anul 2026, conform fișei financiare'), true);
  assert.equal(quoteFound(doc, 'impactul asupra bugetului de stat este de 1.250,5 mil. lei'), true);
  assert.equal(quoteFound(doc, 'Impactul asupra bugetului de stat este de 1.350,5 mil. lei'), false);
  assert.equal(quoteFound(doc, 'este'), false, 'too short to prove anything');
  assert.equal(normText('Fişă – ţară nouă'), 'fisa - tara noua');
});
