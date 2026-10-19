// The impact analyses (analyses/<id>/v<N>.json), the companies' figures
// (config/company-financials.json) and the observed outcomes (analyses/<id>/outcomes.json):
// their checks, and the lock that keeps a published analysis from changing (analyses/LOCK.json).
// Every number is a fact (with an https source), an assumption (with why and a range it lies
// in) or a result the engine computes; a company's inputs are references to those keys.
//
//   node ingest/impact/schema.mjs --lock    adds new analyses to LOCK.json, refuses changed ones
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BVB_SHARES } from '../../netlify/functions/_shared/market/bvb-symbols.js';
import '../../templates/shared/hif-scenario.js';
import '../../templates/shared/hif-impact.js';

const I = globalThis.HIFImpact;
const ID = /^[a-z0-9][a-z0-9-]{1,60}$/;
const KEY = /^[a-z][a-z0-9_]{0,40}$/;
const EVENT = /^[a-z]{2,10}:[A-Za-z0-9._-]{1,60}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const https = u => typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/.test(u) && u.length <= 500;
const text = (s, max = 2000) => typeof s === 'string' && s.trim().length > 0 && s.length <= max;
const isDate = s => typeof s === 'string' && DATE.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
const COMPANY_INPUTS = { exposure_pct: 'exposure', shock_pct: 'shock', mitigation_pct: 'mitigation', contribution_pct: 'contribution' };
const RISKS = ['legal', 'administrative', 'funding', 'timing'];
const REQUIRED = ['cost', 'gdp', 'start'];

export const catalogTickers = () => new Set(BVB_SHARES.map(r => r[0]));

export function validateAnalysis(a, { taxonomy, tickers, file } = {}) {
  const errors = [], err = m => errors.push(m);
  if (!a || typeof a !== 'object') return { ok: false, errors: ['not an object'] };
  if (typeof a.id !== 'string' || !ID.test(a.id)) err('id must be lowercase letters, digits and dashes');
  if (!Number.isInteger(a.version) || a.version < 1) err('version must be a whole number from 1');
  if (file) {
    const m = /(?:^|\/)([^/]+)\/v(\d+)\.json$/.exec(file);
    if (!m) err('file must be <id>/v<N>.json');
    else {
      if (m[1] !== a.id) err('id ' + a.id + ' differs from its folder ' + m[1]);
      if (Number(m[2]) !== a.version) err('version ' + a.version + ' differs from the file name v' + m[2]);
    }
  }
  if (!isDate(a.published_at)) err('published_at must be YYYY-MM-DD');
  if (!text(a.title, 300)) err('title is required (up to 300 characters)');
  if (typeof a.policy !== 'string' || !ID.test(a.policy)) err('policy must be lowercase letters, digits and dashes');
  if (!Array.isArray(a.events) || !a.events.length || a.events.some(e => typeof e !== 'string' || !EVENT.test(e))) err('events must list policy event ids such as cdep:123');

  const keys = new Map();
  const add = (kind, k) => {
    if (typeof k !== 'string' || !KEY.test(k)) { err(kind + ': key ' + JSON.stringify(k) + ' is not a valid key'); return false; }
    if (keys.has(k)) { err(kind + '.' + k + ' is defined twice'); return false; }
    keys.set(k, kind); return true;
  };
  (Array.isArray(a.facts) ? a.facts : (err('facts must be a list'), [])).forEach(f => {
    if (!add('facts', f && f.key)) return;
    if (!text(f.text, 600)) err('facts.' + f.key + ': text is required');
    if (!https(f.source_url)) err('facts.' + f.key + ': source_url must be an https link');
    if (!isDate(f.source_date)) err('facts.' + f.key + ': source_date must be YYYY-MM-DD');
    if (f.value != null && typeof f.value !== 'number' && typeof f.value !== 'string') err('facts.' + f.key + ': value must be a number or text');
  });
  (Array.isArray(a.assumptions) ? a.assumptions : (err('assumptions must be a list'), [])).forEach(s => {
    if (!add('assumptions', s && s.key)) return;
    const k = 'assumptions.' + s.key;
    if (!text(s.label, 120)) err(k + ': label is required');
    if (!text(s.why, 600)) err(k + ': why is required');
    if (!Array.isArray(s.range) || s.range.length !== 2) { err(k + ': range [low, high] is required'); return; }
    const [lo, hi] = s.range, isDateKey = s.unit === 'date';
    const ok = isDateKey ? isDate(s.value) && isDate(lo) && isDate(hi) : [s.value, lo, hi].every(v => typeof v === 'number' && Number.isFinite(v));
    if (!ok) { err(k + ': value and range must be ' + (isDateKey ? 'dates' : 'numbers')); return; }
    if (lo > hi) err(k + ': range low is above high');
    else if (s.value < lo || s.value > hi) err(k + ': value ' + s.value + ' is outside its range [' + lo + ', ' + hi + ']');
  });
  REQUIRED.forEach(k => { if (keys.get(k) !== 'assumptions') err('assumptions.' + k + ' is required'); });
  const val = k => ((a.assumptions || []).find(x => x && x.key === k) || {}).value;
  if (keys.get('end') === 'assumptions' && !(isDate(val('end')) && val('end') >= val('start'))) err('assumptions.end must be a date on or after start');

  const b = a.budget || {};
  if (!['yes', 'no', 'unknown'].includes(b.approved)) err('budget.approved must be yes, no or unknown');
  ['approved_fact', 'funding_fact'].forEach(f => { if (b[f] != null && keys.get(b[f]) !== 'facts') err('budget.' + f + ' must name a fact'); });
  if (b.funding_source != null && !text(b.funding_source, 300)) err('budget.funding_source must be text or null');
  if (typeof b.recurring !== 'boolean') err('budget.recurring must be true or false');
  if (b.horizon_years != null && !(Number.isInteger(b.horizon_years) && b.horizon_years > 0 && b.horizon_years < 50)) err('budget.horizon_years must be a whole number or null');
  if (!text(b.sustainability_note, 600)) err('budget.sustainability_note is required');

  const sectors = (taxonomy && taxonomy.sectors) || {};
  (Array.isArray(a.sectors) ? a.sectors : (err('sectors must be a list'), [])).forEach(s => {
    if (!Object.prototype.hasOwnProperty.call(sectors, s)) err('sector ' + s + ' is unknown');
  });
  const seen = new Set();
  (Array.isArray(a.companies) ? a.companies : (err('companies must be a list'), [])).forEach(c => {
    const t = c && c.ticker;
    if (!tickers || !tickers.has(t)) { err('company ' + t + ' is unknown in the BVB catalog'); return; }
    if (seen.has(t)) err('company ' + t + ' is listed twice');
    seen.add(t);
    if (!text(c.why, 300)) err(t + ': why is required');
    const inputs = { revenue: 1, operating_profit: 1 };
    Object.keys(COMPANY_INPUTS).forEach(f => {
      const r = c[f];
      if (!r || typeof r !== 'object' || typeof r.ref !== 'string') { err(t + '.' + f + ' must be a ref to an assumption or fact, not a bare value'); return; }
      if (!keys.has(r.ref)) { err(t + '.' + f + ' refers to ' + r.ref + ', which is missing'); return; }
      inputs[COMPANY_INPUTS[f]] = I.resolve(a, r);
    });
    if (Object.keys(inputs).length === 6) {
      try { I.company(inputs, { impl_pct: 100, delay_months: 0, start: '2026-01-01' }); } catch (e) { err(t + ': ' + e.message); }
    }
  });
  (Array.isArray(a.risks) ? a.risks : (err('risks must be a list'), [])).forEach((r, i) => {
    if (!r || !RISKS.includes(r.kind)) err('risks[' + i + '].kind must be one of ' + RISKS.join(', '));
    if (!r || !text(r.text, 400)) err('risks[' + i + '].text is required');
  });
  if (!errors.length) {
    try { I.run(a, []); } catch (e) { err('budget: ' + e.message); }
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

// The assumption library (config/impact-assumptions.json): what an automatic analysis may
// assume. 'data' needs an official https source and its date; 'scenario' is a method choice
// (how much of a measure applies, how late) and says why. Every entry names the measure
// types it fits (ingest/impact/auto-validate.mjs MEASURE_TYPES).
export const MEASURE_TYPE_NAMES = ['tax_rate_change', 'budget_program', 'price_cap', 'contract_award'];
export function validateAssumptionLibrary(list) {
  const errors = [], err = m => errors.push(m), seen = new Set();
  if (!Array.isArray(list)) return { ok: false, errors: ['the library must be a list'] };
  list.forEach((a, i) => {
    const k = 'assumption ' + ((a && a.key) || '#' + i);
    if (!a || !KEY.test(a.key || '')) { err(k + ': key is invalid'); return; }
    if (seen.has(a.key)) err(k + ' is listed twice');
    seen.add(a.key);
    if (!text(a.label, 120)) err(k + ': label is required');
    if (!['data', 'scenario'].includes(a.kind)) err(k + ': kind must be data or scenario');
    if (!(typeof a.why === 'string' && a.why.trim().length >= 20 && a.why.length <= 600)) err(k + ': why must say the reason (20-600 characters)');
    if (a.kind === 'data') {
      if (!https(a.source_url)) err(k + ': source_url must be an https link to the official source');
      if (!isDate(a.source_date)) err(k + ': source_date is required');
    }
    if (!text(a.unit, 20)) err(k + ': unit is required');
    const r = a.range;
    if (!Array.isArray(r) || r.length !== 2 || !r.every(v => typeof v === 'number' && Number.isFinite(v)) || r[0] > r[1]) err(k + ': range must be [low, high] numbers');
    else if (!(typeof a.default === 'number' && a.default >= r[0] && a.default <= r[1])) err(k + ': default is outside its range');
    if (!Array.isArray(a.applies_to) || !a.applies_to.length || !a.applies_to.every(t => MEASURE_TYPE_NAMES.includes(t))) err(k + ': applies_to must list measure types (' + MEASURE_TYPE_NAMES.join(', ') + ')');
  });
  return { ok: !errors.length, errors };
}

export function validateFinancials(rows, { taxonomy, tickers } = {}) {
  const errors = [], seen = new Set(), sectors = (taxonomy && taxonomy.sectors) || {};
  if (!Array.isArray(rows)) return { ok: false, errors: ['financials must be a list'] };
  const pct = v => v == null || (typeof v === 'number' && v >= 0 && v <= 100);
  rows.forEach(r => {
    const k = (r && r.ticker) + ' ' + (r && r.fiscal_year), err = m => errors.push(k + ': ' + m);
    if (!tickers || !tickers.has(r.ticker)) { err(r.ticker + ' is unknown in the BVB catalog'); return; }
    if (seen.has(k)) err('listed twice');
    seen.add(k);
    if (!Number.isInteger(r.fiscal_year) || r.fiscal_year < 2000 || r.fiscal_year > 2100) err('fiscal_year must be a year');
    if (!['RON', 'EUR'].includes(r.currency)) err('currency must be RON or EUR');
    if (!(typeof r.revenue === 'number' && r.revenue >= 0 && r.revenue < 1e15)) err('revenue must be a number from 0');
    if (!(typeof r.operating_profit === 'number' && Math.abs(r.operating_profit) < 1e15)) err('operating_profit must be a number');
    if (r.net_profit != null && !(typeof r.net_profit === 'number' && Math.abs(r.net_profit) < 1e15)) err('net_profit must be a number or null');
    const geo = [r.geo_ro_pct, r.geo_eu_pct, r.geo_other_pct];
    if (!geo.every(pct) || geo.reduce((s, v) => s + (v || 0), 0) > 100.5) err('geo shares must be 0-100 and add up to at most 100');
    if (r.segments != null && (!Array.isArray(r.segments) || r.segments.some(s => !s || !Object.prototype.hasOwnProperty.call(sectors, s.sector) || !pct(s.pct)))) err('segments must list known sectors with a share 0-100');
    if (!https(r.source_url)) err('source_url must be an https link');
  });
  return errors.length ? { ok: false, errors } : { ok: true };
}

export function validateOutcomes(rows, versions) {
  const errors = [];
  if (!Array.isArray(rows)) return { ok: false, errors: ['outcomes must be a list'] };
  rows.forEach((o, i) => {
    const err = m => errors.push('outcomes[' + i + ']: ' + m);
    const a = (versions || []).find(v => v.version === o.version);
    if (!a) { err('version ' + o.version + ' is not published'); return; }
    if (!I.SCENARIOS.includes(o.scenario)) err('scenario must be one of ' + I.SCENARIOS.join(', '));
    const metric = o.subject === 'budget' ? 'budget_effect' : 'operating_profit_change';
    if (o.subject !== 'budget' && !(a.companies || []).some(c => c.ticker === o.subject)) err('subject ' + o.subject + ' is not in the analysis');
    if (o.metric !== metric) err('metric must be ' + metric + ' for ' + o.subject);
    if (!/^\d{4}$/.test(String(o.period))) err('period must be a year');
    if (!(typeof o.observed === 'number' && Number.isFinite(o.observed))) err('observed must be a number');
    if (!https(o.source_url)) err('source_url must be an https link');
  });
  return errors.length ? { ok: false, errors } : { ok: true };
}

// analyses/<id>/v<N>.json, with the sha256 of the bytes as stored.
export function loadAnalyses(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const id of readdirSync(dir).sort()) {
    const sub = join(dir, id);
    if (!statSync(sub).isDirectory()) continue;
    for (const f of readdirSync(sub).filter(f => /^v\d+\.json$/.test(f)).sort((x, y) => parseInt(x.slice(1)) - parseInt(y.slice(1)))) {
      const raw = readFileSync(join(sub, f));
      out.push({ path: id + '/' + f, json: JSON.parse(raw.toString('utf8')), hash: createHash('sha256').update(raw).digest('hex') });
    }
  }
  return out;
}
export function loadOutcomes(dir, id) {
  const f = join(dir, id, 'outcomes.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : [];
}

export function checkLock(list, lock) {
  const out = [], have = new Set();
  list.forEach(a => {
    have.add(a.path);
    if (!lock[a.path]) out.push(a.path + ' is not in analyses/LOCK.json (run npm run impact:lock)');
    else if (lock[a.path] !== a.hash) out.push(a.path + ' changed after publishing: publish a new version instead');
  });
  Object.keys(lock).forEach(p => { if (!have.has(p)) out.push(p + ' is missing: a published analysis is never removed'); });
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes('--lock')) {
  const dir = fileURLToPath(new URL('../../analyses/', import.meta.url));
  const lockFile = join(dir, 'LOCK.json');
  const lock = existsSync(lockFile) ? JSON.parse(readFileSync(lockFile, 'utf8')) : {};
  const list = loadAnalyses(dir);
  const bad = checkLock(list, lock).filter(m => !/not in analyses\/LOCK/.test(m));
  if (bad.length) { console.error(bad.join('\n')); process.exit(1); }
  list.forEach(a => { if (!lock[a.path]) { lock[a.path] = a.hash; console.log('locked ' + a.path); } });
  writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
}
