#!/usr/bin/env node
// Builds the Bucharest Stock Exchange share catalog from BVB's own export.
//
//   node tools/update-bvb-catalog.mjs [path-to-export.csv]
//
// Without a path it downloads https://www.bvb.ro/FinancialInstruments/Markets/SharesListForDownload.ashx.
// Writes the same catalog twice, so names match everywhere:
//   netlify/functions/_shared/market/bvb-symbols.js   (gateway: Romanian news matching)
//   templates/shared/hif-bvb.js                         (apps: search and names)
//
// Only public facts are kept: symbol, a readable company name, and the market segment.
// Tradable shares only; the international segment (Intl-SMT, foreign shares that also
// trade in Bucharest) is left out so its symbols can't be confused with US listings.
// BVB's site terms limit reuse of its content: get BVB's written consent before using this
// catalog in a public or commercial product.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = 'https://www.bvb.ro/FinancialInstruments/Markets/SharesListForDownload.ashx';

// Readable names where the registered one is an acronym soup ("S.N.G.N. ROMGAZ S.A.").
const DISPLAY = {
  TLV: 'Banca Transilvania', SNP: 'OMV Petrom', H2O: 'Hidroelectrica', SNG: 'Romgaz',
  BRD: 'BRD - Groupe Société Générale', SNN: 'Nuclearelectrica', TGN: 'Transgaz', EL: 'Electrica',
  DIGI: 'Digi Communications', M: 'MedLife', TTS: 'TTS (Transport Trade Services)', ONE: 'One United Properties',
  AQ: 'Aquila', TEL: 'Transelectrica', PE: 'Premier Energy', TRP: 'Teraplast', SFG: 'Sphera Franchise Group',
  WINE: 'Purcari Wineries', ALR: 'Alro', COTE: 'Conpet', FP: 'Fondul Proprietatea', BVB: 'Bursa de Valori București'
};
// What the press calls them, for matching news to a company. Others match on their name.
const ALIASES = {
  TLV: ['Banca Transilvania'], SNP: ['Petrom', 'OMV Petrom'], H2O: ['Hidroelectrica'], SNG: ['Romgaz'],
  BRD: ['BRD', 'BRD Groupe Societe Generale'], SNN: ['Nuclearelectrica'], TGN: ['Transgaz'], EL: ['Electrica'],
  DIGI: ['Digi Communications', 'Digi RCS', 'Digi'], M: ['MedLife'], TTS: ['Transport Trade Services', 'TTS'],
  ONE: ['One United Properties', 'One United'], AQ: ['Aquila'], TEL: ['Transelectrica'], PE: ['Premier Energy'],
  TRP: ['Teraplast'], SFG: ['Sphera Franchise', 'Sphera Group'], WINE: ['Purcari'], ALR: ['Alro'], COTE: ['Conpet'],
  FP: ['Fondul Proprietatea'], BVB: ['Bursa de Valori Bucuresti'], ATB: ['Antibiotice'], BIO: ['Biofarm'],
  SAFE: ['Safetech'], AROBS: ['AROBS'], BRK: ['SSIF BRK', 'BRK Financial'], EVER: ['Evergent'],
  TRANSI: ['Transilvania Investments'], LION: ['Lion Capital'], INFINITY: ['Infinity Capital'],
  CMP: ['Compa Sibiu'], ALW: ['Allview', 'Visual Fan'], CFH: ['Casa de Bucovina'], BNET: ['Bittnet'],
  ROCE: ['Romcarbon'], SNO: ['Santierul Naval Orsova'], ELMA: ['Electromagnetica'], OIL: ['Oil Terminal'],
  TBM: ['Turbomecanica'], DN: ['Dn Agrar', 'DN AGRAR'], HAI: ['Holde Agri', 'Holde'], AG: ['Agroland'],
  '2P': ['2Performant'], NRF: ['Norofert'], MILK: ['Lactate Natura'], CC: ['Cris-Tim'], SMTL: ['Simtel'],
  PBK: ['Patria Bank'], AAG: ['Aages']
};
// The largest and most traded names: the "BVB" market tab and its quote strip.
const TOP = ['TLV', 'H2O', 'SNP', 'SNG', 'BRD', 'SNN', 'TGN', 'EL', 'DIGI', 'M', 'TTS', 'ONE', 'AQ', 'TEL', 'PE', 'TRP', 'SFG', 'WINE', 'FP', 'BVB'];

const LEGAL = /\b(S\.?\s?C\.?|S\.?N\.?(G\.?N\.?|T\.?G\.?N\.?)?|C\.?N\.?T\.?E\.?E\.?|S\.?P\.?E\.?E\.?H\.?|S\.?A\.?|SA|N\.?V\.?|PLC|LIMITED|LTD|PUBLIC COMPANY|SOCIETATEA|SOCIETATE)(?=\s|$|[,.)])/gi;
const KEEP_UPPER = new Set(['BRD', 'TTS', 'OMV', 'SSIF', 'BRK', 'IT', 'IPO', 'SIF', 'AROBS', 'RCS', 'RDS', 'UCM', 'CNTEE', 'DN']);
function titleCase(s) {
  return s.toLowerCase().replace(/(^|[\s(\-./])([a-zăâîșțşţ])/g, (m, p, c) => p + c.toUpperCase())
    .split(' ').map(w => KEEP_UPPER.has(w.toUpperCase().replace(/[^A-Z]/g, '')) ? w.toUpperCase() : w).join(' ');
}
function cleanName(raw) {
  const s = String(raw || '').replace(LEGAL, ' ').replace(/[\s,.-]+$/, '').replace(/^[\s,.-]+/, '').replace(/\s+/g, ' ').trim();
  return titleCase(s || raw);
}

async function load() {
  const path = process.argv[2];
  if (path) return readFileSync(path);
  const res = await fetch(SOURCE, { headers: { 'user-agent': 'Mozilla/5.0 (StockNews catalog)' } });
  if (!res.ok) throw new Error('BVB export: ' + res.status);
  return Buffer.from(await res.arrayBuffer());
}

const text = (await load()).toString('utf8').replace(/^﻿/, '');
const lines = text.split(/\r?\n/).filter(l => l.trim());
const head = lines[0].split(';');
const col = name => { const i = head.indexOf(name); if (i < 0) throw new Error('column missing: ' + name); return i; };
const [iSym, iName, iSect, iCat, iState] = ['Simbol', 'Denumire emisiune', 'Sectiune bursa', 'Categoria', 'Stare'].map(col);

const list = lines.slice(1).map(l => l.split(';'))
  .filter(r => r[iState] === 'Tranzactionabila' && r[iCat] !== 'Intl-SMT' && /^[A-Z0-9]{1,8}$/.test(r[iSym]))
  .map(r => {
    const sym = r[iSym], seg = r[iSect] === 'ATS' ? 'AeRO' : 'BVB';
    return [sym + '.RO', DISPLAY[sym] || cleanName(r[iName]), seg, r[iCat]];
  })
  .sort((a, b) => a[0].localeCompare(b[0]));
if (list.length < 100) throw new Error('only ' + list.length + ' shares: the export format may have changed');

const aliases = {};
Object.keys(ALIASES).forEach(k => { if (ALIASES[k].length && list.some(x => x[0] === k + '.RO')) aliases[k + '.RO'] = ALIASES[k]; });
const top = TOP.map(s => s + '.RO').filter(s => list.some(x => x[0] === s));
const stamp = new Date().toISOString().slice(0, 10);
const header = `// Generated by tools/update-bvb-catalog.mjs on ${stamp} from BVB's share list. Do not edit.\n` +
  `// [symbol, name, segment (BVB | AeRO), category]\n`;

writeFileSync(ROOT + 'netlify/functions/_shared/market/bvb-symbols.js', header +
  `export const BVB_SHARES = ${JSON.stringify(list)};\n` +
  `export const BVB_ALIASES = ${JSON.stringify(aliases)};\n` +
  `export const BVB_TOP = ${JSON.stringify(top)};\n`);

writeFileSync(ROOT + 'templates/shared/hif-bvb.js', header +
`(function(){
if (window.HIFBVB) return;
const LIST = ${JSON.stringify(list)};
const TOP = ${JSON.stringify(top)};
const BY = {}; LIST.forEach(r => { BY[r[0]] = r; });
const fold = s => String(s || '').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase();
// Symbol or company, with or without the .RO suffix and diacritics; exact symbols first.
function search(q, limit) {
  const f = fold(q).replace(/\\.ro$/, '').trim();
  if (!f) return [];
  const hits = [];
  LIST.forEach(r => {
    const sym = fold(r[0]).replace(/\\.ro$/, ''), name = fold(r[1]);
    const rank = sym === f ? 0 : sym.startsWith(f) ? 1 : name.startsWith(f) ? 2 : name.indexOf(' ' + f) >= 0 ? 3 : f.length >= 3 && name.indexOf(f) >= 0 ? 4 : -1;
    if (rank >= 0) hits.push([rank, r]);
  });
  return hits.sort((a, b) => a[0] - b[0] || (b[1][2] === 'BVB') - (a[1][2] === 'BVB') || a[1][0].localeCompare(b[1][0]))
    .slice(0, limit || 8).map(h => ({ ticker: h[1][0], name: h[1][1], exchange: h[1][2] === 'AeRO' ? 'BVB AeRO' : 'BVB' }));
}
window.HIFBVB = {
  list: LIST, top: TOP, search,
  name: t => (BY[t] || [])[1] || '',
  is: t => /\\.RO$/.test(String(t || '')),
  updated: '${stamp}'
};
})();
`);
console.log(`${list.length} shares (${list.filter(x => x[2] === 'BVB').length} BVB, ${list.filter(x => x[2] === 'AeRO').length} AeRO), ${top.length} top, ${Object.keys(aliases).length} with aliases`);
