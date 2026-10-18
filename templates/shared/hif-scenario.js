// The policy scenario calculator's arithmetic (templates/stock-news-web/intelligence.html),
// kept apart so it is tested (test/scenario.test.js) and every figure on the page comes from
// one formula, shown with the result:
//   revenue change          = revenue × exposed share × shock × (1 − mitigation)
//   operating profit change = revenue change × contribution margin
// It models operating profit only: no share prices, no forecasts.
(function(){
var LIMITS = { revenue: [0, 1e15], margin: [-100, 100], exposure: [0, 100], shock: [-100, 100], mitigation: [0, 100], contribution: [0, 100] };
var round = function(n){ return Math.round(n * 1e10) / 1e10; };
function value(name, v){
  if (v === '' || v == null) throw new Error(name + ' is required');
  var n = Number(v), l = LIMITS[name];
  if (!Number.isFinite(n) || n < l[0] || n > l[1]) throw new Error(name + ' must be between ' + l[0] + ' and ' + l[1]);
  return n;
}
function fmt(n){ return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2, useGrouping: false }).format(n).replace('-', '−'); }
function compute(input){
  var v = {};
  Object.keys(LIMITS).forEach(function(k){ v[k] = value(k, input[k]); });
  var base = round(v.revenue * v.margin / 100);
  var revenueDelta = round(v.revenue * v.exposure / 100 * v.shock / 100 * (1 - v.mitigation / 100));
  var profitDelta = round(revenueDelta * v.contribution / 100);
  return {
    base: base, revenueDelta: revenueDelta, profitDelta: profitDelta, projected: round(base + profitDelta),
    deltaPct: base === 0 ? null : round(profitDelta / Math.abs(base) * 100),
    formula: 'Revenue change = ' + fmt(v.revenue) + ' × ' + fmt(v.exposure) + '% × ' + fmt(v.shock) + '% × (1 − ' + fmt(v.mitigation) + '%) = ' + fmt(revenueDelta) + '\n' +
      'Operating profit change = ' + fmt(revenueDelta) + ' × ' + fmt(v.contribution) + '% = ' + fmt(profitDelta)
  };
}
var root = typeof window !== 'undefined' ? window : globalThis;
root.HIFScenario = { compute: compute, fmt: fmt, LIMITS: LIMITS };
})();
