// Plans, prices and limits for the browser: a copy of config/billing.json (test/billing-config.test.js
// fails when the two differ). The server applies the limits (supabase/billing.sql) only while
// COMMERCIAL_MODE is on; until then every approved account has everything.
(function(){
var CONFIG = {
  "provider": "lemonsqueezy",
  "testMode": true,
  "currency": "RON",
  "trialDays": 14,
  "prices": {
    "month": 49,
    "year": 490
  },
  "founder": {
    "seats": 200
  },
  "limits": {
    "free": {
      "tickers": 5,
      "positions": 5
    },
    "pro": {
      "tickers": 100,
      "positions": 100
    }
  },
  "features": [
    {
      "key": "bilRowNews",
      "free": "✓",
      "pro": "✓"
    },
    {
      "key": "bilRowPolicy",
      "free": "✓",
      "pro": "✓"
    },
    {
      "key": "bilRowTickers",
      "free": "5",
      "pro": "100"
    },
    {
      "key": "bilRowPositions",
      "free": "5",
      "pro": "100"
    },
    {
      "key": "bilRowPush",
      "free": "—",
      "pro": "✓"
    },
    {
      "key": "bilRowImpact",
      "free": "bilFacts",
      "pro": "bilFull"
    },
    {
      "key": "bilRowCalc",
      "free": "—",
      "pro": "✓"
    },
    {
      "key": "bilRowDigest",
      "free": "—",
      "pro": "✓"
    },
    {
      "key": "bilRowGains",
      "free": "bilGainsFree",
      "pro": "bilFull"
    },
    {
      "key": "bilRowChart",
      "free": "6M",
      "pro": "5Y"
    }
  ],
  "variants": {
    "month": null,
    "year": null
  }
};
var root = typeof window !== 'undefined' ? window : globalThis;
function limits(plan){ return CONFIG.limits[plan === 'pro' ? 'pro' : 'free']; }
// The reader's plan, as the server decides it (supabase/billing.sql my_plan): one request.
// null when it cannot tell (signed out, or before billing.sql exists): the app keeps working.
function load(){
  var A = root.HIFAuth;
  if (!A || !A.rest) return Promise.resolve(null);
  return A.rest('rpc/my_plan', { method: 'POST', body: {} }).then(function(r){
    return r && r.ok && r.body && typeof r.body === 'object' ? r.body : null;
  }).catch(function(){ return null; });
}
// The founder price: { seats, left } (counts only, supabase/billing.sql founder_offer), or null.
function offer(){
  var A = root.HIFAuth;
  if (!A || !A.rest) return Promise.resolve(null);
  return A.rest('rpc/founder_offer', { method: 'POST', body: {} }).then(function(r){
    var b = r && r.ok && r.body;
    return b && typeof b.seats === 'number' && typeof b.left === 'number' ? { seats: b.seats, left: b.left } : null;
  }).catch(function(){ return null; });
}
// A checkout link for the signed-in reader (supabase/functions/billing): only the interval is
// sent; the account is read from the token on the server. { url } or { error }.
function checkout(interval){
  var A = root.HIFAuth, c = A && A.publicConfig && A.publicConfig();
  if (!A || !A.token || !c || !c.supabaseUrl) return Promise.resolve({ error: 'unavailable' });
  var iv = interval === 'year' ? 'year' : 'month';
  return A.token().then(function(t){
    if (!t) return { error: 'sign in required' };
    return fetch(String(c.supabaseUrl).replace(/\/$/, '') + '/functions/v1/billing?action=checkout&interval=' + iv,
      { method: 'POST', headers: { authorization: 'Bearer ' + t } })
      .then(function(res){ return res.json().catch(function(){ return {}; }).then(function(j){
        if (res.ok && typeof j.url === 'string' && /^https:\/\/[^\s"'<>]+$/.test(j.url)) return { url: j.url };
        return { error: res.ok ? 'checkout failed' : (j.error || 'checkout failed') };
      }); });
  }).catch(function(){ return { error: 'checkout failed' }; });
}
root.HIFBilling = Object.assign(root.HIFBilling || {}, { CONFIG: CONFIG, limits: limits, load: load, offer: offer, checkout: checkout });
})();
