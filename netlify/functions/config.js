// Netlify Function: the public config the apps need for Supabase sign-in, mirroring
// GET /api/config on the Node server.
//
// Setup: Netlify → Project configuration → Environment variables:
//   SUPABASE_URL      = https://<project-ref>.supabase.co
//   SUPABASE_ANON_KEY = the project's anon (public) key
// Both are designed to be public. Never set the service_role key here: it bypasses
// row-level security. Without these two, the apps fall back to their demo sign-in.
//   VAPID_PUBLIC_KEY  = the public half of the web-push key pair (supabase/README.md);
//                       without it the apps hide the push-alert switch.
//   LIVE_RELAY_URL    = the live chart relay on the PC (tools/live-relay.mjs), its Tailscale
//                       Funnel address, e.g. https://pc.tailnet.ts.net; without it the chart
//                       page has no second bars.
const URL_RE = /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i;

// Publish a key only if it is provably the public one: a legacy JWT whose role is
// 'anon', or a new-style publishable key. A service_role / secret key pasted into the
// wrong variable is withheld instead of being served to every visitor.
function isPublicKey(key) {
  if (/^sb_publishable_/.test(key)) return true;
  const parts = key.split('.');
  if (parts.length !== 3) return false;
  try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).role === 'anon'; }
  catch { return false; }
}

export default async () => {
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_ANON_KEY || '';
  const ok = URL_RE.test(url) && isPublicKey(key);
  // A P-256 public key is 65 bytes: 87 base64url characters.
  const vapid = process.env.VAPID_PUBLIC_KEY || '';
  const relay = String(process.env.LIVE_RELAY_URL || '').replace(/\/$/, '');
  return Response.json(
    { supabaseUrl: ok ? url : null, supabaseAnonKey: ok ? key : null, liveData: !!process.env.FINNHUB_KEY,
      vapidPublicKey: /^[A-Za-z0-9_-]{87}$/.test(vapid) ? vapid : null,
      liveRelay: /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(relay) ? relay : null },
    { headers: { 'cache-control': 'public, max-age=300' } }
  );
};

export const config = { path: '/api/config' };
