import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCdepList } from '../ingest/policy/cdep.mjs';
import { parseMfRss } from '../ingest/policy/mf.mjs';

const fx = n => readFileSync(new URL('./fixtures/policy/' + n, import.meta.url), 'utf8');

test('Chamber initiatives: who proposed it, where it stands, in the source\'s words', () => {
  const items = parseCdepList(fx('cdep-initiatives.html'), { kind: 'initiatives' });
  assert.equal(items.length, 8);
  const [gov, stopped, mps, noDate, law, toPromulgate, rejected, ccr] = items;
  assert.deepEqual({ id: gov.id, initiator: gov.initiator, doc: gov.doc_number, status: gov.status, stage: gov.stage, date: gov.event_date, cert: gov.certainty, inst: gov.institution },
    { id: 'cdep:22923', initiator: 'Guvern', doc: 'PL-x 1/02.02.2026', status: 'draft', stage: 'la Senat 25.02.2026', date: '2026-02-25', cert: 'official_procedure', inst: 'Camera Deputaților' });
  assert.equal(gov.source_url, 'https://www.cdep.ro/ords/pls/proiecte/upl_pck2015.proiect?cam=2&idp=22923');
  assert.match(gov.title, /^Proiect de Lege pentru aprobarea Ordonanţei de urgenţă/);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.initiator, 'Parlamentari');
  assert.equal(mps.status, 'draft');
  // An unknown stage stays a draft; without a stage date, the registration date is used.
  assert.equal(noDate.status, 'draft');
  assert.equal(noDate.stage, 'în dezbatere la comisii');
  assert.equal(noDate.event_date, '2025-10-06');
  // Passed: with a law number it is an official act; on its way to promulgation, a procedure.
  assert.deepEqual([law.status, law.certainty, law.doc_number, law.event_date], ['adopted', 'official_act', 'Lege 40/2026', '2026-03-12']);
  assert.deepEqual([toPromulgate.status, toPromulgate.certainty], ['adopted', 'official_procedure']);
  assert.equal(rejected.status, 'stopped');
  // A constitutional challenge is still a procedure, shown with its own wording.
  assert.deepEqual([ccr.status, ccr.stage], ['draft', 'sesizare de neconstitutionalitate 03.04.2026']);
});

test('Chamber promulgated laws: adopted, with the law\'s number and day', () => {
  const [law] = parseCdepList(fx('cdep-laws.html'), { kind: 'laws' });
  assert.deepEqual({ id: law.id, status: law.status, cert: law.certainty, doc: law.doc_number, date: law.event_date, stage: law.stage },
    { id: 'cdep:22591', status: 'adopted', cert: 'official_act', doc: 'Lege 2/2026', date: '2026-01-05', stage: 'promulgată: Lege 2/2026 05.01.2026' });
  assert.equal(law.law_url, 'https://www.cdep.ro/ords/pls/legis/legis_pck.htp_act?nr=2&an=2026');
});

test('a page whose table changed gives no rows (the run reports it), not garbage', () => {
  assert.deepEqual(parseCdepList('<html><body><p>Mentenanță</p></body></html>', { kind: 'laws' }), []);
});

test('Finance Ministry releases are statements, whatever their title says', () => {
  const items = parseMfRss(fx('mf.xml'));
  assert.equal(items.length, 3);  // the item without a link is dropped
  const [budget, excise, law] = items;
  assert.deepEqual({ id: budget.id, status: budget.status, cert: budget.certainty, inst: budget.institution, date: budget.event_date },
    { id: 'mf:20574560', status: 'statement', cert: 'official_statement', inst: 'Ministerul Finanțelor', date: '2026-10-16' });
  assert.equal(budget.summary, 'Datele operative la 9 luni: deficit de 3,82% din PIB, în scădere cu 1,53 puncte procentuale față de anul trecut');
  assert.equal(excise.initiator, 'Ministerul Finanțelor');
  // "Legea … a fost adoptată" in a press release is still a press release.
  assert.equal(law.status, 'statement');
  assert.equal(law.certainty, 'official_statement');
});

test('a Chamber row whose link is not a path on www.cdep.ro is skipped', () => {
  const html = '<table><tr><td>1.</td><td><a href="@evil.example/ords/pls/proiecte/upl_pck2015.proiect?cam=2&idp=1">PL-x 1/02.02.2026</a></td><td>Titlu</td><td>la Senat<br>25.02.2026</td></tr></table>';
  assert.deepEqual(parseCdepList(html, { kind: 'initiatives' }), []);
});
