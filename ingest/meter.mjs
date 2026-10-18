// Counts every outside HTTP request a run makes, per provider, for public.ingest_runs and
// the before/after measurements. Requests to our own Supabase are not counted.
export function countingFetch(inner = globalThis.fetch) {
  const counts = {};
  const providerOf = host => /(^|\.)yahoo\.com$/.test(host) ? 'yahoo' : /\.supabase\.co$/.test(host) ? null : 'feeds';
  return {
    fetch(input, init) {
      const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      let host = '';
      try { host = new URL(u).hostname; } catch { /* counted as feeds */ }
      const p = providerOf(host);
      if (p) counts[p] = (counts[p] || 0) + 1;
      return inner(input, init);
    },
    counts: () => ({ ...counts })
  };
}
