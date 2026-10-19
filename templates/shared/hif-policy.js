// The Policy screen's data (supabase/policy.sql, filled daily by ingest/policy/): the query,
// and which events concern the reader. Status and certainty are shown with fixed labels per
// value, never with words taken from an event's own text.
(function(){
// Sector labels: the same as config/policy-taxonomy.json (test/policy-client.test.js checks).
var SECTORS = {
  'fiscal-general': {"ro": "Fiscal (general)", "en": "Tax (general)", "de": "Steuern (allgemein)"},
  'petrol-gaze': {"ro": "Petrol și gaze", "en": "Oil and gas", "de": "Öl und Gas"},
  'energie': {"ro": "Energie electrică", "en": "Electricity", "de": "Strom"},
  'banci-financiar': {"ro": "Bănci și financiar", "en": "Banks and finance", "de": "Banken und Finanzen"},
  'asigurari-pensii': {"ro": "Asigurări și pensii", "en": "Insurance and pensions", "de": "Versicherungen und Renten"},
  'telecom': {"ro": "Telecomunicații", "en": "Telecoms", "de": "Telekommunikation"},
  'sanatate-farma': {"ro": "Sănătate și farma", "en": "Healthcare and pharma", "de": "Gesundheit und Pharma"},
  'imobiliare-constructii': {"ro": "Imobiliare și construcții", "en": "Real estate and construction", "de": "Immobilien und Bau"},
  'agricultura-alimentar': {"ro": "Agricultură și alimentar", "en": "Agriculture and food", "de": "Landwirtschaft und Lebensmittel"},
  'transport-logistica': {"ro": "Transport și logistică", "en": "Transport and logistics", "de": "Verkehr und Logistik"},
  'it': {"ro": "IT și digital", "en": "IT and digital", "de": "IT und Digitales"},
  'industrie': {"ro": "Industrie", "en": "Industry", "de": "Industrie"},
  'aparare': {"ro": "Apărare", "en": "Defence", "de": "Verteidigung"}
};
var STATUS = {
  statement:   { ro: 'Declarație / comunicat', en: 'Statement', de: 'Erklärung' },
  draft:       { ro: 'Proiect în procedură', en: 'Bill in procedure', de: 'Entwurf im Verfahren' },
  adopted:     { ro: 'Adoptată', en: 'Adopted', de: 'Verabschiedet' },
  in_force:    { ro: 'În vigoare', en: 'In force', de: 'In Kraft' },
  implemented: { ro: 'Implementată', en: 'Implemented', de: 'Umgesetzt' },
  stopped:     { ro: 'Procedură încheiată', en: 'Procedure ended', de: 'Verfahren beendet' }
};
var UNKNOWN = { ro: 'Statut necunoscut', en: 'Unknown status', de: 'Status unbekannt' };
var CERTAINTY = {
  official_act:       { ro: 'Act oficial', en: 'Official act', de: 'Amtlicher Rechtsakt' },
  official_procedure: { ro: 'Procedură parlamentară', en: 'Parliamentary record', de: 'Parlamentarisches Verfahren' },
  official_statement: { ro: 'Comunicat oficial', en: 'Official statement', de: 'Amtliche Mitteilung' }
};
// CPV divisions (the first two digits of a purchase's code), for "where the money goes".
var CPV = {
  '03': { ro: 'Agricultură și silvicultură', en: 'Agriculture and forestry', de: 'Land- und Forstwirtschaft' },
  '09': { ro: 'Energie și combustibili', en: 'Energy and fuels', de: 'Energie und Brennstoffe' },
  '14': { ro: 'Minerit și minerale', en: 'Mining and minerals', de: 'Bergbau und Mineralien' },
  '15': { ro: 'Alimente și băuturi', en: 'Food and drink', de: 'Lebensmittel und Getränke' },
  '30': { ro: 'Echipamente de birou și IT', en: 'Office and IT equipment', de: 'Büro- und IT-Ausstattung' },
  '31': { ro: 'Echipamente electrice', en: 'Electrical equipment', de: 'Elektrische Ausrüstung' },
  '32': { ro: 'Telecomunicații (echipamente)', en: 'Telecoms equipment', de: 'Telekommunikationsausrüstung' },
  '33': { ro: 'Echipamente medicale și farma', en: 'Medical equipment and pharma', de: 'Medizintechnik und Pharma' },
  '34': { ro: 'Transport (echipamente)', en: 'Transport equipment', de: 'Transportausrüstung' },
  '35': { ro: 'Securitate și apărare', en: 'Security and defence', de: 'Sicherheit und Verteidigung' },
  '42': { ro: 'Utilaje industriale', en: 'Industrial machinery', de: 'Industriemaschinen' },
  '44': { ro: 'Materiale de construcții', en: 'Construction materials', de: 'Baumaterialien' },
  '45': { ro: 'Lucrări de construcții', en: 'Construction works', de: 'Bauarbeiten' },
  '48': { ro: 'Software', en: 'Software', de: 'Software' },
  '50': { ro: 'Reparații și întreținere', en: 'Repair and maintenance', de: 'Reparatur und Wartung' },
  '60': { ro: 'Servicii de transport', en: 'Transport services', de: 'Transportdienste' },
  '64': { ro: 'Poștă și telecomunicații', en: 'Post and telecoms', de: 'Post und Telekommunikation' },
  '65': { ro: 'Utilități publice', en: 'Public utilities', de: 'Versorgungsleistungen' },
  '66': { ro: 'Servicii financiare și de asigurări', en: 'Financial and insurance services', de: 'Finanz- und Versicherungsdienste' },
  '71': { ro: 'Arhitectură și inginerie', en: 'Architecture and engineering', de: 'Architektur und Ingenieurwesen' },
  '72': { ro: 'Servicii IT', en: 'IT services', de: 'IT-Dienstleistungen' },
  '79': { ro: 'Servicii pentru afaceri', en: 'Business services', de: 'Unternehmensdienstleistungen' },
  '85': { ro: 'Sănătate și asistență socială', en: 'Health and social work', de: 'Gesundheits- und Sozialwesen' },
  '90': { ro: 'Salubritate și mediu', en: 'Sanitation and environment', de: 'Abfall und Umwelt' }
};
var COLS = 'id,title,summary,event_date,institution,initiator,doc_number,source_url,status,stage,certainty,sectors,companies,figures';
var SYMBOL = /^[A-Z0-9][A-Z0-9.\-]{0,11}$/;
var pick = function(map, key, lang){ var v = map[key]; return v ? (v[lang] || v.en) : null; };

function query(o){
  o = o || {};
  var q = 'policy_events?select=' + COLS;
  if (o.sector && Object.prototype.hasOwnProperty.call(SECTORS, o.sector)) q += '&sectors=cs.' + encodeURIComponent('{' + o.sector + '}');
  if (o.ticker && SYMBOL.test(o.ticker)) q += '&companies=cs.' + encodeURIComponent(JSON.stringify([{ ticker: o.ticker }]));
  // Title search: PostgREST's syntax characters removed; letters with diacritics become '_'
  // (any one character), so ş/ș, ţ/ț and words typed without them all match.
  var text = String(o.q || '').replace(/[*,().:%\\"'&=#?;<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80).replace(/[ăâîșşțţĂÂÎȘŞȚŢ]/g, '_');
  if (text) q += '&title=ilike.' + encodeURIComponent('*' + text + '*').replace(/%2A/g, '*');
  if (o.status && Object.prototype.hasOwnProperty.call(STATUS, o.status)) q += '&status=eq.' + o.status;
  return q + '&order=event_date.desc,id.desc&limit=' + (Number(o.limit) > 0 ? Math.min(500, Number(o.limit)) : 200);
}
// One request; an error is an error, not an empty list.
function load(o){
  var A = window.HIFAuth;
  if (!A || !A.rest) return Promise.resolve(null);
  return A.rest(query(o)).then(function(r){
    if (!r || !r.ok || !Array.isArray(r.body)) throw new Error('policy ' + ((r && r.status) || 0));
    return r.body;
  });
}
// The event's companies the reader follows or holds, each with why it is linked and through what.
function affects(ev, follows, positions){
  var f = follows || [], p = positions || {};
  return ((ev && ev.companies) || []).reduce(function(out, c){
    var via = [];
    if (f.indexOf(c.ticker) >= 0) via.push('following');
    if (Object.prototype.hasOwnProperty.call(p, c.ticker)) via.push('portfolio');
    if (via.length) out.push(Object.assign({}, c, { via: via }));
    return out;
  }, []);
}
// Politici 2.0: fact sheets of the events shown, "who gains" links, company exposure and the
// money by kind of purchase. Ids and tickers outside their patterns are dropped.
var EVENT = /^[a-z]{2,10}:[A-Za-z0-9._-]{1,60}$/;
var inList = function(xs, re){ return '(' + (xs || []).filter(function(x){ return re.test(String(x)); }).slice(0, 200).map(function(x){ return '%22' + x + '%22'; }).join(',') + ')'; };
var Q = {
  sheets: function(ids){ return 'fact_sheets?select=event_id,summary,reasons,base,origin&event_id=in.' + inList(ids, EVENT); },
  links: function(o){ o = o || {}; return 'state_links?select=*' + (o.tickers && o.tickers.length ? '&subject_ticker=in.' + inList(o.tickers, SYMBOL) : '') + '&order=at.desc.nullslast&limit=400'; },
  exposure: function(){ return 'company_state_exposure?select=*&order=contracts_12m_ron.desc&limit=300'; },
  flows: function(from){ var d = /^\d{4}-\d{2}-\d{2}$/.test(String(from)) ? from : new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
    return 'sector_state_flows?select=*&month=gte.' + d + '&order=month.desc&limit=600'; }
};
function rest(q){
  var A = window.HIFAuth;
  if (!A || !A.rest) return Promise.resolve(null);
  return A.rest(q).then(function(r){
    if (!r || !r.ok || !Array.isArray(r.body)) throw new Error('policy ' + ((r && r.status) || 0));
    return r.body;
  });
}
var root = typeof window !== 'undefined' ? window : globalThis;
root.HIFPolicy = { SECTORS: SECTORS, query: query, load: load, affects: affects, Q: Q,
  loadSheets: function(ids){ return rest(Q.sheets(ids)); }, loadLinks: function(o){ return rest(Q.links(o)); },
  loadExposure: function(){ return rest(Q.exposure()); }, loadFlows: function(from){ return rest(Q.flows(from)); },
  statusLabel: function(s, lang){ return pick(STATUS, s, lang || 'en') || UNKNOWN[lang] || UNKNOWN.en; },
  certaintyLabel: function(c, lang){ return pick(CERTAINTY, c, lang || 'en') || ''; },
  sectorLabel: function(id, lang){ return pick(SECTORS, id, lang || 'en') || id; },
  cpvLabel: function(div, lang){ return pick(CPV, div, lang || 'en') || ('CPV ' + div); } };
})();
