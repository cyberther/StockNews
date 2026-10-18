// The public settings the apps need for Supabase sign-in: served by /api/config (Netlify,
// the Node server) or written to config.json by the Cloudflare Pages build.
//   SUPABASE_URL      = https://<project-ref>.supabase.co
//   SUPABASE_ANON_KEY = the project's anon (public) key
//   VAPID_PUBLIC_KEY  = the public half of the web-push key pair (supabase/README.md)
// Never set the service_role key in these: it bypasses row-level security. A key is
// published only if it is provably the public one (a legacy JWT whose role is 'anon', or a
// new-style publishable key); a secret key pasted into the wrong variable is withheld.
const URL_RE = /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i;

function b64urlJson(part) {
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((part.length + 3) % 4);
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0))));
}
export function isPublicKey(key) {
  if (/^sb_publishable_/.test(key)) return true;
  const parts = String(key || '').split('.');
  if (parts.length !== 3) return false;
  try { return b64urlJson(parts[1]).role === 'anon'; }
  catch { return false; }
}

export function publicConfig(env) {
  const url = env.SUPABASE_URL || '';
  const key = env.SUPABASE_ANON_KEY || '';
  const ok = URL_RE.test(url) && isPublicKey(key);
  // A P-256 public key is 65 bytes: 87 base64url characters.
  const vapid = env.VAPID_PUBLIC_KEY || '';
  return { supabaseUrl: ok ? url : null, supabaseAnonKey: ok ? key : null,
    // Market data comes from the ingestion tables now; kept for older app versions.
    liveData: ok || !!env.FINNHUB_KEY,
    vapidPublicKey: /^[A-Za-z0-9_-]{87}$/.test(vapid) ? vapid : null };
}
