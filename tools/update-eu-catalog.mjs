#!/usr/bin/env node
// Builds the catalog of German (XETRA, .DE) and London (LSE, .L) shares the apps offer,
// from the list below: the DAX 40 and FTSE 100 companies plus a few other large ones.
//
//   node tools/update-eu-catalog.mjs          checks every symbol against Yahoo, then writes
//   node tools/update-eu-catalog.mjs --offline  writes without checking
//
// Writes the same catalog twice, so names match everywhere:
//   netlify/functions/_shared/market/eu-symbols.js   (gateway: matching press news to companies)
//   templates/shared/hif-eu.js                         (apps: search and names)
//
// Each row: [symbol without suffix, display name, names the press uses]. A name starting
// with "~" is also an ordinary word ("Allianz" is German for alliance, "Next" is English):
// it only counts when no article stands right before it ("eine Allianz", "the next").
// Only public facts: symbols and company names. Edit the list, then run this tool.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const DE = [
  ["ADS", "adidas", ["Adidas"]],
  ["AIR", "Airbus", ["Airbus"]],
  ["ALV", "Allianz", ["~Allianz", "Allianz SE"]],
  ["BAS", "BASF", ["BASF"]],
  ["BAYN", "Bayer", ["Bayer"]],
  ["BEI", "Beiersdorf", ["Beiersdorf"]],
  ["BMW", "BMW", ["BMW"]],
  ["BNR", "Brenntag", ["Brenntag"]],
  ["CBK", "Commerzbank", ["Commerzbank"]],
  ["CON", "Continental", ["Continental AG", "~Continental"]],
  ["DTG", "Daimler Truck", ["Daimler Truck"]],
  ["DBK", "Deutsche Bank", ["Deutsche Bank"]],
  ["DB1", "Deutsche Börse", ["Deutsche Börse", "Deutsche Boerse"]],
  ["DHL", "DHL Group", ["DHL", "Deutsche Post"]],
  ["DTE", "Deutsche Telekom", ["Deutsche Telekom", "Telekom"]],
  ["EOAN", "E.ON", ["E.ON", "Eon"]],
  ["FRE", "Fresenius", ["Fresenius"]],
  ["FME", "Fresenius Medical Care", ["Fresenius Medical Care", "FMC"]],
  ["G1A", "GEA Group", ["GEA"]],
  ["HNR1", "Hannover Rück", ["Hannover Rück", "Hannover Re"]],
  ["HEI", "Heidelberg Materials", ["Heidelberg Materials", "HeidelbergCement"]],
  ["HEN3", "Henkel", ["Henkel"]],
  ["IFX", "Infineon", ["Infineon"]],
  ["MBG", "Mercedes-Benz", ["Mercedes-Benz", "Mercedes"]],
  ["MRK", "Merck KGaA", ["Merck KGaA"]],
  ["MTX", "MTU Aero Engines", ["MTU Aero", "MTU"]],
  ["MUV2", "Munich Re", ["Munich Re", "Münchener Rück", "Munich Re"]],
  ["P911", "Porsche AG", ["Porsche AG"]],
  ["PAH3", "Porsche SE", ["Porsche SE"]],
  ["QIA", "Qiagen", ["Qiagen"]],
  ["RHM", "Rheinmetall", ["Rheinmetall"]],
  ["RWE", "RWE", ["RWE"]],
  ["SAP", "SAP", ["SAP"]],
  ["SRT3", "Sartorius", ["Sartorius"]],
  ["SIE", "Siemens", ["Siemens", "Siemens AG"]],
  ["ENR", "Siemens Energy", ["Siemens Energy"]],
  ["SHL", "Siemens Healthineers", ["Siemens Healthineers", "Healthineers"]],
  ["SY1", "Symrise", ["Symrise"]],
  ["VOW3", "Volkswagen", ["Volkswagen", "VW"]],
  ["VNA", "Vonovia", ["Vonovia"]],
  ["ZAL", "Zalando", ["Zalando"]],
  ["G24", "Scout24", ["Scout24"]],
  ["LHA", "Lufthansa", ["Lufthansa"]],
  ["PUM", "Puma", ["~Puma", "Puma SE"]],
  ["TKA", "thyssenkrupp", ["Thyssenkrupp", "ThyssenKrupp"]],
  ["HFG", "HelloFresh", ["HelloFresh"]],
  ["DHER", "Delivery Hero", ["Delivery Hero"]],
  ["KGX", "Kion", ["Kion"]],
  ["LEG", "LEG Immobilien", ["LEG Immobilien"]],
  ["TLX", "Talanx", ["Talanx"]],
  ["HAG", "Hensoldt", ["Hensoldt"]],
  ["R3NK", "Renk", ["Renk"]],
  ["NEM", "Nemetschek", ["Nemetschek"]],
  ["EVD", "CTS Eventim", ["CTS Eventim", "Eventim"]],
];
const GB = [
  ["AZN", "AstraZeneca", ["AstraZeneca"]],
  ["SHEL", "Shell", ["~Shell", "Shell plc"]],
  ["HSBA", "HSBC", ["HSBC"]],
  ["ULVR", "Unilever", ["Unilever"]],
  ["BP", "BP", ["BP"]],
  ["RIO", "Rio Tinto", ["Rio Tinto"]],
  ["GSK", "GSK", ["GSK", "GlaxoSmithKline"]],
  ["REL", "RELX", ["RELX"]],
  ["DGE", "Diageo", ["Diageo"]],
  ["BATS", "British American Tobacco", ["British American Tobacco", "BAT"]],
  ["LSEG", "London Stock Exchange Group", ["London Stock Exchange Group", "LSEG"]],
  ["NG", "National Grid", ["National Grid"]],
  ["BARC", "Barclays", ["Barclays"]],
  ["LLOY", "Lloyds Banking Group", ["Lloyds"]],
  ["RR", "Rolls-Royce", ["Rolls-Royce"]],
  ["CPG", "Compass Group", ["Compass Group"]],
  ["GLEN", "Glencore", ["Glencore"]],
  ["AAL", "Anglo American", ["Anglo American"]],
  ["BA", "BAE Systems", ["BAE Systems", "BAE"]],
  ["VOD", "Vodafone", ["Vodafone"]],
  ["TSCO", "Tesco", ["Tesco"]],
  ["PRU", "Prudential", ["Prudential"]],
  ["NWG", "NatWest", ["NatWest"]],
  ["LGEN", "Legal & General", ["Legal & General", "Legal and General"]],
  ["AV", "Aviva", ["Aviva"]],
  ["IMB", "Imperial Brands", ["Imperial Brands"]],
  ["SSE", "SSE", ["SSE"]],
  ["EXPN", "Experian", ["Experian"]],
  ["HLN", "Haleon", ["Haleon"]],
  ["III", "3i Group", ["3i"]],
  ["STAN", "Standard Chartered", ["Standard Chartered"]],
  ["BT-A", "BT Group", ["BT Group", "BT"]],
  ["SGE", "Sage Group", ["Sage Group"]],
  ["ABF", "Associated British Foods", ["Associated British Foods", "ABF", "Primark"]],
  ["ANTO", "Antofagasta", ["Antofagasta"]],
  ["BNZL", "Bunzl", ["Bunzl"]],
  ["BRBY", "Burberry", ["Burberry"]],
  ["CCH", "Coca-Cola HBC", ["Coca-Cola HBC"]],
  ["CNA", "Centrica", ["Centrica", "British Gas"]],
  ["CRDA", "Croda", ["Croda"]],
  ["ENT", "Entain", ["Entain"]],
  ["FRES", "Fresnillo", ["Fresnillo"]],
  ["HLMA", "Halma", ["Halma"]],
  ["HWDN", "Howden Joinery", ["Howdens", "Howden Joinery"]],
  ["IHG", "InterContinental Hotels", ["InterContinental Hotels", "IHG"]],
  ["IAG", "International Airlines Group", ["International Airlines Group", "IAG", "British Airways"]],
  ["INF", "Informa", ["Informa"]],
  ["ITRK", "Intertek", ["Intertek"]],
  ["JD", "JD Sports", ["JD Sports"]],
  ["KGF", "Kingfisher", ["Kingfisher", "B&Q"]],
  ["LAND", "Land Securities", ["Land Securities", "Landsec"]],
  ["BLND", "British Land", ["British Land"]],
  ["MKS", "Marks & Spencer", ["Marks & Spencer", "Marks and Spencer", "M&S"]],
  ["MNDI", "Mondi", ["Mondi"]],
  ["NXT", "Next", ["Next plc"]],
  ["PSN", "Persimmon", ["Persimmon"]],
  ["PSON", "Pearson", ["Pearson"]],
  ["RKT", "Reckitt", ["Reckitt"]],
  ["RMV", "Rightmove", ["Rightmove"]],
  ["RTO", "Rentokil Initial", ["Rentokil"]],
  ["SBRY", "Sainsbury's", ["Sainsbury's", "Sainsbury"]],
  ["SGRO", "Segro", ["Segro"]],
  ["SMIN", "Smiths Group", ["Smiths Group"]],
  ["SN", "Smith & Nephew", ["Smith & Nephew", "Smith and Nephew"]],
  ["SPX", "Spirax Group", ["Spirax"]],
  ["SVT", "Severn Trent", ["Severn Trent"]],
  ["UU", "United Utilities", ["United Utilities"]],
  ["WEIR", "Weir Group", ["Weir Group"]],
  ["WPP", "WPP", ["WPP"]],
  ["WTB", "Whitbread", ["Whitbread", "Premier Inn"]],
  ["ADM", "Admiral Group", ["Admiral"]],
  ["AUTO", "Auto Trader", ["Auto Trader"]],
  ["BKG", "Berkeley Group", ["Berkeley Group"]],
  ["DPLM", "Diploma", ["Diploma plc"]],
  ["EDV", "Endeavour Mining", ["Endeavour Mining"]],
  ["HIK", "Hikma", ["Hikma"]],
  ["ICG", "Intermediate Capital", ["Intermediate Capital"]],
  ["IMI", "IMI", ["IMI plc"]],
  ["MNG", "M&G", ["M&G"]],
  ["SDLF", "Standard Life", ["Standard Life", "Phoenix Group"]],
  ["UTG", "Unite Group", ["Unite Group"]],
  ["AAF", "Airtel Africa", ["Airtel Africa"]],
  ["TW", "Taylor Wimpey", ["Taylor Wimpey"]],
  ["BTRW", "Barratt Redrow", ["Barratt", "Barratt Redrow"]],
  ["EZJ", "easyJet", ["easyJet", "EasyJet"]],
  ["OCDO", "Ocado", ["Ocado"]],
  ["ITV", "ITV", ["ITV"]],
  ["BME", "B&M", ["B&M European"]],
  ["RS1", "RS Group", ["RS Group"]],
  ["SMT", "Scottish Mortgage", ["Scottish Mortgage"]],
  ["PSH", "Pershing Square Holdings", ["Pershing Square Holdings"]],
];

const list = DE.map(([s, n]) => [s + '.DE', n, 'XETRA']).concat(GB.map(([s, n]) => [s + '.L', n, 'LSE']));
const aliases = {};
DE.forEach(([s, , a]) => { aliases[s + '.DE'] = a; });
GB.forEach(([s, , a]) => { aliases[s + '.L'] = a; });

if (!process.argv.includes('--offline')) {
  // A symbol Yahoo doesn't know, or one that hasn't traded for a week (taken over, delisted).
  const bad = [];
  for (const [sym] of list) {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`, { headers: { 'user-agent': 'Mozilla/5.0' } });
    let m = null; try { m = (await r.json()).chart.result[0].meta; } catch (e) {}
    if (!m || !m.currency || Date.now() / 1000 - m.regularMarketTime > 7 * 86400) bad.push(sym);
    await new Promise(res => setTimeout(res, 250));
  }
  if (bad.length) { console.error('Not trading on Yahoo:', bad.join(', ')); process.exit(1); }
}

const stamp = new Date().toISOString().slice(0, 10);
const header = `// Generated by tools/update-eu-catalog.mjs on ${stamp}. Do not edit.\n`;
writeFileSync(ROOT + 'netlify/functions/_shared/market/eu-symbols.js', header +
  '// [symbol, name, exchange (XETRA | LSE)]\n' +
  `export const EU_SHARES = ${JSON.stringify(list)};\n` +
  `export const EU_ALIASES = ${JSON.stringify(aliases)};\n`);
writeFileSync(ROOT + 'templates/shared/hif-eu.js', header +
`(function(){
if (window.HIFEU) return;
const LIST = ${JSON.stringify(list)};
const BY = {}; LIST.forEach(r => { BY[r[0]] = r; });
const fold = s => String(s || '').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase();
// Symbol or company, with or without the .DE / .L suffix; exact symbols first.
function search(q, limit) {
  const f = fold(q).replace(/\\.(de|l)$/, '').trim();
  if (!f) return [];
  const hits = [];
  LIST.forEach(r => {
    const sym = fold(r[0]).replace(/\\.(de|l)$/, ''), name = fold(r[1]);
    const rank = sym === f ? 0 : sym.startsWith(f) ? 1 : name.startsWith(f) ? 2 : name.indexOf(' ' + f) >= 0 ? 3 : f.length >= 3 && name.indexOf(f) >= 0 ? 4 : -1;
    if (rank >= 0) hits.push([rank, r]);
  });
  return hits.sort((a, b) => a[0] - b[0] || a[1][0].localeCompare(b[1][0]))
    .slice(0, limit || 8).map(h => ({ ticker: h[1][0], name: h[1][1], exchange: h[1][2] }));
}
window.HIFEU = {
  list: LIST, search,
  name: t => (BY[t] || [])[1] || '',
  is: t => /\\.(DE|L)$/.test(String(t || '')),
  updated: '${stamp}'
};
})();
`);
console.log(`${list.length} shares (${DE.length} XETRA, ${GB.length} LSE)`);
