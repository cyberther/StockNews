// Circuit breaker per provider, kept in public.ingest_provider_state between runs (each run
// is a fresh process). After 3 failures in a row a provider is skipped for 30 minutes; then
// one try is allowed, and another failure skips it again. Nothing is retried within a run.
export const THRESHOLD = 3;
export const COOLDOWN_MS = 30 * 60000;

export function createBreaker(rows, now = Date.now()) {
  const state = new Map((rows || []).map(r => [r.provider, { provider: r.provider, fails: r.fails || 0, open_until: r.open_until || null, reason: r.reason || null }]));
  const changed = new Set();
  const get = name => state.get(name) || { provider: name, fails: 0, open_until: null, reason: null };
  return {
    allowed(name) {
      const s = get(name);
      return !s.open_until || Date.parse(s.open_until) <= now;
    },
    success(name) {
      const s = get(name);
      if (s.fails === 0 && !s.open_until) return;
      state.set(name, { provider: name, fails: 0, open_until: null, reason: null });
      changed.add(name);
    },
    failure(name, reason) {
      const s = get(name), fails = s.fails + 1;
      state.set(name, { provider: name, fails, reason: String(reason || '').slice(0, 200),
        open_until: fails >= THRESHOLD ? new Date(now + COOLDOWN_MS).toISOString() : s.open_until });
      changed.add(name);
    },
    changes() { return [...changed].map(n => state.get(n)); }
  };
}
