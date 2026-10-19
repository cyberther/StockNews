// The documents behind policy events (ingest/policy/documents.mjs): which links of a Chamber
// project page matter, their text (PDF via pdftotext, HTML), one bundle per event, and the base
// fact sheet every event gets before the local batch reads it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { documentLinks, extractText, bundle, baseSheet, MAX_PDF_BYTES } from '../ingest/policy/documents.mjs';
import { pdf } from './helpers/tiny-pdf.js';

const page = readFileSync(new URL('./fixtures/policy/cdep-project-23446.html', import.meta.url), 'utf8');
const cdepEvent = { id: 'cdep:23446', source_url: 'https://www.cdep.ro/ords/pls/proiecte/upl_pck2015.proiect?cam=2&idp=23446', institution: 'Camera Deputaților',
  status: 'adopted', stage: 'promulgată: Lege 162/2026 04.08.2026', event_date: '2026-08-04', sectors: ['petrol-gaze'], companies: [{ ticker: 'SNP.RO', why: 'mentioned' }],
  title: 'Proiect de Lege privind declararea situaţiei de criză pe piaţa ţiţeiului', summary: '' };

test('a Chamber project page: explanatory memorandum, Fiscal Council opinion and the law, no committee papers', () => {
  const links = documentLinks(cdepEvent, page);
  const kinds = links.map(l => l.kind);
  assert.ok(kinds.includes('motive'));
  assert.ok(kinds.includes('fiscal_council'));
  assert.ok(kinds.includes('law'));
  assert.ok(links.every(l => l.url.startsWith('https://www.cdep.ro/')));
  assert.equal(links.find(l => l.kind === 'law').url, 'https://www.cdep.ro/ords/pls/proiecte/docs?2026/pl526_pr526_26.pdf');
  assert.ok(!links.some(l => /comisii|av526|rp526/.test(l.url)), 'no committee reports or opinions');
  assert.equal(new Set(kinds).size, kinds.length, 'one document per kind');
});

test('text: a PDF with text, a scanned PDF (unreadable), an oversized file, HTML', async () => {
  const ok = await extractText(pdf('Bugetul total este de 759 mil. lei.'), 'application/pdf');
  assert.equal(ok.status, 'ok');
  assert.match(ok.text, /759 mil\. lei/);
  assert.deepEqual(await extractText(pdf(null), 'application/pdf'), { status: 'unreadable', text: '' });
  assert.equal((await extractText(Buffer.alloc(MAX_PDF_BYTES + 1), 'application/pdf')).status, 'unreadable');
  assert.equal((await extractText(Buffer.from('not a pdf'), 'application/pdf')).status, 'unreadable');
  const h = await extractText(Buffer.from('<p>Impactul este de <b>12 mil. lei</b>.</p><script>x()</script>'), 'text/html; charset=utf-8');
  assert.deepEqual(h, { status: 'ok', text: 'Impactul este de 12 mil. lei.' });
});

test('a bundle: the readable parts joined in a fixed order, with where each came from; same text, same hash', () => {
  const parts = [{ kind: 'law', url: 'https://x.ro/l.pdf', status: 'ok', text: 'Art. 1. Lege.' },
    { kind: 'motive', url: 'https://x.ro/m.pdf', status: 'unreadable', text: '' },
    { kind: 'fiscal_council', url: 'https://x.ro/f.pdf', status: 'ok', text: 'Costul este de 2,5 mld. lei.' }];
  const b = bundle(parts);
  assert.equal(b.status, 'ok');
  assert.match(b.text, /^Costul este de 2,5 mld\. lei\.[\s\S]*Art\. 1\. Lege\.$/);
  assert.deepEqual(b.parts.map(p => [p.kind, p.status]), [['fiscal_council', 'ok'], ['law', 'ok'], ['motive', 'unreadable']]);
  const fc = b.parts[0];
  assert.equal(b.text.slice(fc.from, fc.to), 'Costul este de 2,5 mld. lei.');
  assert.equal(bundle([...parts].reverse()).sha256, b.sha256);
  assert.match(b.sha256, /^[0-9a-f]{64}$/);
  assert.equal(bundle([parts[1]]).status, 'unreadable');
  assert.equal(b.url, 'https://x.ro/f.pdf');
});

test('the base sheet: what is known now, and why there is no analysis yet', () => {
  const docs = bundle([{ kind: 'law', url: 'https://x.ro/l.pdf', status: 'ok', text: 'Art. 1.' }]);
  const s = baseSheet(cdepEvent, docs);
  assert.equal(s.base.stage, cdepEvent.stage);
  assert.deepEqual(s.base.companies, cdepEvent.companies);
  assert.deepEqual(s.base.documents, [{ kind: 'law', url: 'https://x.ro/l.pdf', status: 'ok' }]);
  assert.deepEqual(s.reasons, ['ai_pending', 'no_financial_sheet']);
  assert.deepEqual(baseSheet(cdepEvent, bundle([{ kind: 'motive', url: 'https://x.ro/m.pdf', status: 'unreadable', text: '' }])).reasons, ['source_unreadable']);
  assert.deepEqual(baseSheet(cdepEvent, null).reasons, ['ai_pending']);
  const withMoney = bundle([{ kind: 'note', url: 'https://gov.ro/n', status: 'ok', text: 'Secțiunea a 4-a Impactul financiar: 12 mil. lei.' }]);
  assert.deepEqual(baseSheet(cdepEvent, withMoney).reasons, ['ai_pending']);
});

// A stand-in for ingest/supabase.mjs: read / insert / upsert on in-memory tables.
function fakeDb(tables) {
  const t = name => (tables[name] = tables[name] || []);
  return { tables,
    read: async (name, q) => {
      let rows = t(name);
      const m = /(?:^|&)id=in\.\(([^)]*)\)/.exec(q || '');
      if (m) { const ids = m[1].split(',').map(s => s.replace(/"/g, '')); rows = rows.filter(r => ids.includes(r.id)); }
      return rows.map(r => ({ ...r }));
    },
    insert: async (name, rows) => { t(name).push(...rows); },
    upsert: async (name, rows, { onConflict }) => {
      const keys = onConflict.split(',');
      for (const r of rows) {
        const i = t(name).findIndex(x => keys.every(k => x[k] === r[k]));
        if (i >= 0) t(name)[i] = { ...t(name)[i], ...r }; else t(name).push(r);
      }
    } };
}

test('runDocuments: reads what it can reach, gives every event a base sheet, never touches the batch\'s sheets', async () => {
  const { runDocuments } = await import('../ingest/policy/documents.mjs');
  const db = fakeDb({
    policy_events: [
      { id: 'gov:hg-1', title: 'HG 1', source_url: 'https://gov.ro/n1', status: 'adopted', stage: 'adoptată', institution: 'Guvernul României', event_date: '2026-10-01', sectors: [], companies: [] },
      { id: 'cdep:9', title: 'Proiect 9', source_url: 'https://www.cdep.ro/9', status: 'draft', stage: 'la comisii', institution: 'Camera Deputaților', event_date: '2026-10-02', sectors: [], companies: [] },
      { id: 'mf:5', title: 'Comunicat', source_url: 'https://mfinante.gov.ro/5', status: 'announced', stage: 'comunicat', institution: 'Ministerul Finanțelor', event_date: '2026-10-03', sectors: [], companies: [] }],
    policy_documents: [], fact_sheets: [{ event_id: 'mf:5', base: {}, reasons: [], origin: 'auto', summary: 'citit deja' }] });
  const pages = { 'https://gov.ro/n1': '<h1>Notă</h1><p>Secțiunea a 4-a Impactul financiar: 759 mil. lei pentru anul 2026.</p>', 'https://mfinante.gov.ro/5': '<p>Comunicatul ministerului despre o măsură nouă.</p>' };
  const fetchImpl = async url => ({ ok: !!pages[url], headers: new Map([['content-type', 'text/html']]), arrayBuffer: async () => Buffer.from(pages[url] || '') });
  const r = await runDocuments({ db, fetchImpl, limit: 10 });
  assert.equal(r.fetched, 2);
  const gov = db.tables.policy_documents.find(d => d.event_id === 'gov:hg-1');
  assert.match(gov.text, /759 mil\. lei/);
  assert.equal(gov.status, 'ok');
  assert.ok(!db.tables.policy_documents.some(d => d.event_id === 'cdep:9'), 'the Chamber is read on the PC');
  const sheet = id => db.tables.fact_sheets.find(s => s.event_id === id);
  assert.deepEqual(sheet('gov:hg-1').reasons, ['ai_pending']);
  assert.deepEqual(sheet('cdep:9').reasons, ['ai_pending']);
  assert.equal(sheet('mf:5').summary, 'citit deja');
  assert.equal(sheet('mf:5').origin, 'auto');
  // A second run stores nothing twice.
  const again = await runDocuments({ db, fetchImpl, limit: 10 });
  assert.equal(again.fetched, 0);
  assert.equal(db.tables.policy_documents.length, 2);
});
