// The figures in the Bucharest listings' filings (supabase/filings.sql), read by the local
// model in the summary job (tools/summarize-batch.mjs runs runFilings() after the digests).
//
// For each document of a kind that carries figures, newest first: its text (pdftotext for a
// PDF, the page's text otherwise), then one request for JSON in a fixed shape per kind,
// checked before it is saved. A scanned PDF without text, or a reply that fails the checks,
// is marked so it isn't read again.
import { execFile } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { offLimits } from './filings-lib.mjs';

const MAX_DOC = 15 * 1024 * 1024;
const MAX_CHARS = 7000;   // a filing's key figures are on its first pages; at CPU speed
export const pdfText = (buf, pages = 8) => new Promise(resolve => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-filing-')), f = join(dir, 'doc.pdf');
  writeFileSync(f, buf);
  execFile('pdftotext', ['-layout', '-f', '1', '-l', String(pages), '-enc', 'UTF-8', f, '-'], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
    try { unlinkSync(f); } catch {}
    resolve(err ? '' : String(out || ''));
  });
});
export const htmlText = h => String(h || '').replace(/<(script|style|noscript|nav|header|footer|form)[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n))
  .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
// Long tables come out of pdftotext as runs of spaces; the model needs the words and numbers.
export const squeeze = t => t.replace(/[ \t]{3,}/g, '  ').replace(/\n{3,}/g, '\n\n').trim();

// ------------------------------------------------------------------ shapes
const num = { type: ['number', 'null'] }, str = { type: ['string', 'null'] };
const SCHEMAS = {
  insider: { type: 'object', additionalProperties: false, required: ['transactions'], properties: {
    transactions: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false,
      required: ['date', 'person', 'role', 'type', 'shares', 'price', 'currency', 'value'],
      properties: { date: str, person: { type: 'string' }, role: str, type: { type: 'string', enum: ['buy', 'sell', 'other'] }, shares: num, price: num, currency: str, value: num } } } } },
  results: { type: 'object', additionalProperties: false,
    required: ['period', 'period_end', 'consolidated', 'currency', 'revenue', 'revenue_prev', 'net_profit', 'net_profit_prev', 'ebitda', 'eps'],
    properties: { period: str, period_end: str, consolidated: { type: ['boolean', 'null'] }, currency: str, revenue: num, revenue_prev: num, net_profit: num, net_profit_prev: num, ebitda: num, eps: num } },
  dividend: { type: 'object', additionalProperties: false, required: ['fiscal_year', 'gross_dps', 'currency', 'status', 'record_date', 'ex_date', 'payment_date'],
    properties: { fiscal_year: { type: ['integer', 'null'] }, gross_dps: num, currency: str, status: { type: 'string', enum: ['proposed', 'approved', 'paid', 'none'] }, record_date: str, ex_date: str, payment_date: str } },
  agm: { type: 'object', additionalProperties: false, required: ['meeting_date', 'meeting_type', 'decisions', 'dividend_dps'],
    properties: { meeting_date: str, meeting_type: str, decisions: { type: 'array', maxItems: 6, items: { type: 'string' } }, dividend_dps: num } },
  holding: { type: 'object', additionalProperties: false, required: ['holder', 'before_pct', 'after_pct', 'date'],
    properties: { holder: { type: 'string' }, before_pct: num, after_pct: num, date: str } }
};
const ASK = {
  insider: 'This is a notification of transactions by a person discharging managerial responsibilities (MAR art. 19) or a closely associated person. List each transaction: date (YYYY-MM-DD), the person\'s name, their role (as written, e.g. "Director general", "Membru CA"), type (buy for acquisition/subscription/cumpărare, sell for disposal/vânzare, other for gifts, grants, pledges), number of shares, unit price, currency (RON, EUR...), total value. Aggregated lines count once. Use null for anything not stated.',
  results: 'These are financial results. Give the period as written in Romanian style (e.g. "T3 2026", "S1 2026", "9L 2026", "2025"), its end date (YYYY-MM-DD), whether the figures are consolidated (group), the currency, and in MILLIONS of that currency: revenue (cifra de afaceri / venituri totale / revenues), the same period of the previous year, net profit (profit net; attributable to the parent if both), previous year, EBITDA, and earnings per share (in currency units, not millions). Use null for anything not stated. Do not compute anything not in the text.',
  dividend: 'This document concerns dividends. Give the fiscal year the dividend is paid from, the gross dividend per share, currency, status (proposed if only proposed or to be voted, approved if a general meeting approved it, paid if it announces the payment, none if no dividend is distributed), record date (data de înregistrare), ex-date (ex-dividend date), payment date (data plății), all YYYY-MM-DD or null.',
  agm: 'This concerns a general meeting of shareholders. Give the meeting date (YYYY-MM-DD, the first convening), its type (AGOA, AGEA or AGOA+AGEA), up to 6 of its main agenda items or decisions as short Romanian phrases (max 12 words each; e.g. "Aprobarea situațiilor financiare 2025", "Dividend brut 0,05 lei/acțiune"), and the gross dividend per share if one is proposed or approved, else null.',
  holding: 'This is a notification of a major holding (crossing a threshold of voting rights). Give the holder\'s name, the percentage of voting rights before and after, and the date the threshold was crossed (YYYY-MM-DD), null when not stated.'
};
const SYSTEM = 'You read regulatory filings of companies listed in Bucharest and return the requested figures as JSON exactly in the given shape. Copy figures from the text; never guess or calculate missing ones. Romanian numbers use dots for thousands and commas for decimals (1.234,5 = 1234.5).';

// ------------------------------------------------------------------ checks
const dateOk = d => d == null || (/^\d{4}-\d{2}-\d{2}$/.test(d) && d >= '1995-01-01' && d <= '2100-01-01');
const finite = v => v == null || (typeof v === 'number' && Number.isFinite(v));
export function checkFigures(kind, d) {
  if (!d || typeof d !== 'object') return 'no object';
  if (kind === 'insider') {
    const t = (d.transactions || []).filter(x => x && String(x.person || '').trim().length >= 3);
    if (!t.length) return 'no transaction';
    if (!t.every(x => dateOk(x.date) && finite(x.shares) && finite(x.price) && finite(x.value) && (x.shares == null || x.shares >= 0))) return 'bad numbers';
    d.transactions = t;
    return '';
  }
  if (kind === 'results') {
    if (d.revenue == null && d.net_profit == null) return 'no figures';
    if (!['revenue', 'revenue_prev', 'net_profit', 'net_profit_prev', 'ebitda', 'eps'].every(k => finite(d[k])) || !dateOk(d.period_end)) return 'bad numbers';
    if (Math.abs(d.revenue || 0) > 1e6 || Math.abs(d.net_profit || 0) > 1e6) return 'not in millions';
    return '';
  }
  if (kind === 'dividend') {
    if (d.status !== 'none' && d.gross_dps == null) return 'no dividend';
    if (!finite(d.gross_dps) || (d.gross_dps != null && (d.gross_dps < 0 || d.gross_dps > 10000))) return 'bad dividend';
    if (![d.record_date, d.ex_date, d.payment_date].every(dateOk)) return 'bad date';
    return '';
  }
  if (kind === 'agm') {
    if (!dateOk(d.meeting_date) || !finite(d.dividend_dps)) return 'bad values';
    d.decisions = (d.decisions || []).map(x => String(x).trim()).filter(x => x.length >= 4).slice(0, 6);
    if (!d.meeting_date && !d.decisions.length) return 'empty';
    return '';
  }
  if (kind === 'holding') {
    const ok = p => p == null || (typeof p === 'number' && p >= 0 && p <= 100);
    if (!String(d.holder || '').trim() || !ok(d.before_pct) || !ok(d.after_pct) || d.after_pct == null || !dateOk(d.date)) return 'bad values';
    return '';
  }
  return 'unknown kind';
}
export function parseJson(text) {
  const s = String(text || '').replace(/^```(?:json)?\s*|\s*```$/g, '');
  try { return JSON.parse(s); } catch {}
  const m = /\{[\s\S]*\}/.exec(s);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}
// General-meeting papers that carry no decisions: proxies, forms, CVs, reports to the meeting.
const AGM_READ = /convoca|hotarar|decizi|resolution|decision|convening|rezultat(?:ul|e)? vot|raport curent/i;
const foldName = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');

// ------------------------------------------------------------------ run
// deps: { cfg: { secret, lmUrl, model }, rpc, postJson, httpGet, allowed(url), log, ua, deadline (ms) }
export async function runFilings(limit, deps) {
  const { cfg, rpc, postJson, httpGet, allowed, log } = deps;
  // Returns how many filings the queue gave (fewer than limit: it is empty), or undefined when
  // it could not be read.
  if (!limit) return 0;
  let rows = [];
  try { rows = await rpc('filings_pending', { p_secret: cfg.secret, p_limit: limit }) || []; }
  catch (e) { log('filings:', String(e.message || e)); return undefined; }
  for (const f of rows) {
    if (deps.deadline && Date.now() > deps.deadline) { log('filings: time is up for this run'); break; }
    const t0 = Date.now();
    const save = (status, data) => rpc('filings_save', { p_secret: cfg.secret, p_id: f.id, p_status: status, p_data: data || null, p_model: cfg.model });
    try {
      if (f.kind === 'agm' && !AGM_READ.test(foldName(f.title))) { await save('skipped'); continue; }
      if (offLimits(f.url) || !(await allowed(f.url))) { await save('skipped'); log('filing', f.id, f.ticker, 'not readable (robots.txt)'); continue; }
      let r;
      try { r = await httpGet(f.url, { timeout: 30000, accept: 'application/pdf, text/html', binary: true, maxBytes: MAX_DOC, ua: deps.ua }); }
      catch (e) { await save('failed'); log('filing', f.id, f.ticker, 'download failed', String(e.message || e)); continue; }
      if (r.status !== 200) { await save('failed'); log('filing', f.id, f.ticker, 'HTTP', r.status); continue; }
      const isPdf = /pdf/i.test(r.type) || r.body.slice(0, 5).toString('latin1') === '%PDF-';
      const text = squeeze(isPdf ? await pdfText(r.body) : htmlText(r.body.toString('utf8'))).slice(0, MAX_CHARS);
      if (text.replace(/\s/g, '').length < 200) { await save('none'); log('filing', f.id, f.ticker, 'no text (scanned?)'); continue; }
      const input = `Company: ${f.ticker}\nDocument title: ${f.title}\nPublished: ${f.published_at ? String(f.published_at).slice(0, 10) : 'unknown'}\n\n${ASK[f.kind]}\n\nDocument text:\n${text}`;
      let data = null, why = 'no reply';
      for (const temperature of [0, 0.3]) {
        const res = await postJson(`${cfg.lmUrl}/chat/completions`, { model: cfg.model, temperature, max_tokens: 2500,
          response_format: { type: 'json_schema', json_schema: { name: f.kind, strict: true, schema: SCHEMAS[f.kind] } },
          messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: input }] }, 900_000);
        if (res.status !== 200) throw new Error(`model: ${res.status} ${res.body.slice(0, 200)}`);
        const d = JSON.parse(res.body);
        data = parseJson(d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content);
        why = checkFigures(f.kind, data);
        if (!why) break;
      }
      if (why) { await save('none'); log('filing', f.id, f.ticker, f.kind, 'no figures -', why); continue; }
      await save('ok', data);
      log('saved filing', f.id, f.ticker, f.kind, `${Math.round((Date.now() - t0) / 1000)}s`);
    } catch (e) { log('filing failed', f.id, f.ticker, String(e.message || e)); }
  }
  return rows.length;
}
