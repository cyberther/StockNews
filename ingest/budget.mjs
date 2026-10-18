// Call budgets (config/budgets.json): per provider per day, across all runs (counted in
// public.ingest_usage), and per job per run. A call past a budget is refused; the run
// degrades (skips that work) and over() says why, for the alert.
export function createBudget(limits, usageRows, day) {
  const P = (limits && limits.providers) || {}, J = (limits && limits.jobs) || {};
  const before = new Map();
  (usageRows || []).filter(r => r.day === day).forEach(r => before.set(r.provider, (before.get(r.provider) || 0) + (r.calls || 0)));
  const taken = new Map(); // provider|job -> calls in this run
  const runTotal = new Map(); // job -> calls in this run
  const overs = new Set();
  const providerTotal = p => (before.get(p) || 0) + [...taken].filter(([k]) => k.startsWith(p + '|')).reduce((s, [, n]) => s + n, 0);
  return {
    take(provider, job, n = 1) {
      const pl = P[provider] && P[provider].perDay, jl = J[job] && J[job].perRun;
      if (pl != null && providerTotal(provider) + n > pl) { overs.add(`${provider}: ${pl}/day`); return false; }
      if (jl != null && (runTotal.get(job) || 0) + n > jl) { overs.add(`${job}: ${jl}/run`); return false; }
      taken.set(provider + '|' + job, (taken.get(provider + '|' + job) || 0) + n);
      runTotal.set(job, (runTotal.get(job) || 0) + n);
      return true;
    },
    over() { return [...overs]; },
    usage() { return [...taken].map(([k, calls]) => { const [provider, job] = k.split('|'); return { day, provider, job, calls }; }); }
  };
}
