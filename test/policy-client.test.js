import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = globalThis;
await import('../templates/shared/hif-policy.js');
const P = window.HIFPolicy;
const taxonomy = JSON.parse(readFileSync(new URL('../config/policy-taxonomy.json', import.meta.url), 'utf8'));

test('the browser knows every sector of the taxonomy, in three languages', () => {
  assert.deepEqual(Object.keys(P.SECTORS).sort(), Object.keys(taxonomy.sectors).sort());
  for (const [id, s] of Object.entries(taxonomy.sectors)) assert.deepEqual(P.SECTORS[id], s.label, id);
});

test('query: newest first, with the sector and company filters PostgREST understands', () => {
  assert.equal(P.query({}), 'policy_events?select=id,title,summary,event_date,institution,initiator,doc_number,source_url,status,stage,certainty,sectors,companies,figures&order=event_date.desc,id.desc&limit=200');
  const q = decodeURIComponent(P.query({ sector: 'petrol-gaze', ticker: 'SNP.RO', limit: 50 }));
  assert.ok(q.includes('sectors=cs.{petrol-gaze}'));
  assert.ok(q.includes('companies=cs.[{"ticker":"SNP.RO"}]'));
  assert.ok(q.endsWith('limit=50'));
  // Only known sectors and well-formed symbols get into the URL.
  assert.ok(!P.query({ sector: 'x}&drop', ticker: 'A"B' }).includes('drop'));
  assert.ok(!decodeURIComponent(P.query({ sector: 'x}&drop', ticker: 'A"B' })).includes('A"B'));
});

const ev = { companies: [{ ticker: 'SNP.RO', why: 'sector', sector: 'petrol-gaze' }, { ticker: 'H2O.RO', why: 'mentioned' }, { ticker: 'TLV.RO', why: 'sector', sector: 'banci-financiar' }] };

test('affects: the event\'s companies the reader follows or holds, with why', () => {
  assert.deepEqual(P.affects(ev, ['H2O.RO', 'AAPL'], { 'SNP.RO': { shares: 10 } }), [
    { ticker: 'SNP.RO', why: 'sector', sector: 'petrol-gaze', via: ['portfolio'] },
    { ticker: 'H2O.RO', why: 'mentioned', via: ['following'] }
  ]);
  assert.deepEqual(P.affects(ev, ['SNP.RO'], { 'SNP.RO': {} })[0].via, ['following', 'portfolio']);
  assert.deepEqual(P.affects(ev, [], {}), []);
  assert.deepEqual(P.affects({ companies: [] }, ['SNP.RO'], {}), []);
});

test('status and certainty labels are fixed per value, never taken from the text', () => {
  assert.equal(P.statusLabel('statement', 'ro'), 'Declarație / comunicat');
  assert.equal(P.statusLabel('draft', 'ro'), 'Proiect în procedură');
  assert.equal(P.statusLabel('adopted', 'en'), 'Adopted');
  assert.equal(P.statusLabel('stopped', 'de'), 'Verfahren beendet');
  assert.equal(P.statusLabel('anything', 'ro'), 'Statut necunoscut');
  assert.equal(P.certaintyLabel('official_statement', 'ro'), 'Comunicat oficial');
  assert.equal(P.certaintyLabel('official_act', 'en'), 'Official act');
});

test('search in titles and the status filter go to the server, cleaned', () => {
  const P = window.HIFPolicy;
  // Letters with diacritics match either spelling (ş/ș, ţ/ț), as one-character wildcards.
  assert.match(P.query({ q: 'acciza motorină' }), /&title=ilike\.\*acciza%20motorin_\*/);
  assert.match(P.query({ q: 'taxă şi' }), /&title=ilike\.\*tax_%20_i\*/);
  // PostgREST's own syntax characters never reach the filter.
  assert.match(P.query({ q: 'a*b,c(d)e.f:g' }), /&title=ilike\.\*abcdefg\*/);
  assert.doesNotMatch(P.query({ q: '   ' }), /title=/);
  assert.equal(P.query({ q: 'x'.repeat(200) }).match(/x+/)[0].length, 80);
  assert.match(P.query({ status: 'adopted' }), /&status=eq\.adopted/);
  assert.doesNotMatch(P.query({ status: 'rumour' }), /status=/);
});
