// The gate of the automatic analyses (docs/plans/2026-10-19-politici-automat-design.md): the
// local model proposes, this decides. A proposal becomes an analysis only when every fact's
// quote is in the stored document and writes its value, every assumption comes from the
// library (config/impact-assumptions.json) inside its range, every company has audited
// figures, the measure is a type the engine models, and the engine runs. Otherwise the
// document gets a fact sheet with the reasons. Nothing is repaired or guessed here.
import { quoteFound, valueInQuote, normText } from './quote.mjs';
import { validateAnalysis } from './schema.mjs';
import '../../templates/shared/hif-scenario.js';
import '../../templates/shared/hif-impact.js';

const I = globalThis.HIFImpact;

// The facts each type needs, by role. A budget programme's cost is its amount. Public contracts
// come from SEAP rows (ingest/state/seap.mjs), never from a proposal.
export const MEASURE_TYPES = {
  tax_rate_change: { required: ['rate_new', 'base', 'start', 'budget_cost'], cost: 'budget_cost' },
  budget_program: { required: ['amount', 'start'], cost: 'amount' },
  price_cap: { required: ['cap', 'target', 'start', 'budget_cost'], cost: 'budget_cost' },
  contract_award: { required: [], cost: null, fromData: true }
};

const KEY = /^[a-z][a-z0-9_]{0,37}$/; // "f_" is added in the analysis (schema allows 41)
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ['ianuarie', 'februarie', 'martie', 'aprilie', 'mai', 'iunie', 'iulie', 'august', 'septembrie', 'octombrie', 'noiembrie', 'decembrie'];
const ADVICE = /\b(cumpar\w*|vinde\w*|vinzi|vand\w*|vanzar\w*|recomand\w*|tinta de pret|pret tinta|buy(?:ing)?|sell(?:ing)?|recommend\w*|price target|kaufen|verkaufen|empfehl\w*|kursziel)\b/;

// A date is in the quote as 15.10.2026, 15/10/2026 or "15 octombrie 2026".
function dateInQuote(value, quote) {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number), q = normText(quote);
  const forms = [`${d}.${m}.${y}`, `${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.${y}`, `${d}/${m}/${y}`,
    `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`, `${d} ${MONTHS[m - 1]} ${y}`];
  return forms.some(f => q.includes(f));
}
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 55);
const reason = (code, detail) => ({ code, detail: String(detail || '').slice(0, 300) });

export function validateProposal(p, ctx) {
  const reasons = [];
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { ok: false, reasons: [reason('no_figures', 'the proposal is not an object')] };
  const type = MEASURE_TYPES[p.measure_type];
  if (!type || type.fromData) return { ok: false, reasons: [reason('type_not_modelled', String(p.measure_type || 'none'))] };
  if ([p.title, p.summary].some(t => typeof t === 'string' && ADVICE.test(normText(t)))) reasons.push(reason('advice_language', 'title or summary'));

  // Facts: each quoted from the document, writing its value.
  const facts = Array.isArray(p.facts) ? p.facts : [];
  if (!Array.isArray(p.facts)) reasons.push(reason('no_figures', 'facts must be a list'));
  const byRole = new Map(), keys = new Set();
  for (const f of facts) {
    if (!f || typeof f !== 'object' || !KEY.test(f.key || '') || keys.has(f.key) || typeof f.text !== 'string' || !f.text.trim()) { reasons.push(reason('no_figures', 'a fact is malformed')); continue; }
    keys.add(f.key);
    if (typeof f.quote !== 'string' || !quoteFound(ctx.docText, f.quote)) { reasons.push(reason('quote_not_found', f.key)); continue; }
    const v = f.value;
    const okValue = v == null ? true : f.unit === 'date' ? dateInQuote(v, f.quote) : valueInQuote(v, f.quote);
    if (!okValue) { reasons.push(reason('quote_not_found', f.key + ' = ' + v)); continue; }
    if (typeof f.role === 'string' && !byRole.has(f.role)) byRole.set(f.role, f);
  }
  const missing = type.required.filter(r => !byRole.has(r) || (r !== 'base' && r !== 'target' && byRole.get(r).value == null));
  if (missing.length && !reasons.some(r => r.code === 'quote_not_found')) reasons.push(reason('no_figures', 'missing: ' + missing.join(', ')));

  // Assumptions: the library only, in range, fitting this type.
  const lib = new Map((ctx.assumptions || []).map(a => [a.key, a]));
  const chosen = new Map();
  for (const s of Array.isArray(p.assumptions) ? p.assumptions : []) {
    const a = s && lib.get(s.key);
    if (!a || !a.applies_to.includes(p.measure_type)) { reasons.push(reason('missing_assumption', (s && s.key) + ' is not in the library for ' + p.measure_type)); continue; }
    if (!(typeof s.value === 'number' && s.value >= a.range[0] && s.value <= a.range[1])) { reasons.push(reason('missing_assumption', s.key + ' must be within ' + a.range[0] + '-' + a.range[1])); continue; }
    chosen.set(s.key, s.value);
  }
  const start = byRole.get('start'), year = start && typeof start.value === 'string' ? start.value.slice(0, 4) : null;
  const gdp = year && lib.get('gdp_' + year);
  if (year && !gdp) reasons.push(reason('missing_assumption', 'gdp_' + year + ' (no sourced GDP for ' + year + ')'));

  // Companies: audited figures, and the exposure and shock as facts of this document.
  const fin = new Set((ctx.financials || []).filter(f => f && f.verified === true).map(f => f.ticker));
  const companies = [];
  for (const c of Array.isArray(p.companies) ? p.companies : []) {
    if (!c || !ctx.tickers || !ctx.tickers.has(c.ticker) || !fin.has(c.ticker)) { reasons.push(reason('no_company_data', c && c.ticker)); continue; }
    const ex = facts.find(f => f && f.key === c.exposure_fact), sh = facts.find(f => f && f.key === c.shock_fact);
    if (!ex || !sh || typeof ex.value !== 'number' || typeof sh.value !== 'number') { reasons.push(reason('no_company_data', c.ticker + ': exposure and shock must be figures of this document')); continue; }
    companies.push(c);
  }
  if (reasons.length) return { ok: false, reasons };

  // The analysis, in the same shape as analyses/<id>/v<N>.json.
  const src = { source_url: ctx.docUrl, source_date: ctx.docDate };
  const cost = byRole.get(type.cost), end = byRole.get('end');
  const signed = p.budget && p.budget.direction === 'revenue' ? -cost.value : cost.value;
  const lit = (key, label, value, unit, why) => ({ key, label, value, unit, range: [value, value], why });
  const ro = d => d.split('-').reverse().join('.'), money = n => Math.abs(n).toLocaleString('ro-RO', { maximumFractionDigits: 2 });
  const scen = k => { const a = lib.get(k); return { key: k, label: a.label, value: chosen.has(k) ? chosen.get(k) : a.default, unit: a.unit, range: a.range, why: a.why }; };
  const assumptions = [
    lit('start', 'Intrare în vigoare', start.value, 'date', 'Data scrisă în document: ' + ro(start.value) + ' („' + start.quote.slice(0, 160) + '”).'),
    ...(end && typeof end.value === 'string' && end.value >= start.value ? [lit('end', 'Sfârșit', end.value, 'date', 'Data scrisă în document: ' + ro(end.value) + ' („' + end.quote.slice(0, 160) + '”).')] : []),
    lit('cost', 'Efect bugetar anual (lei)', signed, 'RON', 'Suma scrisă în document: ' + money(cost.value) + ' lei (' + (signed < 0 ? 'venit pentru buget' : 'cost pentru buget') + ', „' + cost.quote.slice(0, 160) + '”).'),
    { key: 'gdp', label: gdp.label, value: gdp.default, unit: gdp.unit, range: gdp.range, why: gdp.why + ' Sursa: ' + gdp.source_url },
    scen('partial_pct'), scen('delay_months'),
    ...companies.flatMap(c => [scen('mitigation_pct'), scen('contribution_pct')].map(a => ({ ...a, key: slug(c.ticker).replace(/-/g, '_') + '_' + a.key })))
  ].filter((a, i, all) => all.findIndex(b => b.key === a.key) === i);
  const analysis = {
    id: 'auto-' + slug(ctx.eventId), version: ctx.version || 1, origin: 'auto',
    published_at: ctx.now.toISOString().slice(0, 10), title: String(p.title || ctx.title || '').slice(0, 300),
    policy: 'auto-' + slug(ctx.eventId), events: [ctx.eventId], summary: typeof p.summary === 'string' ? p.summary.slice(0, 600) : '',
    facts: facts.map(f => ({ key: 'f_' + f.key, text: f.text.slice(0, 600), quote: f.quote, value: f.value ?? null, unit: f.unit ?? null, ...src })),
    budget: { approved: ['yes', 'no', 'unknown'].includes(ctx.approved) ? ctx.approved : 'unknown', approved_fact: null, funding_source: null, funding_fact: null,
      recurring: false, horizon_years: null, sustainability_note: end ? 'Măsură cu termen, până la ' + ro(end.value) + ', după document.' : 'Documentul nu spune dacă măsura e permanentă sau temporară.' },
    assumptions, sectors: (ctx.sectors || []).filter(s => ctx.taxonomy && ctx.taxonomy.sectors && ctx.taxonomy.sectors[s]),
    companies: companies.map(c => {
      const k = slug(c.ticker).replace(/-/g, '_');
      return { ticker: c.ticker, why: String(c.why || 'Numită în document.').slice(0, 300), exposure_pct: { ref: 'f_' + c.exposure_fact }, shock_pct: { ref: 'f_' + c.shock_fact },
        mitigation_pct: { ref: k + '_mitigation_pct' }, contribution_pct: { ref: k + '_contribution_pct' } };
    }),
    risks: []
  };
  const v = validateAnalysis(analysis, { taxonomy: ctx.taxonomy, tickers: ctx.tickers });
  if (!v.ok) return { ok: false, reasons: [reason('type_not_modelled', v.errors.join('; '))] };
  let run;
  try { run = I.run(analysis, ctx.financials || []); } catch (e) { return { ok: false, reasons: [reason('type_not_modelled', e.message)] }; }
  const results = [], add = (scenario, subject, res) => { const { formula, ...vals } = res; results.push({ engine_version: I.ENGINE_VERSION, scenario, subject, vals, formula }); };
  I.SCENARIOS.forEach(sc => {
    add(sc, 'budget', run.budget[sc]);
    Object.entries(run.companies).forEach(([t, c]) => { if (!c.missing) add(sc, t, { ...c[sc], fiscal_year: c.fiscal_year, source_url: c.source_url }); });
  });
  if (!results.every(r => Object.values(r.vals).every(x => x == null || typeof x !== 'number' || Number.isFinite(x)))) return { ok: false, reasons: [reason('type_not_modelled', 'the engine gave a non-finite result')] };
  return { ok: true, analysis, results };
}
