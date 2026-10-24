// Companies ↔ fiscal codes (config/company-entities.json): the only way a public contract or a
// state aid is tied to a BVB company. A code comes from the company's own site and is confirmed
// by ANAF's public register (the name there must match the issuer); never matched by name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateEntities, cuiIndex, cuiValid, catalogTickers } from '../ingest/impact/schema.mjs';
import { extractCuis, sameCompany, registryMatch } from '../tools/update-company-entities.mjs';

const tickers = catalogTickers();
const tlv = { ticker: 'TLV.RO', cui: '5022670', name: 'BANCA TRANSILVANIA SA', role: 'issuer', source_url: 'https://www.bancatransilvania.ro/', verified_on: '2026-10-19' };

test('fiscal codes: 2-10 digits with a valid ANAF check digit', () => {
  assert.ok(cuiValid('5022670'));       // Banca Transilvania
  assert.ok(cuiValid('RO 5022670'));
  assert.ok(!cuiValid('5022671'));
  assert.ok(!cuiValid('1'));
  assert.ok(!cuiValid('12345678901'));
});

test('the entity list: known tickers, valid codes, a code at one ticker only, https sources', () => {
  assert.ok(validateEntities([tlv], { tickers }).ok);
  assert.match(validateEntities([{ ...tlv, ticker: 'XXX.RO' }], { tickers }).errors.join(), /catalog/);
  assert.match(validateEntities([{ ...tlv, cui: '5022671' }], { tickers }).errors.join(), /check digit/);
  assert.match(validateEntities([tlv, { ...tlv, ticker: 'BRD.RO' }], { tickers }).errors.join(), /two tickers/);
  assert.match(validateEntities([{ ...tlv, source_url: 'http://x' }], { tickers }).errors.join(), /source_url/);
  assert.match(validateEntities([{ ...tlv, role: 'friend' }], { tickers }).errors.join(), /role/);
  const real = JSON.parse(readFileSync(new URL('../config/company-entities.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateEntities(real, { tickers }).errors, []);
  assert.ok(real.length >= 20, 'at least the main issuers');
});

test('the index maps a subsidiary to its listed parent and an unknown code to nothing', () => {
  const idx = cuiIndex([tlv, { ...tlv, cui: '10950140', name: 'BT LEASING TRANSILVANIA IFN SA', role: 'subsidiary' }]);
  assert.equal(idx.get('5022670'), 'TLV.RO');
  assert.equal(idx.get('10950140'), 'TLV.RO');
  assert.equal(idx.get('RO5022670'.replace(/\D/g, '')), 'TLV.RO');
  assert.equal(idx.get('14399840'), undefined);
});

test('codes are read from a company page only where labelled, and checked', () => {
  const html = '<footer>Banca Transilvania S.A. | CUI RO 5022670 | J12/4155/1993 | Capital 123.456 lei | tel 0264407150</footer>';
  assert.deepEqual(extractCuis(html), ['5022670']);
  assert.deepEqual(extractCuis('<p>Cod fiscal: 5022671</p>'), []);          // bad check digit
  assert.deepEqual(extractCuis('<p>Telefon 0264407150, 5022670 clienți</p>'), []); // not labelled
  assert.deepEqual(extractCuis('C.I.F.: RO5022670; Cod unic de înregistrare 5022670'), ['5022670']);
});

test('the ANAF name must be the issuer: legal forms and diacritics aside, not a namesake', () => {
  assert.ok(sameCompany('BANCA TRANSILVANIA SA', 'Banca Transilvania'));
  assert.ok(sameCompany('S.N.G.N. ROMGAZ S.A.', 'Romgaz'));
  assert.ok(sameCompany('OMV PETROM S.A.', 'OMV Petrom'));
  assert.ok(sameCompany('MED LIFE SA', 'MedLife'));
  assert.ok(!sameCompany('PETROM CONSTRUCT SRL', 'OMV Petrom'));
  assert.ok(!sameCompany('TRANSILVANIA CONSULT SRL', 'Banca Transilvania'));
});

test('a code from the trade register only for the one S.A. with the issuer\'s name (and town)', () => {
  const sa = (cui, name, town) => ({ cui, words: name.split(' '), town: town.split(' ') });
  const reg = [sa('2469306', 'TRANSCOM', 'SIBIU MUNICIPIUL SIBIU'), sa('1574478', 'TRANSCOM', 'BUCURESTI SECTORUL 5'),
    sa('2157789', 'MACOFIL', 'GORJ MUNICIPIUL TARGU JIU'), sa('1606030', 'SEVERNAV', 'MEHEDINTI MUNICIPIUL DROBETA TURNU SEVERIN'),
    sa('29136800', 'GLISSANDO GARDEN CENTER', 'ILFOV'), sa('1', 'GLISSANDO', 'CLUJ')];
  assert.equal(registryMatch('Transcom Bucuresti', reg), '1574478');       // the town tells the two apart
  assert.equal(registryMatch('Macofil Tg. Jiu', reg), '2157789');          // Tg. = Târgu
  assert.equal(registryMatch('Severnav Dr. Tr. Severin', reg), '1606030');
  assert.equal(registryMatch('Glissando Garden Center', reg), '29136800');
  assert.equal(registryMatch('Transcom', reg), null);                      // two of them: none
  assert.equal(registryMatch('Transcom Iasi', reg), null);                 // not registered there
  assert.equal(registryMatch('Glissando Garden', reg), null);              // a word short is not the name
});
