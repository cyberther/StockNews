// Netlify Function: the public config the apps need for Supabase sign-in, mirroring
// GET /api/config on the Node server.
//
// Setup: Netlify → Project configuration → Environment variables:
//   SUPABASE_URL      = https://<project-ref>.supabase.co
//   SUPABASE_ANON_KEY = the project's anon (public) key
// Both are designed to be public. Never set the service_role key here: it bypasses
// row-level security. Without these two, the apps fall back to their demo sign-in.
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
  return Response.json(
    { supabaseUrl: ok ? url : null, supabaseAnonKey: ok ? key : null, liveData: !!process.env.FINNHUB_KEY },
    { headers: { 'cache-control': 'public, max-age=300' } }
  );
};

export const config = { path: '/api/config' };
