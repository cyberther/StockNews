// Financial statements, annual and quarterly, as the app shows them (supabase/financials.sql):
// [{ period: 'A' | 'Q', period_end: 'YYYY-MM-DD', label, currency, data: { revenue, ... } }].
//
// secRows(companyfacts) reads a US company's figures from the SEC's XBRL "company facts"
// (data.sec.gov/api/xbrl/companyfacts/CIK##########.json; US government data, no licence terms).
// Income and cash-flow figures are durations: a 10-Q gives the quarter for the income
// statement but the year so far for cash flows, and a 10-K gives the year. A quarter is taken
// as reported when there is one, otherwise as the difference of two "year so far" figures with
// the same start (the fourth quarter: the year less the first nine months). Balance-sheet
// figures are instants, taken at each period's end. Amounts stay in the filing's currency
// units (USD), earnings per share per share.

// The first concept that has a value for a period wins (companies use different tags, and
// change them over the years).
export const SEC_CONCEPTS = {
  revenue: ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'SalesRevenueNet', 'SalesRevenueGoodsNet'],
  gross_profit: ['GrossProfit'],
  operating_income: ['OperatingIncomeLoss'],
  net_income: ['NetIncomeLoss', 'ProfitLoss', 'NetIncomeLossAvailableToCommonStockholdersBasic'],
  eps: ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted', 'EarningsPerShareBasic'],
  ocf: ['NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'],
  capex: ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets'],
  assets: ['Assets'],
  liabilities: ['Liabilities'],
  equity: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
  cash: ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents', 'Cash'],
  debt: ['LongTermDebt', 'LongTermDebtNoncurrent', 'LongTermDebtAndCapitalLeaseObligations'],
  shares: ['WeightedAverageNumberOfDilutedSharesOutstanding', 'WeightedAverageNumberOfSharesOutstandingBasic'],
};
// Foreign companies filing a 20-F or 40-F tag their figures in IFRS terms, once a year, in their
// own currency (Taiwan dollars for TSMC).
export const IFRS_CONCEPTS = {
  revenue: ['Revenue', 'RevenueFromContractsWithCustomers'],
  gross_profit: ['GrossProfit'],
  operating_income: ['ProfitLossFromOperatingActivities'],
  net_income: ['ProfitLossAttributableToOwnersOfParent', 'ProfitLoss'],
  eps: ['DilutedEarningsLossPerShare', 'BasicEarningsLossPerShare'],
  ocf: ['CashFlowsFromUsedInOperatingActivities'],
  capex: ['PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities', 'PurchaseOfPropertyPlantAndEquipment'],
  assets: ['Assets'],
  liabilities: ['Liabilities'],
  equity: ['EquityAttributableToOwnersOfParent', 'Equity'],
  cash: ['CashAndCashEquivalents'],
  debt: ['NoncurrentPortionOfNoncurrentBorrowings', 'LongtermBorrowings'],
};
const INSTANT = new Set(['assets', 'liabilities', 'equity', 'cash', 'debt']);
const FORMS = /^(10-K|10-Q|10-KT|10-QT|20-F|40-F)(\/A)?$/;
const DAY = 86400000;
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
const isYear = (s, e) => { const d = days(s, e); return d >= 350 && d <= 380; };
const isQuarter = (s, e) => { const d = days(s, e); return d >= 80 && d <= 100; };
const near = (a, b, tol = 10) => Math.abs(days(a, b)) <= tol;

// One concept's facts in the statements' currency (or per share in it, or in shares), one value
// per (start, end): the latest filing wins.
function facts(gaap, concept, cur) {
  const c = gaap[concept];
  if (!c || !c.units) return [];
  const u = [cur, cur + '/shares', 'shares'].find(x => Array.isArray(c.units[x])), unit = u && c.units[u];
  if (!Array.isArray(unit)) return [];
  const by = new Map();
  for (const f of unit) {
    if (!FORMS.test(f.form || '') || !Number.isFinite(f.val) || !f.end) continue;
    const k = (f.start || '') + '|' + f.end, old = by.get(k);
    if (!old || String(f.filed) > String(old.filed)) by.set(k, f);
  }
  return [...by.values()];
}

// A duration concept -> { years: Map(end -> val), quarters: Map(end -> val) }.
function durations(list) {
  const years = new Map(), quarters = new Map(), ytd = new Map();
  for (const f of list) {
    if (!f.start) continue;
    if (isYear(f.start, f.end)) years.set(f.end, f.val);
    if (isQuarter(f.start, f.end)) quarters.set(f.end, f.val);
    (ytd.get(f.start) || ytd.set(f.start, []).get(f.start)).push(f);
  }
  // Year so far: each later figure less the one before it (same start), when they are a
  // quarter apart and the quarter wasn't reported on its own.
  for (const runs of ytd.values()) {
    runs.sort((a, b) => a.end.localeCompare(b.end));
    for (let i = 1; i < runs.length; i++) {
      const a = runs[i - 1], b = runs[i];
      if (!isQuarter(a.end, b.end) || [...quarters.keys()].some(e => near(e, b.end))) continue;
      // Rounded: a difference of two cent figures (earnings per share) has float noise.
      quarters.set(b.end, Math.round((b.val - a.val) * 10000) / 10000);
    }
  }
  return { years, quarters };
}
function instants(list) {
  const out = new Map();
  for (const f of list) if (!f.start) out.set(f.end, f.val);
  return out;
}
// The value at (or within 10 days of) an end date.
const at = (map, end) => {
  if (map.has(end)) return map.get(end);
  for (const [e, v] of map) if (near(e, end)) return v;
  return undefined;
};

// Fiscal labels: a year is named by the calendar year it ends in ("2025"); a quarter by its
// place in that fiscal year ("T3 2025").
function labels(yearEnds) {
  const ends = [...yearEnds].sort();
  const fyOf = qEnd => {
    for (const e of ends) if (days(qEnd, e) >= -10 && days(qEnd, e) < 370) return e;
    // A quarter of a year not closed yet: that year ends a year after the last one closed.
    const last = ends[ends.length - 1];
    if (!last) return null;
    let e = last;
    while (days(e, qEnd) > 10) e = new Date(Date.parse(e) + 365.25 * DAY).toISOString().slice(0, 10);
    return e;
  };
  return {
    year: e => e.slice(0, 4),
    quarter: qEnd => {
      const fy = fyOf(qEnd);
      if (!fy) return 'T? ' + qEnd.slice(0, 4);
      const q = Math.min(4, Math.max(1, 4 - Math.round(days(qEnd, fy) / 91.3)));
      return 'T' + q + ' ' + fy.slice(0, 4);
    },
  };
}

export function secRows(companyfacts, { years = 5, quarters = 20 } = {}) {
  const all = (companyfacts && companyfacts.facts) || {};
  // US GAAP when the company files with it, IFRS (a foreign filer) otherwise.
  const usable = (tax, map) => tax && map.revenue.concat(map.net_income).some(c => tax[c]);
  const ifrs = !usable(all['us-gaap'], SEC_CONCEPTS) && usable(all['ifrs-full'], IFRS_CONCEPTS);
  const gaap = (ifrs ? all['ifrs-full'] : all['us-gaap']) || {}, MAP = ifrs ? IFRS_CONCEPTS : SEC_CONCEPTS;
  // The statements' currency: the one revenue and net income have the longest record in (a
  // foreign filer may add a "convenience translation" into dollars for its latest years; those
  // are not its statements).
  const counts = {};
  for (const c of MAP.revenue.concat(MAP.net_income)) for (const [u, xs] of Object.entries((gaap[c] && gaap[c].units) || {}))
    if (/^[A-Z]{3}$/.test(u)) counts[u] = (counts[u] || 0) + xs.length;
  const currency = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || (a === 'USD' ? -1 : 1))[0] || 'USD';
  const series = {};
  for (const [key, concepts] of Object.entries(MAP)) {
    series[key] = concepts.map(c => INSTANT.has(key) ? instants(facts(gaap, c, currency)) : durations(facts(gaap, c, currency)));
  }
  const pick = (key, kind, end) => {
    for (const s of series[key]) {
      const v = INSTANT.has(key) ? at(s, end) : at(kind === 'A' ? s.years : s.quarters, end);
      if (v !== undefined) return v;
    }
    return null;
  };
  // The periods: the ends the revenue or net income has (whichever concept gives them).
  const ends = { A: new Set(), Q: new Set() };
  for (const key of ['revenue', 'net_income']) for (const s of series[key]) {
    s.years.forEach((_, e) => ends.A.add(e)); s.quarters.forEach((_, e) => ends.Q.add(e));
  }
  // The same period under two dates a few days apart (a 52/53-week year) counts once.
  const dedupe = set => [...set].sort().reverse().filter((e, i, all) => !all.slice(0, i).some(x => near(x, e)));
  const L = labels(dedupe(ends.A));
  const row = (period, end) => {
    const data = {};
    for (const key of Object.keys(MAP)) { const v = pick(key, period, end); if (v !== null) data[key] = v; }
    if (data.ocf != null && data.capex != null) data.fcf = data.ocf - data.capex;
    return { period, period_end: end, label: period === 'A' ? L.year(end) : L.quarter(end), currency, data };
  };
  return dedupe(ends.A).slice(0, years).map(e => row('A', e))
    .concat(dedupe(ends.Q).slice(0, quarters).map(e => row('Q', e)))
    .filter(r => Object.keys(r.data).length >= 2);
}

// A share as the apps write it (BRK.B) -> as the SEC does (BRK-B).
export const secTicker = t => String(t || '').toUpperCase().replace('.', '-');

// ------------------------------------------------------------------ Finance Ministry (data.gov.ro)
// The yearly "Situațiile financiare" datasets (Ministerul Finanțelor, CC BY 4.0): one file of
// figures per kind of filer (WEB_IR: companies filing IFRS; WEB_BL_BS_SL and WEB_UU: the others;
// institutions de credit: banks; SIF, VS, ASIG, BROK, IFN: funds, market firms, insurers,
// insurance brokers, non-bank lenders), each with a .csv
// that names its columns ("Cifra de afaceri neta;i13"). The columns differ by kind and year, so
// they are found by name. Individual statements (not consolidated), in lei, at 31 December.
export const MF_KINDS = [
  // [key, the file's name, preference when a company is in two of them]
  ['ir', /web_ir_/i], ['bank', /inst(it)?_de_credit/i], ['sif', /web_sif/i], ['vs', /web_vs_/i], ['asig', /webasig/i],
  ['brok', /webbrok/i], ['ifn', /web_ifn/i], ['bl', /web_bl_bs_sl/i], ['uu', /web_uu_/i],
];
const plain = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[şș]/gi, 's').replace(/[ţț]/gi, 't')
  .toLowerCase().replace(/\s+/g, ' ').replace(/[\s:,]+$/, '').trim();
// A .csv of column names -> { I13: 'cifra de afaceri neta', ... } (a code written "12" is I12).
export function mfColumns(specText) {
  const out = {};
  for (const line of String(specText || '').split(/\r?\n/)) {
    const m = /^(.*);\s*i?(\d+)\s*$/i.exec(line.trim());
    if (m) out['I' + m[2]] = plain(m[1]);
  }
  return out;
}
const FIELD = [
  // [field, label pattern, how several matches combine]
  ['revenue', /^cifra de afaceri neta/],
  ['income_total', /^venituri ?- ?total|^venituri totale(?! din exploatare)/],
  ['bank_income', /^venituri totale din exploatare, net/],
  ['profit', /^profit(ul)? net$|^rezultatul net profit$/],
  ['loss', /^pierdere(a)? neta$|^rezultatul net pierdere$/],
  ['bank_result', /^profit sau pierdere aferent\/?a? exercitiului$/],
  ['fixed', /^active imobilizate - total/],
  ['current', /^active circulante - total/],
  ['prepaid', /^cheltuieli in avans$/],
  ['debts', /^datorii$/],
  ['debts_short', /^datorii ce trebuiesc platite intr-o perioada de un an$/],
  ['debts_long', /^datorii ce trebuiesc platite intr-o perioada mai mare de un an$/],
  ['equity_total', /^capitaluri - total/],
  ['equity_own', /^capitaluri proprii$/],
  ['cash', /^casa si conturi la banci|^numerar si solduri de numerar/],
  ['employees', /^numar mediu de salariati/],
];
// One company's line of a file -> the figures the Financials tab shows (absent when not given).
export function mfFigures(columns, header, cells) {
  const raw = {};
  header.forEach((h, i) => {
    const label = columns[String(h).trim().toUpperCase()];
    if (!label) return;
    const f = FIELD.find(([, re]) => re.test(label));
    const v = String(cells[i] == null ? '' : cells[i]).trim();
    if (f && v !== '' && isFinite(+v) && raw[f[0]] === undefined) raw[f[0]] = +v;
  });
  const d = {};
  const rev = raw.revenue || raw.bank_income || raw.income_total;
  if (rev != null) d.revenue = rev;
  if (raw.bank_result != null) d.net_income = raw.bank_result;
  else if (raw.profit != null || raw.loss != null) d.net_income = (raw.profit || 0) - (raw.loss || 0);
  if (raw.fixed != null || raw.current != null) d.assets = (raw.fixed || 0) + (raw.current || 0) + (raw.prepaid || 0);
  if (raw.debts != null) d.liabilities = raw.debts;
  else if (raw.debts_short != null || raw.debts_long != null) d.liabilities = (raw.debts_short || 0) + (raw.debts_long || 0);
  const eq = raw.equity_own != null ? raw.equity_own : raw.equity_total;
  if (eq != null) d.equity = eq;
  if (raw.cash != null) d.cash = raw.cash;
  if (raw.employees != null && raw.employees > 0) d.employees = raw.employees;
  return d;
}
