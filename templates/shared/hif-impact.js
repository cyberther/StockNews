// The impact engine for the policy analyses (docs/plans/2026-10-18-faza-c-design.md, "Modelul
// de calcul"): budget, company, scenario, portfolio and accuracy formulas. Pure and the same in
// the browser and in the ingestion job (ingest/impact/run.mjs freezes its results with
// ENGINE_VERSION); every result carries its formula with the figures put in. Needs
// hif-scenario.js first (for fmt and the input limits). One direct step only: no prices, no
// forecasts, no second-order effects.
(function(){
var root = typeof window !== 'undefined' ? window : globalThis;
var S = root.HIFScenario;
var ENGINE_VERSION = '1.0.0';
var SCENARIOS = ['full', 'partial', 'delayed'];
var LIMITS = { cost: [-1e15, 1e15], funded_pct: [0, 100], gdp: [1, 1e16], impl_pct: [0, 100], delay_months: [0, 120],
  revenue: S.LIMITS.revenue, operating_profit: [-1e15, 1e15], exposure: S.LIMITS.exposure, shock: S.LIMITS.shock,
  mitigation: S.LIMITS.mitigation, contribution: S.LIMITS.contribution };
var DATE = /^\d{4}-\d{2}-\d{2}$/;
var round = function(n){ return Math.round(n * 1e10) / 1e10; };
var fmt = S.fmt;

function num(name, v){
  if (v === '' || v == null) throw new Error(name + ' is required');
  var n = Number(v), l = LIMITS[name];
  if (!Number.isFinite(n) || n < l[0] || n > l[1]) throw new Error(name + ' must be between ' + l[0] + ' and ' + l[1]);
  return n;
}
function date(name, v){
  if (typeof v !== 'string' || !DATE.test(v) || isNaN(Date.parse(v + 'T00:00:00Z'))) throw new Error(name + ' must be a date (YYYY-MM-DD)');
  return v;
}

// Months of a calendar year in which a measure starting on `start`, `delay` months late, is in
// force: 0..12, a part month counted by its days.
function monthsInForce(start, delay, year){
  date('start', start);
  var d = new Date(start + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + Number(delay || 0));
  var y = d.getUTCFullYear();
  if (y > year) return 0;
  if (y < year) return 12;
  var days = new Date(Date.UTC(y, d.getUTCMonth() + 1, 0)).getUTCDate();
  return round(12 - d.getUTCMonth() - (d.getUTCDate() - 1) / days);
}

// cost: + spending or revenue lost by the budget, − revenue gained. net < 0 widens the deficit.
function budget(p){
  var cost = num('cost', p.cost), funded = num('funded_pct', p.funded_pct), gdp = num('gdp', p.gdp);
  var impl = num('impl_pct', p.impl_pct), delay = num('delay_months', p.delay_months), start = date('start', p.start);
  var net = round(-cost * (1 - funded / 100));
  var y0 = Number(start.slice(0, 4)), byYear = {}, lines = [];
  [y0, y0 + 1].forEach(function(y){
    var m = monthsInForce(start, delay, y);
    byYear[y] = round(net * impl / 100 * m / 12);
    lines.push('Effect in ' + y + ' = ' + fmt(net) + ' × ' + fmt(impl) + '% × ' + fmt(m) + '/12 = ' + fmt(byYear[y]));
  });
  var pctGdp = round(net / gdp * 100);
  return { net: net, pctGdp: pctGdp, byYear: byYear,
    formula: 'Net effect on the balance = ' + fmt(-cost) + ' × (1 − ' + fmt(funded) + '%) = ' + fmt(net) + '\n' +
      'Share of GDP = ' + fmt(net) + ' / ' + fmt(gdp) + ' = ' + fmt(pctGdp) + '%\n' + lines.join('\n') };
}

function company(c, s){
  var rev = num('revenue', c.revenue), op = num('operating_profit', c.operating_profit);
  var exp = num('exposure', c.exposure), shock = num('shock', c.shock), mit = num('mitigation', c.mitigation), con = num('contribution', c.contribution);
  var impl = num('impl_pct', s.impl_pct), delay = num('delay_months', s.delay_months), start = date('start', s.start);
  var revenueDelta = round(rev * exp / 100 * shock / 100 * (1 - mit / 100));
  var profitDelta = round(revenueDelta * con / 100);
  var runRate = round(profitDelta * impl / 100);
  var y0 = Number(start.slice(0, 4)), byYear = {}, lines = [];
  [y0, y0 + 1].forEach(function(y){
    var m = monthsInForce(start, delay, y);
    byYear[y] = round(profitDelta * impl / 100 * m / 12);
    lines.push('In ' + y + ' = ' + fmt(profitDelta) + ' × ' + fmt(impl) + '% × ' + fmt(m) + '/12 = ' + fmt(byYear[y]));
  });
  var pct = op === 0 ? null : round(runRate / Math.abs(op) * 100);
  return { revenueDelta: revenueDelta, profitDelta: profitDelta, pctOfProfit: pct, byYear: byYear,
    formula: 'Revenue change = ' + fmt(rev) + ' × ' + fmt(exp) + '% × ' + fmt(shock) + '% × (1 − ' + fmt(mit) + '%) = ' + fmt(revenueDelta) + '\n' +
      'Operating profit change = ' + fmt(revenueDelta) + ' × ' + fmt(con) + '% = ' + fmt(profitDelta) + '\n' +
      'Share of operating profit = ' + fmt(profitDelta) + ' × ' + fmt(impl) + '% / |' + fmt(op) + '| = ' + (pct === null ? 'n/a' : fmt(pct) + '%') + '\n' +
      lines.join('\n') };
}

// A number in an analysis is a reference to one of its assumptions or facts, never a bare value.
function resolve(analysis, ref){
  if (!ref || typeof ref !== 'object' || typeof ref.ref !== 'string') throw new Error('expected { ref: key }, got ' + JSON.stringify(ref));
  var all = (analysis.assumptions || []).concat(analysis.facts || []);
  for (var i = 0; i < all.length; i++) if (all[i].key === ref.ref) return all[i].value;
  throw new Error('unknown key ' + ref.ref);
}
function assumption(analysis, key, fallback){
  var a = (analysis.assumptions || []).filter(function(x){ return x.key === key; })[0];
  return a ? a.value : fallback;
}
function scenarioParams(analysis, scenario){
  var start = assumption(analysis, 'start');
  if (scenario === 'partial') return { impl_pct: Number(assumption(analysis, 'partial_pct', 50)), delay_months: 0, start: start };
  if (scenario === 'delayed') return { impl_pct: 100, delay_months: Number(assumption(analysis, 'delay_months', 6)), start: start };
  return { impl_pct: 100, delay_months: 0, start: start };
}

// The latest verified year of each company's figures.
function latest(financials){
  var by = {};
  (financials || []).forEach(function(f){
    if (!f || f.verified !== true || f.revenue == null || f.operating_profit == null) return;
    if (!by[f.ticker] || f.fiscal_year > by[f.ticker].fiscal_year) by[f.ticker] = f;
  });
  return by;
}
function run(analysis, financials){
  var fin = latest(financials), out = { engine: ENGINE_VERSION, budget: {}, companies: {} };
  SCENARIOS.forEach(function(sc){
    var p = scenarioParams(analysis, sc);
    out.budget[sc] = budget({ cost: assumption(analysis, 'cost'), funded_pct: assumption(analysis, 'funded_pct', 0),
      gdp: assumption(analysis, 'gdp'), start: p.start, impl_pct: p.impl_pct, delay_months: p.delay_months });
  });
  (analysis.companies || []).forEach(function(c){
    var f = fin[c.ticker];
    if (!f) { out.companies[c.ticker] = { missing: 'financials' }; return; }
    var inputs = { revenue: f.revenue, operating_profit: f.operating_profit, exposure: resolve(analysis, c.exposure_pct),
      shock: resolve(analysis, c.shock_pct), mitigation: resolve(analysis, c.mitigation_pct), contribution: resolve(analysis, c.contribution_pct) };
    var r = { fiscal_year: f.fiscal_year, source_url: f.source_url || null };
    SCENARIOS.forEach(function(sc){ r[sc] = company(inputs, scenarioParams(analysis, sc)); });
    out.companies[c.ticker] = r;
  });
  return out;
}

// Weighted change of operating profit over the reader's positions (weight = value / all positions).
function portfolio(results, positions, scenario){
  var pos = positions || {}, total = 0;
  Object.keys(pos).forEach(function(t){ var v = pos[t] && Number(pos[t].value); if (Number.isFinite(v) && v > 0) total += v; });
  if (!(total > 0)) return { weighted: null, parts: [], formula: '', reason: 'no_values' };
  var parts = [], sum = 0, comp = (results && results.companies) || {};
  Object.keys(pos).forEach(function(t){
    var r = comp[t] && comp[t][scenario || 'full'], v = Number(pos[t] && pos[t].value);
    if (!r || r.pctOfProfit == null || !Number.isFinite(v) || v <= 0) return;
    var w = round(v / total * 100);
    parts.push({ ticker: t, weight: w, pct: r.pctOfProfit });
    sum += w / 100 * r.pctOfProfit;
  });
  if (!parts.length) return { weighted: null, parts: [], formula: '', reason: 'not_held' };
  var weighted = round(sum);
  return { weighted: weighted, parts: parts,
    formula: parts.map(function(p){ return fmt(p.weight) + '% × ' + fmt(p.pct) + '%'; }).join(' + ') + ' = ' + fmt(weighted) + '%' };
}

function accuracy(estimated, observed){
  var e = Number(estimated), o = Number(observed), error = round(o - e);
  return { error: error, relError: e === 0 ? null : round(error / Math.abs(e)), direction: Math.sign(o) === Math.sign(e) };
}

root.HIFImpact = { ENGINE_VERSION: ENGINE_VERSION, SCENARIOS: SCENARIOS, LIMITS: LIMITS, monthsInForce: monthsInForce,
  budget: budget, company: company, resolve: resolve, scenarioParams: scenarioParams, run: run, portfolio: portfolio, accuracy: accuracy };
})();
