// The state's money to listed companies (ingest/state/seap.mjs): SEAP's quarterly open data
// (CC BY 4.0, data.gov.ro), read as a stream, kept only for fiscal codes in
// config/company-entities.json — never matched by name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeXlsx } from './helpers/tiny-xlsx.js';
import { readContracts, contractFiles, runStateMoney } from '../ingest/state/seap.mjs';
import { cuiIndex } from '../ingest/impact/schema.mjs';

const HEAD = ['Autoritate contractanta', 'CUI autoritate contractanta', 'Tip anunt', 'Tip procedura', 'Numar anunt initiere', 'Data publicare', 'Tip legislatie',
  'Tip incheiere contract', 'Tip contract', 'Tip criterii de atribuire', 'Cod CPV', 'Denumire CPV', 'Numar lot', 'Numar anunt atribuire', 'Data publicare',
  'Data contract', 'Numar contract', 'Incheiat prin', 'Valoare contract (RON)', 'Ofertant castigator', 'CUI ofertant castigator'];
const row = (authority, cpv, notice, lot, date, no, value, winner, cui) =>
  [authority, '4453144', 'Anunt', 'Procedura simplificata', 'SCN1', 46136.6, 'Legea 98', 'Contract', 'Lucrari', 'Pret', cpv, 'Lucrari de constructii', lot, notice, 46204.3, date, no, 'Fara acord cadru', value, winner, cui];
const index = cuiIndex([
  { ticker: 'TEL.RO', cui: '13328043', role: 'issuer' },
  { ticker: 'EL.RO', cui: '14476722', role: 'subsidiary' }]);
const dir = mkdtempSync(join(tmpdir(), 'seap-'));
const file = join(dir, 'c.xlsx');
writeXlsx(file, [HEAD,
  row('CNTEE TRANSELECTRICA', '45231400-9', 'SCNA1', '1', 46203, 'C1', 1250000.5, 'TRANSELECTRICA SA', 13328043),   // the issuer, code as a number
  row('PRIMARIA X', '45000000-7', 'SCNA2', '2', 46177, 'C2', 477300, 'DISTRIBUTIE ENERGIE SA', 'RO 14476722'),        // a subsidiary, code as text
  row('PRIMARIA Y', '45000000-7', 'SCNA3', '1', 46177, 'C3', 1000, 'PETROM CONSTRUCT SRL', 41385516),                // a namesake: another code
  row('PRIMARIA Z', '45000000-7', 'SCNA4', '1', 46177, 'C4', 999, 'TRANSELECTRICA SERVICE', '')]);                  // no code at all

test('only rows whose winner code is a listed company or its subsidiary, with the parent ticker', async () => {
  const rows = await readContracts(file, { cuiIndex: index, sourceUrl: 'https://data.gov.ro/dataset/x/resource/y/download/raport-contracte-tiii.xlsx' });
  assert.deepEqual(rows.map(r => [r.ticker, r.cui, r.value_ron]), [['TEL.RO', '13328043', 1250000.5], ['EL.RO', '14476722', 477300]]);
  const t = rows[0];
  assert.equal(t.signed_on, '2026-06-30');            // Excel day 46203
  assert.equal(t.authority, 'CNTEE TRANSELECTRICA');
  assert.equal(t.cpv, '45231400-9');
  assert.equal(t.id, 'seap:SCNA1:1:C1');
  assert.equal(t.currency, 'RON');
  assert.match(t.source_url, /^https:\/\/data\.gov\.ro\//);
});

test('the dataset page lists the quarterly contract files (xlsx), not the amendments or other reports', () => {
  const html = ['raport-contracte-ti-2026.xlsx', 'raport-date-din-modificare-contract-ti-2026.xlsx', 'raport-achizitii-directe-ti-2026.xlsx', 'datagov-raport-contracte_tii.ods', 'raport-contracte-tiii.xlsx']
    .map(f => `<a href="https://data.gov.ro/dataset/e8/resource/r/download/${f}">x</a>`).join('');
  assert.deepEqual(contractFiles(html), ['https://data.gov.ro/dataset/e8/resource/r/download/raport-contracte-ti-2026.xlsx', 'https://data.gov.ro/dataset/e8/resource/r/download/raport-contracte-tiii.xlsx']);
});

test('runStateMoney: each file read once, rows stored once, waits between data.gov.ro requests', async () => {
  const tables = { public_contracts: [], state_sources: [] }, waits = [];
  const db = { read: async t => tables[t].map(r => ({ ...r })),
    upsert: async (t, rows, { onConflict }) => { for (const r of rows) { const i = tables[t].findIndex(x => x[onConflict] === r[onConflict]); if (i < 0) tables[t].push(r); else tables[t][i] = r; } } };
  const page = '<a href="https://data.gov.ro/dataset/e8/resource/r/download/raport-contracte-tiii.xlsx">c</a>';
  const fetchImpl = async url => /download/.test(url)
    ? { ok: true, body: null, arrayBuffer: async () => readFileSync(file) }
    : { ok: true, text: async () => page };
  const run = () => runStateMoney({ db, fetchImpl, cuiIndex: index, wait: async ms => waits.push(ms), tmp: dir, datasets: ['https://data.gov.ro/dataset/achizitii-publice-2026'] });
  const a = await run();
  assert.deepEqual([a.files, a.contracts], [1, 2]);
  assert.ok(waits.every(ms => ms >= 10000) && waits.length >= 1, 'robots.txt asks for 10 s');
  const b = await run();
  assert.deepEqual([b.files, b.contracts], [0, 0]);
  assert.equal(tables.public_contracts.length, 2);
  assert.equal(tables.state_sources.length, 1);
});
