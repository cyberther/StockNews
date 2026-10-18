// The impact analyses in the app (supabase/impact.sql): the queries, the frozen results as
// published, which companies of an analysis concern the reader, the effect on their positions
// in lei, and the calculator link (parameters in the URL hash, nothing stored). Needs
// hif-scenario.js and hif-impact.js first.
(function(){
var root = typeof window !== 'undefined' ? window : globalThis;
var ID = /^[a-z0-9][a-z0-9-]{1,60}$/, SYMBOL = /^[A-Z0-9][A-Z0-9.\-]{0,11}$/, DATE = /^\d{4}-\d{2}-\d{2}$/;
function id(v){ if (!ID.test(String(v))) throw new Error('bad analysis id'); return v; }
function ver(v){ if (!(Number.isInteger(Number(v)) && Number(v) > 0)) throw new Error('bad version'); return Number(v); }
function sym(t){ if (!SYMBOL.test(String(t))) throw new Error('bad ticker'); return t; }

var query = {
  analyses: function(){ return 'impact_analyses?select=id,version,published_at,title,policy,events,sectors,body&order=published_at.desc,id.asc,version.desc&limit=200'; },
  results: function(a, v){ return 'impact_results?select=scenario,subject,engine_version,vals,formula,computed_at&analysis_id=eq.' + id(a) + '&version=eq.' + ver(v) + '&order=computed_at.asc'; },
  accuracy: function(a, v){ return 'analysis_accuracy?select=*&analysis_id=eq.' + id(a) + '&version=eq.' + ver(v); },
  financials: function(t){ return 'company_financials?select=*&ticker=eq.' + sym(t) + '&order=fiscal_year.desc,provenance.asc&limit=6'; },
  exposure: function(){ return 'company_exposure?select=*&limit=2000'; }
};
// One request; an error is an error, not an empty list.
function load(q){
  var A = root.HIFAuth;
  if (!A || !A.rest) return Promise.resolve(null);
  return A.rest(q).then(function(r){
    if (!r || !r.ok || !Array.isArray(r.body)) throw new Error('impact ' + ((r && r.status) || 0));
    return r.body;
  });
}

// The newest version of each analysis (rows come newest first), with every version it has.
function latest(rows){
  var by = {}, order = [];
  (rows || []).forEach(function(a){
    if (!by[a.id]) { by[a.id] = Object.assign({}, a, { versions: [] }); order.push(a.id); }
    by[a.id].versions.push(a.version);
  });
  return order.map(function(k){ return by[k]; });
}
// The results as first published: the earliest row per scenario and subject.
function frozen(rows){
  var out = {};
  (rows || []).forEach(function(r){
    var sc = out[r.scenario] || (out[r.scenario] = {});
    if (sc[r.subject]) return;
    sc[r.subject] = Object.assign({}, r.vals, { formula: r.formula, engine_version: r.engine_version, computed_at: r.computed_at });
  });
  return out;
}
function concerns(analysis, follows, positions){
  var f = follows || [], p = positions || {};
  return ((analysis && analysis.companies) || []).reduce(function(out, c){
    var via = [];
    if (f.indexOf(c.ticker) >= 0) via.push('following');
    if (Object.prototype.hasOwnProperty.call(p, c.ticker)) via.push('portfolio');
    if (via.length) out.push({ ticker: c.ticker, via: via });
    return out;
  }, []);
}
// Weighted change of operating profit over the reader's positions in lei (the analyses are
// about Bucharest listings); holdings: [{ ticker, value, currency }].
function portfolioEffect(fz, holdings, scenario){
  var pos = {}, comp = {};
  (holdings || []).forEach(function(h){ if (h && h.currency === 'RON') pos[h.ticker] = { value: h.value }; });
  var sc = (fz && fz[scenario || 'full']) || {};
  Object.keys(sc).forEach(function(t){ if (t !== 'budget') { comp[t] = {}; comp[t][scenario || 'full'] = sc[t]; } });
  return root.HIFImpact.portfolio({ companies: comp }, pos, scenario || 'full');
}

// The calculator's starting point: the analysis' budget assumptions and one company's inputs
// (its figures only when verified ones exist).
function calcParams(analysis, ticker, financials){
  var I = root.HIFImpact, A = analysis.assumptions || [];
  var val = function(k){ var a = A.filter(function(x){ return x.key === k; })[0]; return a ? a.value : undefined; };
  var p = { a: analysis.id, v: analysis.version, t: ticker };
  ['cost', 'funded_pct', 'gdp', 'start', 'end'].forEach(function(k){ var x = val(k); if (x !== undefined) p[k] = x; });
  if (p.funded_pct === undefined) p.funded_pct = 0;
  p.impl_pct = 100; p.delay_months = 0;
  var f = (financials || []).filter(function(r){ return r.ticker === ticker && r.verified === true; })
    .sort(function(x, y){ return y.fiscal_year - x.fiscal_year; })[0];
  if (f) { p.revenue = Number(f.revenue); p.operating_profit = Number(f.operating_profit); }
  var c = (analysis.companies || []).filter(function(x){ return x.ticker === ticker; })[0];
  if (c) {
    p.exposure = I.resolve(analysis, c.exposure_pct); p.shock = I.resolve(analysis, c.shock_pct);
    p.mitigation = I.resolve(analysis, c.mitigation_pct); p.contribution = I.resolve(analysis, c.contribution_pct);
  }
  return p;
}

var HASH_KEYS = ['a', 'v', 't', 'cost', 'funded_pct', 'gdp', 'start', 'end', 'impl_pct', 'delay_months', 'revenue', 'operating_profit', 'exposure', 'shock', 'mitigation', 'contribution'];
function encodeHash(p){
  return '#' + HASH_KEYS.filter(function(k){ return p[k] !== undefined && p[k] !== null && p[k] !== ''; })
    .map(function(k){ return k + '=' + encodeURIComponent(String(p[k])); }).join('&');
}
// Only known keys with valid values: a hand-edited or foreign link cannot inject anything.
function decodeHash(h){
  var L = root.HIFImpact.LIMITS, out = {};
  String(h || '').replace(/^#/, '').split('&').forEach(function(pair){
    var i = pair.indexOf('='); if (i < 1) return;
    var k = pair.slice(0, i), v;
    try { v = decodeURIComponent(pair.slice(i + 1)); } catch (e) { return; }
    if (HASH_KEYS.indexOf(k) < 0) return;
    if (k === 'a') { if (ID.test(v)) out.a = v; return; }
    if (k === 't') { if (SYMBOL.test(v)) out.t = v; return; }
    if (k === 'v') { if (/^[1-9]\d{0,3}$/.test(v)) out.v = Number(v); return; }
    if (k === 'start' || k === 'end') { if (DATE.test(v) && !isNaN(Date.parse(v + 'T00:00:00Z'))) out[k] = v; return; }
    var n = Number(v), lim = L[k];
    if (v !== '' && Number.isFinite(n) && lim && n >= lim[0] && n <= lim[1]) out[k] = n;
  });
  return out;
}

root.HIFImpactClient = { query: query, load: load, latest: latest, frozen: frozen, concerns: concerns,
  portfolioEffect: portfolioEffect, calcParams: calcParams, encodeHash: encodeHash, decodeHash: decodeHash };
})();
