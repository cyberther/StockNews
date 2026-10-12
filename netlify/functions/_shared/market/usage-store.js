// Shared usage counters in Supabase (supabase/usage.sql). Calls the two RPCs with the
// project's public key plus USAGE_SECRET, which can only add to and read the counters.
// Returns null when not configured; the gateway then counts per instance only.
const URL_RE = /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i;

export function supabaseUsageStore({ url, anonKey, secret } = {}) {
  if (!url || !URL_RE.test(url) || !anonKey || !secret || secret.length < 32) return null;
  const base = url.replace(/\/$/, '') + '/rest/v1/rpc/';
  const call = async (fn, body) => {
    const res = await fetch(base + fn, {
      method: 'POST',
      headers: { apikey: anonKey, authorization: 'Bearer ' + anonKey, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4000)
    });
    if (!res.ok) throw new Error('usage store ' + res.status);
    return res.status === 204 ? null : res.json();
  };
  return {
    // rows: [{ provider, calls, rate_limited, errors }]
    bump: rows => call('market_usage_bump', { p_secret: secret, p_rows: rows }),
    // -> [{ provider, day, calls, rate_limited, errors, last_rate_limited_at, last_error_at }]
    read: days => call('market_usage_read', { p_secret: secret, p_days: days || 7 })
  };
}

export const usageStoreFromEnv = env => supabaseUsageStore({
  url: env.SUPABASE_URL, anonKey: env.SUPABASE_ANON_KEY, secret: env.USAGE_SECRET
});
