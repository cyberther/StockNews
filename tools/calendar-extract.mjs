// The Bucharest listings' financial calendars (supabase/calendar.sql), read by the local
// model in the summary job (tools/summarize-batch.mjs runs runCalendars() when it has no
// summaries to write, before the filings' figures).
//
// For each calendar the crawler found: its text (pdftotext for a PDF, the page's text
// otherwise); when the text is the same as at the last read, nothing more. Otherwise one
// request for the dated events as JSON, checked, then saved: the next results date, the
// general meeting, the dividend dates. Read again weekly, since calendars change.
import { createHash } from 'node:crypto';
import { offLimits, publishedDay } from './filings-lib.mjs';
import { pdfText, htmlText, squeeze, parseJson } from './filings-extract.mjs';

const MAX_DOC = 15 * 1024 * 1024;
const MAX_CHARS = 9000;
export const KINDS = ['results', 'annual_report', 'trading_update', 'agm', 'ex_dividend', 'record_date', 'payment_date'];
const SCHEMA = { type: 'object', additionalProperties: false, required: ['events'], properties: {
  events: { type: 'array', maxItems: 30, items: { type: 'object', additionalProperties: false,
    required: ['kind', 'year', 'quarter', 'date', 'time', 'label'],
    properties: { kind: { type: 'string', enum: KINDS }, year: { type: 'integer' }, quarter: { type: ['integer', 'null'] },
      date: { type: 'string' }, time: { type: ['string', 'null'], enum: ['bmo', 'amc', null] }, label: { type: 'string' } } } } } };
const SYSTEM = 'You read the financial calendars of companies listed in Bucharest and return their dated events as JSON exactly in the given shape. Copy dates from the text; never guess one. Romanian dates are day.month.year (15.05.2026 = 2026-05-15).';
const ASK = today => `This is a company's financial calendar (calendar financiar / calendar de comunicare financiară). Today is ${today}. List every event that has one exact date:
- kind "results": a publication of financial results. year = the fiscal year the results are for; quarter: 1 for Q1 / T1 / January-March, 2 for the half year / S1 / semestrial / Q2, 3 for Q3 / T3 / 9 months / January-September, 4 for the preliminary yearly results / raportare preliminară / Q4.
- kind "annual_report": the annual report (raport anual). year = the fiscal year; quarter null.
- kind "trading_update": a trading update. year and quarter as for results.
- kind "agm": a general meeting of shareholders (AGA, AGOA, AGEA, adunarea generală). year = the year of the meeting; quarter null. Only its first convening.
- kind "ex_dividend" (ex-date / data ex-dividend), "record_date" (data de înregistrare), "payment_date" (data plății dividendelor): year = the year of the date; quarter null.
date: YYYY-MM-DD. time: "bmo" when published before the market opens (before 10:00, "înainte de deschiderea"), "amc" after it closes (after 17:45, "după închiderea"), else null. label: the event as written, max 8 words.
date is the day the event happens or the document is published, never the end of the period reported on ("Raportul trimestrial la 30.09.2026" is published later, on its own date).
In a table, a row's date belongs to every event in that row (results published with their conference call share its date).
Skip quiet periods, date ranges, conference calls, and events with no exact date.`;

// A calendar page's table: each row on one line, its cells split by " | ", so the date in
// the last cell stays with the event in the first (Petrom's rows hold the results, the call
// and the press conference above one date).
export const tableRows = html => String(html || '').replace(/<tr[\s>][\s\S]*?<\/tr>/gi, row =>
  '\n' + row.replace(/<br\s*\/?>|<\/(?:p|div|li|span)>/gi, ' ').replace(/<\/t[dh]>/gi, ' | ').replace(/\n/g, ' ') + '\n');

// Checks the model's events; returns the ones fit to save ({ kind, year, q, day, hour, label }).
// .wrong counts events dropped for a date that can't be right (results dated before their
// quarter ended: the model took the period's end for the publication day).
export function checkEvents(d, today = new Date().toISOString().slice(0, 10)) {
  const out = new Map();
  let wrong = 0;
  const done = () => Object.assign([...out.values()], { wrong });
  if (!d || !Array.isArray(d.events)) return done();
  const t = Date.parse(today + 'T00:00:00Z');
  for (const e of d.events) {
    if (!e || !KINDS.includes(e.kind) || !/^\d{4}-\d{2}-\d{2}$/.test(e.date || '')) continue;
    const at = Date.parse(e.date + 'T00:00:00Z');
    if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== e.date) continue;
    if (at < t - 400 * 86400000 || at > t + 500 * 86400000) continue;
    const dy = +e.date.slice(0, 4);
    let year = Number.isInteger(e.year) ? e.year : dy, q = 0;
    if (e.kind === 'results' || e.kind === 'trading_update') {
      q = Number.isInteger(e.quarter) && e.quarter >= 1 && e.quarter <= 4 ? e.quarter : 0;
      if (!q) continue;
      // Results come out in their year or the next one, after their quarter has ended.
      if (year !== dy && year !== dy - 1) continue;
      if (e.date <= new Date(Date.UTC(year, q * 3, 0)).toISOString().slice(0, 10)) { wrong++; continue; }
    } else if (e.kind === 'annual_report') {
      if (year !== dy - 1 && year !== dy) continue;
    } else {
      year = dy;
      if (e.kind === 'agm') q = +e.date.slice(5, 7);
    }
    const hour = e.time === 'bmo' || e.time === 'amc' ? e.time : null;
    out.set(e.kind + '|' + year + '|' + q, { kind: e.kind, year, q, day: e.date, hour, label: String(e.label || '').trim().slice(0, 120) });
  }
  return done();
}

// deps: { cfg: { secret, lmUrl, model }, rpc, postJson, httpGet, allowed(url), log, ua, deadline (ms) }
export async function runCalendars(limit, deps) {
  const { cfg, rpc, postJson, httpGet, allowed, log } = deps;
  if (!limit) return;
  let rows = [];
  try { rows = await rpc('calendar_pending', { p_secret: cfg.secret, p_limit: limit }) || []; }
  catch (e) { log('calendars:', String(e.message || e)); return; }
  for (const c of rows) {
    if (deps.deadline && Date.now() > deps.deadline) { log('calendars: time is up for this run'); break; }
    const t0 = Date.now();
    const docDay = publishedDay(c.title + ' ' + c.url, c.url) || null;
    const save = (status, hash, events) => rpc('calendar_save', { p_secret: cfg.secret, p_url: c.url, p_status: status, p_hash: hash || null,
      p_events: events || [], p_model: cfg.model, p_doc_day: docDay });
    try {
      if (offLimits(c.url) || !(await allowed(c.url))) { await save('skipped'); log('calendar', c.ticker, 'not readable (robots.txt)'); continue; }
      let r;
      try { r = await httpGet(c.url, { timeout: 30000, accept: 'application/pdf, text/html', binary: true, maxBytes: MAX_DOC, ua: deps.ua }); }
      catch (e) { await save('failed'); log('calendar', c.ticker, 'download failed', String(e.message || e)); continue; }
      if (r.status !== 200) { await save('failed'); log('calendar', c.ticker, 'HTTP', r.status); continue; }
      const isPdf = /pdf/i.test(r.type) || r.body.slice(0, 5).toString('latin1') === '%PDF-';
      let text = squeeze(isPdf ? await pdfText(r.body, 4) : htmlText(tableRows(r.body.toString('utf8'))));
      // A page: from a little before its first mention of the calendar (past the menus).
      if (!isPdf) { const i = text.search(/calendar|financial calendar/i); if (i > 600) text = text.slice(i - 300); }
      text = text.slice(0, MAX_CHARS);
      if (text.replace(/\s/g, '').length < 120) { await save('none'); log('calendar', c.ticker, 'no text (scanned?)'); continue; }
      const hash = createHash('sha1').update(text).digest('hex');
      if (c.content_hash === hash) { await save('same', hash); log('calendar', c.ticker, 'unchanged'); continue; }
      const today = new Date().toISOString().slice(0, 10);
      const input = `Company: ${c.ticker}\nDocument title: ${c.title || '(none)'}\nAddress: ${c.url}\n\n${ASK(today)}\n\nDocument text:\n${text}`;
      // A second try when the first reply has no dates or a wrong one; the better reply is kept.
      let events = [];
      for (const temperature of [0, 0.3]) {
        const res = await postJson(`${cfg.lmUrl}/chat/completions`, { model: cfg.model, temperature, max_tokens: 3000,
          response_format: { type: 'json_schema', json_schema: { name: 'calendar', strict: true, schema: SCHEMA } },
          messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: input }] }, 900_000);
        if (res.status !== 200) throw new Error(`model: ${res.status} ${res.body.slice(0, 200)}`);
        const d = JSON.parse(res.body);
        const got = checkEvents(parseJson(d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content), today);
        if (!events.length || got.wrong < events.wrong || (got.wrong === events.wrong && got.length > events.length)) events = got;
        if (events.length && !events.wrong) break;
      }
      if (!events.length) { await save('none', hash); log('calendar', c.ticker, 'no dates', c.url); continue; }
      const n = await save('ok', hash, events);
      log('saved calendar', c.ticker, `${events.length} dates (${n} new or moved)`, `${Math.round((Date.now() - t0) / 1000)}s`);
    } catch (e) { log('calendar failed', c.ticker, String(e.message || e)); }
  }
}
