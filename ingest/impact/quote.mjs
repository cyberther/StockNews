// Romanian figures and quotes, for the automatic analyses (ingest/impact/auto-validate.mjs): a
// fact may only carry a number its quote writes, and its quote must be in the stored document
// text. Romanian writing: "." groups thousands, "," marks decimals; "mii", "mil.", "milioane",
// "mld.", "miliarde" scale the number before them.
import { fold } from '../policy/classify.mjs';

// Lower case, no diacritics (ş/ș, ţ/ț alike), dashes as "-", one space between words.
export function normText(s) {
  return fold(String(s || '')).replace(/[‐-―−]/g, '-').replace(/[ \s]+/g, ' ').trim();
}

const SCALE = [[/^(?:mld|miliard(?:e|ul)?)\b/, 1e9], [/^(?:mil|milioane|milion(?:ul)?)\b/, 1e6], [/^mii\b/, 1e3]];
const NUMBER = /\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:,\d+)?/g;

export function numbersIn(s) {
  const t = normText(s), out = [];
  for (const m of t.matchAll(NUMBER)) {
    let v = Number(m[0].replace(/\./g, '').replace(',', '.'));
    if (!Number.isFinite(v)) continue;
    const after = t.slice(m.index + m[0].length).replace(/^\s+/, '');
    const sc = SCALE.find(([re]) => re.test(after));
    if (sc) v = Math.round(v * sc[1] * 1e6) / 1e6;
    out.push(v);
  }
  return out;
}

// The value is written in the quote (after scaling), exactly.
export const valueInQuote = (value, quote) => typeof value === 'number' && Number.isFinite(value) && numbersIn(quote).some(n => n === value);

// The quote is in the document, word for word once both are normalised; a quote under 20
// characters proves nothing and is refused.
export function quoteFound(docText, quote) {
  const q = normText(quote).replace(/[.;,:]+$/, '');
  return q.length >= 20 && normText(docText).includes(q);
}
