import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const output = 'dist';
const directories = [
  'templates/shared',
  'templates/stock-news-dark',
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
  ''
].join('\n'));

console.log(`Built safe Netlify bundle in ${output}`);
