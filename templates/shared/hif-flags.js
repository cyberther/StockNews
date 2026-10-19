// Feature flags for the apps, the gateway and the ingestion jobs.
//
// The source of truth is config/flags.json; this is its browser copy (test/flags.test.js
// fails when the two differ). Pages opened straight from the repo need no build step.
//
//   following, bvb, portfolio   the modules in use
//   usMarket, euMarket          the US and EU Market feed tabs (on hold: no tab, no requests)
//   universeScan                scanning listings nobody follows (on hold)
//   prefetchUnfollowedNews      news for instruments nobody follows (on hold)
//   hiddenModuleRefresh         refreshing modules that aren't on screen (on hold)
//   commercialMode              hide data whose licence is dev_only from public and paid features
//   dataSource                  'supabase' (market data from the ingestion tables) or 'gateway' (/api/finnhub)
//   policy                      the Policy screen and the daily official-sources job (Phase B)
//   impact                      impact analyses, companies' exposure, the calculator, the portfolio card (Phase C)
//   policyAlerts                push alerts for policy events and analyses (Edge Function: FLAG_POLICY_ALERTS)
//   aiAnnotations               the local model's annotations: admin review and verified ones shown (Phase C)
//   billing                     the real paywall and the subscription on the Account screen (Phase D)
//   legalReviewed               allows checkout; false until the terms are checked by a lawyer (Phase D)
//   autoImpact                  fact sheets and automatic analyses on the Policy screen (Politici 2.0)
//   whoGains                    the "Cine câștigă" tab: links, company exposure, money by purchase (Politici 2.0)
(function(){
var FLAGS = {
  following: true,
  bvb: true,
  portfolio: true,
  usMarket: false,
  euMarket: false,
  universeScan: false,
  prefetchUnfollowedNews: false,
  hiddenModuleRefresh: false,
  commercialMode: false,
  dataSource: 'supabase',
  policy: true,
  impact: true,
  policyAlerts: true,
  aiAnnotations: false,
  billing: true,
  legalReviewed: false,
  autoImpact: true,
  whoGains: true
};
var root = typeof window !== 'undefined' ? window : globalThis;
root.HIFFlags = {
  get: function(name){ return Object.prototype.hasOwnProperty.call(FLAGS, name) ? FLAGS[name] : undefined; },
  all: function(){ return Object.assign({}, FLAGS); }
};
})();
