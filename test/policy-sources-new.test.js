// New act sources (Politici 2.0, Task 7; verdicts in LEGAL-SOURCES.md §6): the government's
// notes (each decision, with its financial impact section) and ordinances from the legislation
// portal. Laws keep coming from the Chamber; the Senate is deferred.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseGovNotes, GOV_NOTES_URL } from '../ingest/policy/gov.mjs';
import { parseJustSearch, justSearchBody, justTokenBody } from '../ingest/policy/just.mjs';
import { policySources } from '../ingest/policy/run.mjs';

const fx = p => readFileSync(new URL('./fixtures/policy/' + p, import.meta.url), 'utf8');
const shape = r => {
  for (const k of ['id', 'title', 'event_date', 'institution', 'source_url', 'status', 'stage', 'certainty']) assert.ok(r[k], k + ' of ' + r.id);
  assert.match(r.source_url, /^https:\/\//);
  assert.match(r.event_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(r.id, /^[a-z]{2,10}:[A-Za-z0-9._-]{1,60}$/);
};

test('government notes: one adopted decision per note, its number, date and subject', () => {
  const rows = parseGovNotes(fx('gov/note-list.html'));
  assert.ok(rows.length >= 5);
  rows.forEach(shape);
  const hg = rows.find(r => r.id === 'gov:hg-781-2026');
  assert.ok(hg, rows.map(r => r.id).join());
  assert.equal(hg.event_date, '2026-10-01');
  assert.equal(hg.doc_number, 'HG 781/2026');
  assert.equal(hg.status, 'adopted');
  assert.equal(hg.certainty, 'official_act');
  assert.equal(hg.institution, 'Guvernul României');
  assert.match(hg.title, /^HG 781\/2026: /);
  assert.ok(!/&acirc;|<|Nota de Fundamentare/.test(hg.title));
  assert.equal(hg.source_url, 'https://gov.ro/ro/guvernul/procesul-legislativ/note-de-fundamentare/nota-de-fundamentare-hg-nr-781-01-10-2026');
  assert.match(GOV_NOTES_URL, /^https:\/\/gov\.ro\//);
});

test('the legislation portal: emergency and simple ordinances only, in force or adopted', () => {
  const rows = parseJustSearch(fx('just/search-oug-2026.xml'), { now: new Date('2026-10-19T00:00:00Z') });
  assert.deepEqual(rows.map(r => r.doc_number), ['OUG 38/2026', 'OUG 20/2026', 'OUG 17/2026']);
  rows.forEach(shape);
  const o = rows[1];
  assert.match(o.id, /^just:\d+$/);
  assert.equal(o.status, 'in_force');
  assert.equal(o.institution, 'Guvernul României');
  assert.match(o.title, /^OUG 20\/2026: privind unele măsuri pentru decarbonizarea sectorului energetic$/);
  assert.match(o.source_url, /^https:\/\/legislatie\.just\.ro\/Public\/DetaliiDocument\/\d+$/);
  // Laws are not taken from here (the Chamber lists them).
  assert.deepEqual(parseJustSearch(fx('just/search-2026.xml'), { now: new Date('2026-10-19T00:00:00Z') }), []);
});

test('SOAP requests are plain envelopes with the token; the sources list includes the new ones', () => {
  assert.match(justTokenBody(), /<GetToken xmlns="http:\/\/tempuri\.org\/"\/>/);
  const b = justSearchBody('TOKEN<x>', 'ordonanta de urgenta', 2026, 1, 50);
  assert.match(b, /<a:NumarPagina>1<\/a:NumarPagina><a:RezultatePagina>50<\/a:RezultatePagina><a:SearchAn>2026<\/a:SearchAn>/);
  assert.match(b, /<tokenKey>TOKEN&lt;x&gt;<\/tokenKey>/);
  const names = policySources(new Date('2026-10-19T00:00:00Z')).map(s => s.name);
  assert.ok(names.includes('gov-notes'));
  assert.ok(names.includes('just-ordinances'));
});

test('each new source has its document: the government note page, the act on the portal', async () => {
  const { documentLinks } = await import('../ingest/policy/documents.mjs');
  assert.deepEqual(documentLinks({ id: 'gov:hg-781-2026', source_url: 'https://gov.ro/n' }, ''), [{ kind: 'note', url: 'https://gov.ro/n' }]);
  assert.deepEqual(documentLinks({ id: 'just:313249', source_url: 'https://legislatie.just.ro/Public/DetaliiDocument/313249' }, ''),
    [{ kind: 'act', url: 'https://legislatie.just.ro/Public/DetaliiDocument/313249' }]);
});
