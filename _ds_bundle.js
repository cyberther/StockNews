/* @ds-bundle: {"format":4,"namespace":"Modernist_modern","components":[],"sourceHashes":{"netlify/functions/finnhub.js":"efab4f75e0d4"},"inlinedExternals":[],"unexposedExports":[{"name":"config","sourcePath":"netlify/functions/finnhub.js"}]} */

(() => {

const __ds_ns = (window.Modernist_modern = window.Modernist_modern || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// netlify/functions/finnhub.js
try { (() => {
// Netlify Function: server-side proxy for Finnhub.
// The API key lives in the site env (FINNHUB_KEY) and never reaches the browser.
//
// Setup: Netlify → Site configuration → Environment variables → FINNHUB_KEY = <your 20-char Finnhub key>
// Call it as: /api/finnhub?path=/quote&symbol=NVDA
//
// Only the endpoints this prototype needs are allowed through.
const ALLOWED = new Set(['/quote', '/company-news', '/search', '/stock/recommendation']);
const BASE = 'https://finnhub.io/api/v1';
let __ds_default_netlify_functions_finnhub_wqyy4h;
try {
  __ds_default_netlify_functions_finnhub_wqyy4h = async request => {
    const url = new URL(request.url);
    const path = url.searchParams.get('path') || '';
    if (!ALLOWED.has(path)) {
      return Response.json({
        error: 'path not allowed',
        path
      }, {
        status: 400
      });
    }
    const key = process.env.FINNHUB_KEY;
    if (!key) {
      return Response.json({
        error: 'FINNHUB_KEY is not set on this site'
      }, {
        status: 500
      });
    }
    const out = new URL(BASE + path);
    for (const [k, v] of url.searchParams) if (k !== 'path') out.searchParams.set(k, v);
    out.searchParams.set('token', key);
    try {
      const res = await fetch(out, {
        headers: {
          accept: 'application/json'
        }
      });
      const body = await res.text();
      return new Response(body, {
        status: res.status,
        headers: {
          'content-type': 'application/json',
          // quotes go stale fast; news and analyst trends do not
          'cache-control': path === '/quote' ? 'public, max-age=30' : 'public, max-age=300'
        }
      });
    } catch (e) {
      return Response.json({
        error: 'upstream failed',
        detail: String(e)
      }, {
        status: 502
      });
    }
  };
} catch {}
const config = {
  path: '/api/finnhub'
};
Object.assign(__ds_scope, { __ds_default_netlify_functions_finnhub_wqyy4h, config });
})(); } catch (e) { __ds_ns.__errors.push({ path: "netlify/functions/finnhub.js", error: String((e && e.message) || e) }); }

})();
