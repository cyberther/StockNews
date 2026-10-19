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
    "month": 29,
    "year": 290
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
root.HIFBilling = Object.assign(root.HIFBilling || {}, { CONFIG: CONFIG, limits: limits });
})();
