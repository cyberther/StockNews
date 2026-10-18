// Daily health check (.github/workflows/health.yml): did yesterday's scheduled runs happen,
// did they work, and is the Supabase project awake? Problems become a GitHub issue.
//
//   node ingest/health.mjs [--day=YYYY-MM-DD]   (default: yesterday, UTC)
//
// GitHub may delay or drop scheduled runs when busy, so runs are counted, not matched to
// their slots: fewer than 70% of the expected intraday runs is a problem.
import { fileURLToPath } from 'node:url';

// Must match .github/workflows/ingest.yml.
export const CRON = { minutes: [7, 22, 37, 52], hours: [7, 21] };
const MIN_SHARE = 0.7, MAX_FAILED_SHARE = 0.25;

export function expectedSlots(day) {
  const d = new Date(day + 'T00:00:00Z'), wd = d.getUTCDay();
  if (wd === 0 || wd === 6) return [];
  const out = [];
  for (let h = CRON.hours[0]; h <= CRON.hours[1]; h++)
    for (const m of CRON.minutes) out.push(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m)).toISOString());
  return out;
}

export function checkRuns(day, runs) {
  const slots = expectedSlots(day);
  if (!slots.length) return [];
  const problems = [], mine = runs.filter(r => String(r.started_at).slice(0, 10) === day);
  const intraday = mine.filter(r => r.job === 'intraday').length;
  if (intraday < Math.ceil(slots.length * MIN_SHARE)) problems.push(`intraday: ${intraday} of ${slots.length} expected runs`);
  if (!mine.some(r => r.job === 'eod')) problems.push('eod: no run');
  const failed = mine.filter(r => !r.ok).length;
  if (failed && failed > mine.length * MAX_FAILED_SHARE) problems.push(`${failed} runs reported errors (see ingest_runs.errors)`);
  return problems;
}

async function main() {
  const { createDb } = await import('./supabase.mjs');
  const { writeFileSync } = await import('node:fs');
  const arg = process.argv.find(a => a.startsWith('--day='));
  const day = arg ? arg.slice(6) : new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const problems = [];
  let runs = [];
  try {
    const db = createDb({ url: String(process.env.SUPABASE_URL || '').trim(), key: String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim() });
    // Also keeps a free-tier project active: it pauses after 7 days without activity.
    const next = new Date(Date.parse(day + 'T00:00:00Z') + 86400000).toISOString();
    runs = await db.read('ingest_runs', `select=job,started_at,ok&started_at=gte.${day}T00:00:00Z&started_at=lt.${encodeURIComponent(next)}`);
  } catch (e) {
    problems.push('Supabase unreachable: ' + e.message + ' (a free project pauses after 7 days without activity: Dashboard → Restore)');
  }
  if (!problems.length) problems.push(...checkRuns(day, runs));
  const out = { day, runs: runs.length, problems };
  console.log(JSON.stringify(out, null, 2));
  writeFileSync('health.json', JSON.stringify(out));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
