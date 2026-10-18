// The daily policy run (ingest/main.mjs --job=policy, and inside the eod job): reads the
// official sources, classifies each event, and writes to Supabase only what is new or changed,
// with a history line for every change of status or stage. Nothing is ever deleted: a source
// that fails or returns no rows is reported and its events stay as they were.
import { parseCdepList, cdepUrl } from './cdep.mjs';
import { parseMfRss, MF_RSS } from './mf.mjs';
import { classify } from './classify.mjs';

const MAX_BYTES = 2 * 1024 * 1024;
const UA = 'Mozilla/5.0 (compatible; MarketPulsePolicy/1.0; +https://github.com/cyberther/StockNews)';

export function policySources(now) {
  const year = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Bucharest', year: 'numeric' }).format(now));
  const cdep = y => [
    { name: `cdep-initiatives-${y}`, url: cdepUrl('initiatives', y), parse: h => parseCdepList(h, { kind: 'initiatives' }) },
    { name: `cdep-laws-${y}`, url: cdepUrl('laws', y), parse: h => parseCdepList(h, { kind: 'laws' }) }
  ];
  return [...cdep(year), ...cdep(year - 1), { name: 'mf-press', url: MF_RSS, parse: parseMfRss }];
}

export async function fetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html, application/rss+xml, application/xml' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const body = await res.text();
  if (body.length > MAX_BYTES) throw new Error('too large');
  return body;
}

const KEEP = ['title', 'summary', 'event_date', 'institution', 'initiator', 'doc_number', 'source_url', 'status', 'stage', 'certainty', 'sectors', 'caen', 'companies', 'figures'];
// Compared with object keys sorted: Postgres jsonb stores them in its own order.
const canon = v => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v ?? null;
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

export async function runPolicy({ db, fetchText: get = fetchText, now = new Date(), taxonomy, catalog }) {
  const errors = [], found = new Map();
  // Laws come after initiatives in the list, so an initiative that became law ends up as the law.
  for (const src of policySources(now)) {
    try {
      const rows = src.parse(await get(src.url));
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

  const existing = new Map((await db.read('policy_events', 'select=' + ['id', ...KEEP].join(','))).map(r => [r.id, r]));
  const at = now.toISOString(), upserts = [], history = [];
  let created = 0, changed = 0;
  for (const item of found.values()) {
    const c = classify([item.title, item.summary].filter(Boolean).join('. '), taxonomy, catalog);
    const row = { id: item.id, country: 'RO', summary: null, ...Object.fromEntries(KEEP.map(k => [k, item[k] ?? null])), ...c };
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
  for (let i = 0; i < upserts.length; i += 500) await db.upsert('policy_events', upserts.slice(i, i + 500), { onConflict: 'id' });
  if (history.length) await db.insert('policy_event_history', history);
  return { events: found.size, created, changed, errors };
}
