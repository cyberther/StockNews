import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classify, bvbCatalog } from '../ingest/policy/classify.mjs';
import { BVB_SHARES } from '../netlify/functions/_shared/market/bvb-symbols.js';

const taxonomy = JSON.parse(readFileSync(new URL('../config/policy-taxonomy.json', import.meta.url), 'utf8'));
const catalog = bvbCatalog();
const run = t => classify(t, taxonomy, catalog);

test('the taxonomy names every sector with keywords, CAEN sections and only known BVB tickers', () => {
  const known = new Set(BVB_SHARES.map(r => r[0]));
  for (const [id, s] of Object.entries(taxonomy.sectors)) {
    assert.ok(s.label && s.keywords.length, id);
    assert.ok(Array.isArray(s.caen), id);
    for (const t of s.tickers) assert.ok(known.has(t), `${id}: ${t}`);
  }
});

test('diesel excise: oil and gas plus general tax; oil companies linked through the sector', () => {
  const r = run('Acciza la motorină se menține la nivelul redus de 25%');
  assert.deepEqual(r.sectors, ['fiscal-general', 'petrol-gaze']);
  assert.ok(r.caen.includes('C19'));
  assert.deepEqual(r.companies.find(c => c.ticker === 'SNP.RO'), { ticker: 'SNP.RO', why: 'sector', sector: 'petrol-gaze' });
});

test('a company named in the text is linked as mentioned, before any sector link', () => {
  const r = run('Propunere legislativă privind proiectele Hidroelectrica în domeniul hidroenergiei');
  assert.deepEqual(r.companies.find(c => c.ticker === 'H2O.RO'), { ticker: 'H2O.RO', why: 'mentioned' });
  assert.ok(r.sectors.includes('energie'));
});

test('figures: percentages of GDP, plain percentages, percentage points and amounts', () => {
  const r = run('Deficit de 3,82% din PIB, în scădere cu 1,53 puncte procentuale; impact de 1,2 mld. lei și 350 milioane euro; cota de 25%');
  assert.deepEqual(r.figures, [
    { kind: 'percent', value: 3.82, unit: '% din PIB', text: '3,82% din PIB' },
    { kind: 'pp', value: 1.53, unit: 'pp', text: '1,53 puncte procentuale' },
    { kind: 'amount', value: 1.2e9, unit: 'RON', text: '1,2 mld. lei' },
    { kind: 'amount', value: 3.5e8, unit: 'EUR', text: '350 milioane euro' },
    { kind: 'percent', value: 25, unit: '%', text: '25%' }
  ]);
});

test('no rule, no link; diacritics or not, the same answer', () => {
  assert.deepEqual(run('Proiect de Lege privind transmiterea unor terenuri către municipiul Brașov'), { sectors: [], caen: [], companies: [], figures: [] });
  assert.deepEqual(run('Impozitul pe profitul băncilor'), run('Impozitul pe profitul bancilor'));
  assert.ok(run('Impozitul pe profitul bancilor').sectors.includes('banci-financiar'));
});

test('a common word that is also a company name does not link the company', () => {
  // "Nord" (Nord Bucuresti) or "Unirea" in ordinary text are not mentions.
  const r = run('Autostrada de nord și piața Unirea');
  assert.equal(r.companies.filter(c => c.why === 'mentioned').length, 0);
});

test('"asigurarea" as an everyday word is not the insurance sector', () => {
  assert.ok(!run('Propunere legislativă pentru asigurarea proporţionalităţii măsurilor').sectors.includes('asigurari-pensii'));
  assert.ok(run('Proiect privind piaţa asigurărilor RCA').sectors.includes('asigurari-pensii'));
  assert.ok(run('Proiect de Lege privind plata pensiilor private').sectors.includes('asigurari-pensii'));
});
