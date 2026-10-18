// Deterministic classification of a policy event's text (no AI): sectors from keyword rules
// (config/policy-taxonomy.json), their CAEN divisions and BVB companies, companies named in the
// text, and the figures it states. Every company link says why: 'mentioned' or 'sector'.
import { BVB_SHARES, BVB_ALIASES } from '../../netlify/functions/_shared/market/bvb-symbols.js';

export const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[şș]/g, 's').replace(/[ţț]/g, 't').toLowerCase();
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Names a company is recognised by: the curated aliases, and catalog names of two words or
// more (single common words such as "Nord" or "Unirea" are not enough on their own).
export function bvbCatalog() {
  return BVB_SHARES.map(([ticker, name]) => {
    const names = new Set((BVB_ALIASES[ticker] || []).filter(a => a.length >= 4));
    const clean = String(name).replace(/\b(S\.?A\.?|SA|Bucuresti|Romania)\b/gi, '').replace(/\s+/g, ' ').trim();
    if (clean.split(' ').length >= 2) names.add(clean);
    return { ticker, names: [...names] };
  }).filter(c => c.names.length);
}

const matchers = new WeakMap();
function compile(taxonomy, catalog) {
  let m = matchers.get(taxonomy);
  if (m && m.catalog === catalog) return m;
  m = {
    catalog,
    sectors: Object.entries(taxonomy.sectors).map(([id, s]) => [id, new RegExp('(^|[^a-z0-9])(' + s.keywords.map(k => esc(fold(k))).join('|') + ')', 'i')]),
    companies: catalog.map(c => [c.ticker, new RegExp('(^|[^a-z0-9])(' + c.names.map(n => esc(fold(n))).join('|') + ')($|[^a-z0-9])', 'i')])
  };
  matchers.set(taxonomy, m);
  return m;
}

const NUM = '(\\d+(?:[.,]\\d+)?)';
const FIGURES = new RegExp([
  `${NUM}\\s*%\\s*din\\s+PIB`,
  `${NUM}\\s*puncte\\s+procentuale`,
  `${NUM}\\s*(mld\\.?|miliarde|miliard|mil\\.?|milioane|milion)\\s*(lei|ron|euro|eur)\\b`,
  `${NUM}\\s*%`
].map(p => `(?:${p})`).join('|'), 'gi');
const num = s => Number(String(s).replace(',', '.'));

export function figures(text) {
  const out = [];
  for (const m of String(text || '').matchAll(FIGURES)) {
    if (m[1] != null) out.push({ kind: 'percent', value: num(m[1]), unit: '% din PIB', text: m[0] });
    else if (m[2] != null) out.push({ kind: 'pp', value: num(m[2]), unit: 'pp', text: m[0] });
    else if (m[3] != null) {
      const scale = /^mld|^miliard/i.test(m[4]) ? 1e9 : 1e6;
      out.push({ kind: 'amount', value: Math.round(num(m[3]) * scale), unit: /^(lei|ron)$/i.test(m[5]) ? 'RON' : 'EUR', text: m[0] });
    } else out.push({ kind: 'percent', value: num(m[6]), unit: '%', text: m[0] });
  }
  return out;
}

export function classify(text, taxonomy, catalog) {
  const t = fold(text), m = compile(taxonomy, catalog);
  const sectors = m.sectors.filter(([, re]) => re.test(t)).map(([id]) => id).sort();
  const caen = [...new Set(sectors.flatMap(id => taxonomy.sectors[id].caen))].sort();
  const companies = m.companies.filter(([, re]) => re.test(t)).map(([ticker]) => ({ ticker, why: 'mentioned' }));
  for (const id of sectors) for (const ticker of taxonomy.sectors[id].tickers)
    if (!companies.some(c => c.ticker === ticker)) companies.push({ ticker, why: 'sector', sector: id });
  return { sectors, caen, companies, figures: figures(text) };
}
