// The static site, for Netlify (netlify.toml) and Cloudflare Pages (build settings in its dashboard: docs/phase-a-setup.md).
//
//   node scripts/build.mjs           -> dist/ (BUILD_OUT to change it)
//
// Cloudflare Pages sets CF_PAGES=1 in its builds; those also get config.json (the public
// Supabase settings, so no function runs per visitor to serve them) and a lower-case
// forwarding page for old links. Netlify builds don't: its secret scan fails a build whose
// output repeats an environment value, and it serves paths in any case anyway.
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { greenBuild } from './green-build.mjs';
import { publicConfig } from '../netlify/functions/_shared/public-config.js';

const output = process.env.BUILD_OUT || 'dist';
const cloudflare = process.env.CF_PAGES === '1';
// The mobile app (templates/stock-news-dark) stays in the repo but is not published: work
// continues on the web app only, and its old Security screen still offers a two-factor
// setup that the server never enforced.
const directories = [
  'templates/shared',
  'templates/stock-news-web',
];

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

for (const directory of directories) {
  cpSync(directory, join(output, directory), { recursive: true });
}

// Security headers for every page and function response: the same policy as the
// self-hosted server (server/server.js). Nothing is loaded from other sites; the only
// outside connection is Supabase (sign-in, watchlist, summaries), whose host comes from the
// site's SUPABASE_URL. Written as a host, not the full URL: the address is public (/api/config
// serves it), but Netlify's secret scan fails a build whose output repeats an env value. A
// host source allows the page's own scheme, https.
// The component runtime compiles its templates in the browser: 'unsafe-eval', 'unsafe-inline'.
const m = /^https:\/\/([a-z0-9-]+\.supabase\.co)\/?$/i.exec(process.env.SUPABASE_URL || '');
const supabase = m ? m[1] : '*.supabase.co';
const csp = [
  "default-src 'self'", "base-uri 'none'", "object-src 'none'", "frame-ancestors 'none'", "form-action 'self'",
  "img-src 'self' data: blob:", "font-src 'self' data: blob:", "style-src 'self' 'unsafe-inline' blob:",
  // React is served from the site (templates/shared/vendor/), so no outside script source.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:", `connect-src 'self' data: blob: ${supabase}`,
  "worker-src 'self' blob:", "manifest-src 'self'"
].join('; ');
writeFileSync(join(output, '_headers'), [
  '/*',
  `  Content-Security-Policy: ${csp}`,
  '  X-Content-Type-Options: nosniff',
  '  X-Frame-Options: DENY',
  '  Referrer-Policy: strict-origin-when-cross-origin',
  '  Permissions-Policy: geolocation=(), camera=(), microphone=(), payment=(), usb=()',
  '  Cross-Origin-Opener-Policy: same-origin',
  '  X-Permitted-Cross-Domain-Policies: none',
  // The home-screen manifest: with nosniff, browsers only read it under its own type.
  '/templates/stock-news-web/manifest.webmanifest',
  '  Content-Type: application/manifest+json',
  '/manifest.webmanifest',
  '  Content-Type: application/manifest+json',
  ''
].join('\n'));

// Clean addresses (the same as netlify.toml's, which Netlify applies first): the app at / and
// /login, the legal page at /legal, the methodology and accuracy page at /metodologie (and
// /methodology), the scenario calculator at /calculator, all served in place
// (200). The pages' relative files (./assets, ./support.js, ../shared/...) then resolve from the
// site root, so those paths are served too. Cloudflare drops .html from page paths (and
// redirects to the short form), so its targets are written without it.
const page = name => `/templates/stock-news-web/${name}${cloudflare ? '' : '.html'}`;
writeFileSync(join(output, '_redirects'), [
  `/ ${page('StockNewsWeb.dc')} 200`,
  `/login ${page('StockNewsWeb.dc')} 200`,
  `/legal ${page('legal')} 200`,
  `/metodologie ${page('methodology')} 200`,
  `/methodology ${page('methodology')} 200`,
  `/calculator ${page('intelligence')} 200`,
  '/shared/* /templates/shared/:splat 200',
  '/assets/* /templates/stock-news-web/assets/:splat 200',
  '/ds-base.js /templates/stock-news-web/ds-base.js 200',
  '/support.js /templates/stock-news-web/support.js 200',
  '/manifest.webmanifest /templates/stock-news-web/manifest.webmanifest 200',
  '/mobile / 301',
  '/templates/stock-news-dark/* / 301',
  ''
].join('\n'));
// Cloudflare Pages: functions only for /api/*, so pages and assets never count against the
// free plan's daily function requests.
writeFileSync(join(output, '_routes.json'), JSON.stringify({ version: 1, include: ['/api/*'], exclude: [] }));

if (cloudflare) {
  writeFileSync(join(output, 'config.json'), JSON.stringify(publicConfig(process.env)));
  writeFileSync(join(output, 'templates/stock-news-web/stocknewsweb.dc.html'),
    '<!doctype html><meta charset="utf-8"><title>Market Pulse</title>' +
    "<script>location.replace('StockNewsWeb.dc.html' + location.search + location.hash)</script>" +
    '<a href="StockNewsWeb.dc.html">Market Pulse</a>\n');
}

greenBuild(output);
console.log(`Built ${cloudflare ? 'Cloudflare Pages' : 'Netlify'} bundle in ${output}`);
