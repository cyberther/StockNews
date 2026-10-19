// The daily policy run (ingest/main.mjs --job=policy, and inside the eod job): reads the
// official sources, classifies each event, and writes to Supabase only what is new or changed,
// with a history line for every change of status or stage. Nothing is ever deleted: a source
// that fails or returns no rows is reported and its events stay as they were.
import { parseGovNotes, GOV_NOTES_URL } from './gov.mjs';
import { parseJustSearch, loadJust } from './just.mjs';
import { parseCdepList, cdepUrl } from './cdep.mjs';
import { parseMfRss, MF_RSS } from './mf.mjs';
import { classify } from './classify.mjs';

const MAX_BYTES = 2 * 1024 * 1024;
const UA = 'Mozilla/5.0 (compatible; MarketPulsePolicy/1.0; +https://github.com/cyberther/StockNews)';

export function policySources(now) {
  const year = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Bucharest', year: 'numeric' }).format(now));
  const cdep = y => [
    { name: `cdep-initiatives-${y}`, url: cdepUrl('initiatives', y), relay: true, parse: h => parseCdepList(h, { kind: 'initiatives' }) },
    { name: `cdep-laws-${y}`, url: cdepUrl('laws', y), relay: true, parse: h => parseCdepList(h, { kind: 'laws' }) }
  ];
  return [...cdep(year), ...cdep(year - 1), { name: 'mf-press', url: MF_RSS, parse: parseMfRss }];
}
// Sources only the owner's PC reaches (gov.ro and legislatie.just.ro answer neither GitHub nor
// Supabase): read by tools/policy-auto-batch.mjs, saved through events_save.
export function pcPolicySources(now) {
  return [{ name: 'gov-notes', url: GOV_NOTES_URL, parse: parseGovNotes },
    { name: 'just-ordinances', load: fetchImpl => loadJust({ now, fetchImpl }), parse: x => parseJustSearch(x, { now }) }];
}

export async function fetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html, application/rss+xml, application/xml' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const body = await res.text();
  if (body.length > MAX_BYTES) throw new Error('too large');
  return body;
}

// www.cdep.ro does not answer GitHub's runners (connect timeout), but does answer Supabase:
// there, its pages are fetched by the database (pg_net, supabase/policy-relay.sql, which only
// accepts the Chamber's list URLs) and read back when the answer is in.
export function relayFetch(db, { intervalMs = 1000, timeoutMs = 45000 } = {}) {
  return async url => {
    const id = await db.rpc('policy_fetch_start', { p_url: url });
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      await new Promise(r => setTimeout(r, intervalMs));
      const rows = await db.rpc('policy_fetch_result', { p_id: id });
      const r = Array.isArray(rows) ? rows[0] : rows;
      if (!r) continue;
      if (r.timed_out) throw new Error('relay timed out');
      if (r.status_code !== 200) throw new Error('relay HTTP ' + (r.status_code || 0) + (r.error_msg ? ' ' + String(r.error_msg).slice(0, 120) : ''));
      return r.content || '';
    }
    throw new Error('relay: no answer in ' + Math.round(timeoutMs / 1000) + ' s');
  };
}

const KEEP = ['title', 'summary', 'event_date', 'institution', 'initiator', 'doc_number', 'source_url', 'status', 'stage', 'certainty', 'sectors', 'caen', 'companies', 'figures'];
// Compared with object keys sorted: Postgres jsonb stores them in its own order.
const canon = v => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v ?? null;
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

// The sources' rows, one per id, each classified (sectors, companies, figures).
export async function collectEvents({ sources, fetchText: get = fetchText, fetchImpl = fetch, relay = null, taxonomy, catalog }) {
  const errors = [], found = new Map();
  // Laws come after initiatives in the list, so an initiative that became law ends up as the law.
  for (const src of sources) {
    try {
      const rows = src.parse(src.load ? await src.load(fetchImpl) : await (src.relay && relay ? relay : get)(src.url));
      if (!rows.length) { errors.push(`${src.name}: no rows`); continue; }
      for (const r of rows) {
        const prev = found.get(r.id);
        if (prev && prev.status === 'adopted' && r.status !== 'adopted') continue;
        found.set(r.id, r);
      }
    } catch (e) {
      // fetch() says only "fetch failed"; the cause (timeout, refused, TLS) is what helps.
      const c = e.cause, why = c ? [c.code, c.message].filter(Boolean).join(' ') : '';
      errors.push(`${src.name}: ${e.message}${why ? ' (' + why.slice(0, 160) + ')' : ''}`);
    }
  }

  const rows = [...found.values()].map(item => ({ id: item.id, country: 'RO', summary: null, ...Object.fromEntries(KEEP.map(k => [k, item[k] ?? null])),
    ...classify([item.title, item.summary].filter(Boolean).join('. '), taxonomy, catalog) }));
  return { rows, errors };
}

export async function runPolicy({ db, fetchText: get = fetchText, fetchImpl = fetch, relay = null, now = new Date(), taxonomy, catalog, sources = policySources(now) }) {
  const { rows, errors } = await collectEvents({ sources, fetchText: get, fetchImpl, relay, taxonomy, catalog });
  const existing = new Map((await db.read('policy_events', 'select=' + ['id', ...KEEP].join(','))).map(r => [r.id, r]));
  const at = now.toISOString(), upserts = [], history = [];
  let created = 0, changed = 0;
  for (const row of rows) {
    const item = row;
    const old = existing.get(item.id);
    if (!old) {
      created++;
      upserts.push({ ...row, first_seen: at, updated_at: at });
      history.push({ event_id: item.id, changed_at: at, field: 'status', old_value: null, new_value: row.status });
      continue;
    }
    if (KEEP.every(k => same(old[k], row[k]))) continue;
    changed++;
    upserts.push({ ...row, updated_at: at });
    for (const f of ['status', 'stage']) if (!same(old[f], row[f])) history.push({ event_id: item.id, changed_at: at, field: f, old_value: old[f], new_value: row[f] });
  }
  // New rows carry first_seen and changed ones don't: PostgREST wants one set of keys per request.
  for (const part of [upserts.filter(r => r.first_seen), upserts.filter(r => !r.first_seen)])
    for (let i = 0; i < part.length; i += 500) await db.upsert('policy_events', part.slice(i, i + 500), { onConflict: 'id' });
  if (history.length) await db.insert('policy_event_history', history);
  return { events: rows.length, created, changed, errors };
}
