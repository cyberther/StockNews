import { failurePolicy } from './filings-retry.mjs';
// The figures in the Bucharest listings' filings (supabase/filings.sql), read by the local
// model in the summary job (tools/summarize-batch.mjs runs runFilings() after the digests).
//
// For each document of a kind that carries figures, newest first: its text (pdftotext for a
// PDF, the page's text otherwise), then one request for JSON in a fixed shape per kind,
// checked before it is saved. Scanned PDFs use local Docling OCR before model analysis.
// OCR errors remain pending for a later run; genuinely empty documents are marked none.
import { execFile } from 'node:child_process';
import { writeFileSync, readFileSync, rmSync, mkdtempSync, existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { offLimits } from './filings-lib.mjs';
import { EVIDENCE_RULES, evidenceSchema, checkEvidence, publicFigures } from './filings-evidence.mjs';

const MAX_DOC = 15 * 1024 * 1024;
export const EXTRACTION_VERSION = 'page-ocr-v2';
const MAX_CHARS_WITHOUT_TOKEN_COUNTER = 7000;
const exec = promisify(execFile);
const DOCLING_DIR = '/home/yoda/Documents/Codex/2026-10-22/inst/outputs/docling';
// Inspect every page, including mixed PDFs and defective embedded OCR layers.
// OCR failures propagate instead of returning a partial document.
export async function pdfText(buf, pages = 8, { log = () => {}, timeout = 240_000, run = exec, doclingDir = DOCLING_DIR } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mp-filing-')), f = join(dir, 'doc.pdf');
  try {
    writeFileSync(f, buf);
    let text = '';
    try {
      const out = await run('pdftotext', ['-layout', '-f', '1', '-l', String(pages), '-enc', 'UTF-8', f, '-'], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
      text = String(out.stdout || '');
    } catch { /* Docling can still recover a PDF that pdftotext cannot read. */ }
    const nativePages = text.split('\f');
    if (nativePages.at(-1)?.trim() === '') nativePages.pop();
    if (nativePages.length && nativePages.every(page => (page.match(/[\p{L}\p{N}]/gu) || []).length >= 80 && (page.match(/\uFFFD/g) || []).length < 3)) return compactDocument(text);
    const python = join(doclingDir, 'runtime/bin/python');
    const adapter = join(doclingDir, 'market-pulse-ocr.py');
    if (!existsSync(python) || !existsSync(adapter)) throw new Error('Docling OCR installation unavailable');
    if (timeout < 1000) throw new Error('No time remaining for OCR; retry next run');
    log('filings: scanned or damaged page text; running oriented page OCR/cache');
    const out = await run(python, [adapter, f, String(pages), '--json'], {
      timeout, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, OMP_NUM_THREADS: '2', MKL_NUM_THREADS: '2' }
    });
    let result;
    try { result = JSON.parse(out.stdout); } catch { throw Object.assign(new Error('Invalid page OCR JSON'), { code: 'OCR_INVALID_RESPONSE' }); }
    if (typeof result.text !== 'string' || !Array.isArray(result.pages) || result.pipeline !== EXTRACTION_VERSION) throw Object.assign(new Error('Invalid page OCR output'), { code: 'OCR_INVALID_RESPONSE' });
    log('filings OCR:', result.cache_hit ? 'cache hit' : 'converted', JSON.stringify(result.pages));
    return compactDocument(result.text);
  } catch (error) {
    if (/OrientationUncertain/.test(String(error.stderr || error.message || ''))) error.code = 'OCR_UNCERTAIN';
    if (/DocumentTextTooLarge/.test(String(error.stderr || error.message || '')) || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') error.code = 'DOCUMENT_CONTEXT_LIMIT';
    throw error;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
export function compactDocument(text) {
  return squeeze(String(text || '').split('\n').filter(line => !/^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(line) && line.trim() !== '<!-- image -->')
    .map(line => line.trim().startsWith('|') ? line.split('|').map(cell => cell.trim()).join(' | ') : line).join('\n'));
}
export function answerBudget(kind, { tokens, contextLength }) {
  const available = Math.floor(contextLength - tokens - 512);
  const minimum = kind === 'insider' ? 1800 : kind === 'agm' ? 1600 : 1200;
  if (!Number.isFinite(available) || available < minimum) throw Object.assign(new Error('Full document exceeds safe model context; retained for review without truncation'), { code: 'DOCUMENT_CONTEXT_LIMIT' });
  return Math.min(2500, available);
}
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
  try { rows = await rpc('filings_pending', { p_secret: cfg.secret, p_limit: deps.retry ? 50 : limit }) || []; }
  catch (e) { log('filings:', String(e.message || e)); return undefined; }
  rows = rows.filter(f => !deps.retry || deps.retry.ready(f.id)).slice(0, limit);
  for (const f of rows) {
    if (deps.deadline && Date.now() > deps.deadline) { log('filings: time is up for this run'); break; }
    const t0 = Date.now();
    // The observer is optional and fail-open; its output never enters filings_save.
    const observe = async (method, value) => { try { await deps.observe?.[method]?.(value); } catch { try { log('shadow observer failed', f.id, method); } catch {} } };
    const save = async (status, data) => {
      const result = await rpc('filings_save', { p_secret: cfg.secret, p_id: f.id, p_status: status, p_data: data || null, p_model: data?.extraction?.version || cfg.model });
      await observe('complete', { id: f.id, status, data: data || null }); return result;
    };
    const failed = async error => {
      const policy = deps.retry ? deps.retry.fail(f.id, error) : failurePolicy(error, 1);
      deps.onFailure?.(error);
      if (!policy.retryable || !deps.retry) await save('failed');
      else await observe('complete', { id: f.id, status: 'deferred', reason: error.code || 'retryable_error' });
      log('filing failure policy', f.id, JSON.stringify(policy));
    };
    try {
      if (f.kind === 'agm' && !AGM_READ.test(foldName(f.title))) { await save('skipped'); continue; }
      if (offLimits(f.url) || !(await allowed(f.url))) { await save('skipped'); log('filing', f.id, f.ticker, 'not readable (robots.txt)'); continue; }
      let r;
      try { r = await httpGet(f.url, { timeout: 30000, accept: 'application/pdf, text/html', binary: true, maxBytes: MAX_DOC, ua: deps.ua }); }
      catch (e) { await failed(e); log('filing', f.id, f.ticker, 'download failed', String(e.message || e)); continue; }
      if (r.status !== 200) { await failed(Object.assign(new Error(`Source HTTP ${r.status}`), {status:r.status})); log('filing', f.id, f.ticker, 'HTTP', r.status); continue; }
      const isPdf = /pdf/i.test(r.type) || r.body.slice(0, 5).toString('latin1') === '%PDF-';
      if (isPdf) await observe('source', { filing: f, pdf: r.body, origin: deps.observationOrigin || 'pending' });
      const text = compactDocument(isPdf ? await (deps.pdfText || pdfText)(r.body, 8, { log, timeout: Math.min(240_000, deps.deadline ? deps.deadline - Date.now() : 240_000) }) : htmlText(r.body.toString('utf8')));
      if (isPdf) await observe('text', { id: f.id, text });
      if (text.replace(/\s/g, '').length < 200) { await save('none'); log('filing', f.id, f.ticker, 'no usable text after extraction/OCR'); continue; }
      if (isPdf && deps.selective && ['dividend', 'results'].includes(f.kind)) {
        let selected = null;
        try { selected = await deps.selective({ filing: f, pdf: r.body, text, deadline: deps.deadline }); }
        catch { log('selective fallback', f.id, 'extractor unavailable'); }
        if (selected && !checkFigures(f.kind, selected)) {
          await save('ok', selected);
          try { deps.retry?.clear(f.id); } catch {}
          log('saved selective filing', f.id, f.ticker, f.kind);
          continue;
        }
      }
      const input = `Company: ${f.ticker}\nDocument title: ${f.title}\nPublished: ${f.published_at ? String(f.published_at).slice(0, 10) : 'unknown'}\n\n${ASK[f.kind]}\n\n${EVIDENCE_RULES[f.kind] || ''}\n\nDocument text:\n${text}`;
      let data = null, why = 'no reply', evidenceError = '';
      for (const temperature of [0, 0.3]) {
        const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: input + (temperature ? `\n\nPrevious extraction was rejected: ${why}. Re-read the source and correct it. Evidence must be a single short verbatim phrase, no ellipses, no added quotation marks, no omitted words. For a proposal prefer its literal proposal heading. Use null when the financial basis is unknown.` : '') }];
        if (!deps.measureInput && text.length > MAX_CHARS_WITHOUT_TOKEN_COUNTER) throw Object.assign(new Error('Full document needs token-budget verification; no silent truncation'), { code: 'DOCUMENT_CONTEXT_LIMIT' });
        const maxTokens = deps.measureInput ? answerBudget(f.kind, await deps.measureInput(messages)) : 2500;
        const res = await postJson(`${cfg.lmUrl}/chat/completions`, { model: cfg.model, temperature, max_tokens: maxTokens,
          response_format: { type: 'json_schema', json_schema: { name: f.kind, strict: true, schema: evidenceSchema(f.kind, SCHEMAS[f.kind]) } },
          messages }, 900_000);
        if (res.status !== 200) throw Object.assign(new Error(`model: ${res.status} ${res.body.slice(0, 200)}`), {status:res.status});
        const d = JSON.parse(res.body);
        if (d.choices?.[0]?.finish_reason === 'length') throw Object.assign(new Error('Model response truncated; full extraction not saved'), { code: 'MODEL_TRUNCATED' });
        data = parseJson(d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content);
        const figuresError = checkFigures(f.kind, data);
        evidenceError = figuresError ? '' : checkEvidence(f.kind, data, text);
        why = figuresError || evidenceError;
        if (!why) break;
      }
      if (why) { if (evidenceError) await failed(Object.assign(new Error(why), {code:'EVIDENCE_INVALID'})); else await save('none'); log('filing', f.id, f.ticker, f.kind, evidenceError ? 'evidence validation failed -' : 'no figures -', why); continue; }
      await save('ok', publicFigures(data));
      try { deps.retry?.clear(f.id); } catch (error) { log('retry registry cleanup failed', f.id, error.message); }
      log('saved filing', f.id, f.ticker, f.kind, `${Math.round((Date.now() - t0) / 1000)}s`);
    } catch (e) {
      await failed(e);
      log('filing failed', f.id, f.ticker, String(e.message || e));
    }
  }
  return rows.length;
}
