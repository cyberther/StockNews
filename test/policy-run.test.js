import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runPolicy, policySources } from '../ingest/policy/run.mjs';
import { bvbCatalog } from '../ingest/policy/classify.mjs';

const fx = n => readFileSync(new URL('./fixtures/policy/' + n, import.meta.url), 'utf8');
const taxonomy = JSON.parse(readFileSync(new URL('../config/policy-taxonomy.json', import.meta.url), 'utf8'));
const catalog = bvbCatalog();
const NOW = new Date('2026-10-19T21:40:00Z');

function fakeDb(events = []) {
  const t = { policy_events: events.map(e => ({ ...e })), policy_event_history: [], ingest_runs: [] };
  return { t,
    async read(table) { return t[table].map(r => ({ ...r })); },
    async upsert(table, rows) { for (const r of rows) { const i = t[table].findIndex(x => x.id === r.id); if (i < 0) t[table].push({ ...r }); else t[table][i] = { ...t[table][i], ...r }; } return rows; },
    async insert(table, rows) { t[table].push(...rows); return rows; } };
}
// The fixtures stand in for this year's lists; last year's lists are empty pages.
function fetcher(over = {}) {
  const calls = [];
  const pages = { initiatives2026: fx('cdep-initiatives.html'), laws2026: fx('cdep-laws.html'), initiatives2025: '<table></table>', laws2025: '<table></table>', mf: fx('mf.xml'), ...over };
  const fetchText = async url => {
    calls.push(url);
    const key = /anp=(\d+)/.test(url) ? 'initiatives' + RegExp.$1 : /anl=(\d+)/.test(url) ? 'laws' + RegExp.$1 : /mfinante/.test(url) ? 'mf' : '?';
    const v = pages[key];
    if (v instanceof Error) throw v;
    return v;
  };
  return { calls, fetchText };
}
const args = (db, f) => ({ db, fetchText: f.fetchText, now: NOW, taxonomy, catalog });

test('sources: this year\'s and last year\'s Chamber lists, and the ministry\'s releases', () => {
  assert.deepEqual(policySources(NOW).map(s => s.name), ['cdep-initiatives-2026', 'cdep-laws-2026', 'cdep-initiatives-2025', 'cdep-laws-2025', 'mf-press']);
});

test('first run: every event stored, classified, with its first history line', async () => {
  const db = fakeDb(), f = fetcher();
  const s = await runPolicy(args(db, f));
  assert.equal(f.calls.length, 5);
  const by = Object.fromEntries(db.t.policy_events.map(e => [e.id, e]));
  // PL-x 320/06.10.2025 is on both lists: one event, adopted, the law's number.
  assert.equal(by['cdep:22591'].status, 'adopted');
  assert.equal(by['cdep:22591'].doc_number, 'Lege 2/2026');
  assert.ok(by['cdep:22591'].sectors.includes('asigurari-pensii'));
  assert.equal(by['mf:20571111'].status, 'statement');
  assert.ok(by['mf:20571111'].companies.some(c => c.ticker === 'SNP.RO' && c.why === 'sector'));
  assert.deepEqual(by['mf:20574560'].figures[0], { kind: 'percent', value: 3.82, unit: '% din PIB', text: '3,82% din PIB' });
  assert.equal(s.created, db.t.policy_events.length);
  assert.equal(db.t.policy_event_history.filter(h => h.event_id === 'cdep:22591').length, 1);
  assert.deepEqual(s.errors, ['cdep-initiatives-2025: no rows', 'cdep-laws-2025: no rows']);
});

test('a second run with nothing new writes nothing', async () => {
  const db = fakeDb(), f = fetcher();
  await runPolicy(args(db, f));
  const before = JSON.stringify(db.t.policy_events), history = db.t.policy_event_history.length;
  const s = await runPolicy(args(db, f));
  assert.equal(s.changed, 0);
  assert.equal(s.created, 0);
  assert.equal(JSON.stringify(db.t.policy_events), before);
  assert.equal(db.t.policy_event_history.length, history);
});

test('a stage change updates the event and appends to its history', async () => {
  const db = fakeDb(), f = fetcher();
  await runPolicy(args(db, f));
  const moved = fx('cdep-initiatives.html').replace('la Senat\n<br>25.02.2026', 'la promulgare\n<br>10.10.2026');
  const s = await runPolicy(args(db, fetcher({ initiatives2026: moved })));
  const ev = db.t.policy_events.find(e => e.id === 'cdep:22923');
  assert.equal(ev.status, 'adopted');
  assert.equal(ev.event_date, '2026-10-10');
  assert.equal(s.changed, 1);
  const h = db.t.policy_event_history.filter(x => x.event_id === 'cdep:22923').map(x => [x.field, x.old_value, x.new_value]);
  assert.deepEqual(h, [['status', null, 'draft'], ['status', 'draft', 'adopted'], ['stage', 'la Senat 25.02.2026', 'la promulgare 10.10.2026']]);
});

test('a source that fails or comes back empty is reported; nothing is deleted', async () => {
  const db = fakeDb(), f = fetcher();
  await runPolicy(args(db, f));
  const n = db.t.policy_events.length;
  const s = await runPolicy(args(db, fetcher({ initiatives2026: '<html>maintenance</html>', mf: new Error('timeout') })));
  assert.equal(db.t.policy_events.length, n);
  assert.ok(s.errors.includes('cdep-initiatives-2026: no rows'));
  assert.ok(s.errors.includes('mf-press: timeout'));
});

test('rows read back from Postgres (jsonb reorders object keys) do not count as changed', async () => {
  const db = fakeDb(), f = fetcher();
  await runPolicy(args(db, f));
  // jsonb stores object keys shortest first: {"why":…,"ticker":…}
  const reorder = v => Array.isArray(v) ? v.map(reorder) : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.length - b.length || a.localeCompare(b)).map(([k, x]) => [k, reorder(x)])) : v;
  db.t.policy_events = db.t.policy_events.map(e => ({ ...e, companies: reorder(e.companies), figures: reorder(e.figures) }));
  const s = await runPolicy(args(db, f));
  assert.equal(s.changed, 0);
});

test('a network failure reports its cause, not just "fetch failed"', async () => {
  const db = fakeDb();
  const err = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ETIMEDOUT 1.2.3.4:443'), { code: 'ETIMEDOUT' }) });
  const s = await runPolicy(args(db, fetcher({ laws2026: err })));
  assert.ok(s.errors.includes('cdep-laws-2026: fetch failed (ETIMEDOUT connect ETIMEDOUT 1.2.3.4:443)'), s.errors.join('|'));
});

import { relayFetch } from '../ingest/policy/run.mjs';

test('relay: the Chamber pages through Supabase (pg_net), polled until the answer is in', async () => {
  const calls = [];
  let polls = 0;
  const db = { async rpc(name, args) {
    calls.push([name, args]);
    if (name === 'policy_fetch_start') return 42;
    if (name === 'policy_fetch_result') return ++polls < 3 ? [] : [{ status_code: 200, timed_out: false, error_msg: null, content: '<table>ok</table>' }];
  } };
  const get = relayFetch(db, { intervalMs: 1, timeoutMs: 1000 });
  assert.equal(await get('https://www.cdep.ro/ords/pls/proiecte/upl_pck2015.lista?anl=2026'), '<table>ok</table>');
  assert.deepEqual(calls[0], ['policy_fetch_start', { p_url: 'https://www.cdep.ro/ords/pls/proiecte/upl_pck2015.lista?anl=2026' }]);
  assert.deepEqual(calls[1], ['policy_fetch_result', { p_id: 42 }]);
});

test('relay: an HTTP error, a timeout or no answer in time is an error', async () => {
  const mk = row => relayFetch({ async rpc(n) { return n === 'policy_fetch_start' ? 7 : row ? [row] : []; } }, { intervalMs: 1, timeoutMs: 20 });
  await assert.rejects(mk({ status_code: 503, timed_out: false, content: '' })('https://www.cdep.ro/x'), /HTTP 503/);
  await assert.rejects(mk({ status_code: null, timed_out: true, content: null })('https://www.cdep.ro/x'), /timed out/);
  await assert.rejects(mk(null)('https://www.cdep.ro/x'), /no answer/);
});

test('with a relay, only the Chamber pages go through it; the ministry is fetched directly', async () => {
  const relayed = [], direct = [];
  const pages = { anp: fx('cdep-initiatives.html'), anl: fx('cdep-laws.html') };
  const db = fakeDb();
  const s = await runPolicy({ ...args(db, { fetchText: async u => { direct.push(u); return fx('mf.xml'); } }),
    relay: async u => { relayed.push(u); return /anp=2026/.test(u) ? pages.anp : /anl=2026/.test(u) ? pages.anl : '<table></table>'; } });
  assert.equal(relayed.length, 4);
  assert.equal(direct.length, 1);
  assert.ok(/mfinante/.test(direct[0]));
  assert.ok(s.events > 3);
});
