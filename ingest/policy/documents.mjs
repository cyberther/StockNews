// The documents behind each policy event (docs/plans/2026-10-19-politici-automat-design.md):
// for a Chamber project, its explanatory memorandum, the Fiscal Council's opinion, the financial
// sheet and the law as adopted; for a government decision, its note (with the financial impact
// section); for a ministry release, the release. Their text (pdftotext for PDFs; scanned PDFs
// have none and stay unreadable: no OCR, whose misread digits would pass as facts) is joined into
// one bundle per event, stored in policy_documents, and every event gets a base fact sheet.
//
// The Chamber does not answer GitHub's runners, so its documents are read by the local batch on
// the owner's PC (tools/policy-auto-batch.mjs); the ingestion reads the other sources.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { text as htmlText } from './common.mjs';
import { figures } from './classify.mjs';

export const MAX_PDF_BYTES = 15 * 1024 * 1024;
export const MAX_TEXT = 400000;
const UA = 'MarketPulse/1.0 (+https://www.marketpulse.ro)';
// The order parts are joined in: the ones with figures first.
const ORDER = ['note', 'fiscal_council', 'financial', 'motive', 'law', 'initiator', 'act', 'press'];
const MONEY = new Set(['note', 'fiscal_council', 'financial']);

// [{ kind, url }] worth reading for an event, one per kind.
export function documentLinks(event, html) {
  const id = String(event && event.id || '');
  if (id.startsWith('gov:')) return [{ kind: 'note', url: event.source_url }];
  if (id.startsWith('mf:')) return [{ kind: 'press', url: event.source_url }];
  if (id.startsWith('just:')) return [{ kind: 'act', url: event.source_url }];
  if (!id.startsWith('cdep:')) return [];
  const abs = h => h.startsWith('http') ? h : h.startsWith('/') ? 'https://www.cdep.ro' + h : 'https://www.cdep.ro/ords/pls/proiecte/' + h;
  const found = {};
  for (const m of String(html || '').matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = m[1], link = /href="([^"]+\.pdf)"/i.exec(row);
    if (!link || /\/comisii\//.test(link[1])) continue;
    const label = htmlText(row).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[şș]/g, 's').replace(/[ţț]/g, 't');
    const url = abs(link[1]);
    if (/expunerea de motive/.test(label)) found.motive = found.motive || url;
    else if (/opinia consiliului fiscal/.test(label)) found.fiscal_council = found.fiscal_council || url;
    else if (/fisa financiara|fisei financiare/.test(label)) found.financial = found.financial || url;
    else if (/forma pentru promulgare/.test(label)) found.law = url;
    else if (/adoptat de (camera|senat)/.test(label) && !/promulgare/.test(found.lawFrom || '')) { found.law = url; found.lawFrom = 'adopted'; }
    else if (/forma initiatorului/.test(label)) found.initiator = found.initiator || url;
  }
  if (found.law && /forma pentru promulgare/.test(String(html).normalize('NFD'))) {
    const promo = [...String(html).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(x => x[1]).find(r => /Forma pentru promulgare/i.test(r) && /\.pdf"/i.test(r));
    if (promo) found.law = abs(/href="([^"]+\.pdf)"/i.exec(promo)[1]);
  }
  delete found.lawFrom;
  if (found.law) delete found.initiator;
  return ORDER.filter(k => found[k]).map(k => ({ kind: k, url: found[k] }));
}

function pdftotext(buf) {
  return new Promise(resolve => {
    const p = spawn('pdftotext', ['-layout', '-enc', 'UTF-8', '-', '-'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const out = [];
    let size = 0;
    const timer = setTimeout(() => p.kill('SIGKILL'), 30000);
    p.stdout.on('data', d => { size += d.length; if (size <= MAX_TEXT * 4) out.push(d); });
    p.on('error', () => { clearTimeout(timer); resolve(null); });
    p.on('close', code => { clearTimeout(timer); resolve(code === 0 ? Buffer.concat(out).toString('utf8') : null); });
    p.stdin.on('error', () => {});
    p.stdin.end(buf);
  });
}

// { status: 'ok' | 'unreadable', text }. A PDF with (almost) no text is a scan: unreadable.
export async function extractText(buf, contentType) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || '');
  const isPdf = /pdf/i.test(contentType || '') || b.subarray(0, 5).toString('latin1') === '%PDF-';
  if (isPdf) {
    if (b.length > MAX_PDF_BYTES || b.subarray(0, 5).toString('latin1') !== '%PDF-') return { status: 'unreadable', text: '' };
    const raw = await pdftotext(b);
    const t = raw == null ? '' : raw.replace(/\f/g, '\n').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return t.replace(/\s/g, '').length < 20 ? { status: 'unreadable', text: '' } : { status: 'ok', text: t.slice(0, MAX_TEXT) };
  }
  const t = htmlText(b.toString('utf8').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<\/?(?:b|i|u|em|strong|span|a|sup|sub|font)\b[^>]*>/gi, ''));
  return t.length < 20 ? { status: 'unreadable', text: '' } : { status: 'ok', text: t.slice(0, MAX_TEXT) };
}

const sha = s => createHash('sha256').update(s).digest('hex');
// One text per event: the readable parts in a fixed order; parts[i].from/to say where each is.
export function bundle(parts) {
  const ok = p => p.status === 'ok' && !!p.text;
  const sorted = [...(parts || [])].sort((a, b) => (ok(b) - ok(a)) || ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || String(a.url).localeCompare(String(b.url)));
  let text = '';
  const meta = sorted.map(p => {
    if (p.status !== 'ok' || !p.text) return { kind: p.kind, url: p.url, status: 'unreadable' };
    if (text) text += '\n\n';
    const from = text.length;
    text += p.text;
    return { kind: p.kind, url: p.url, status: 'ok', from, to: text.length };
  });
  text = text.slice(0, MAX_TEXT);
  const read = meta.filter(p => p.status === 'ok');
  return { status: read.length ? 'ok' : 'unreadable', text, parts: meta, url: (read[0] || meta[0] || {}).url || null,
    sha256: sha(read.length ? text : 'unreadable\n' + meta.map(p => p.url).join('\n')) };
}

// What every event shows before (or without) the local batch, and why there is no analysis.
export function baseSheet(event, docs) {
  const base = { stage: event.stage || null, status: event.status || null, institution: event.institution || null, date: event.event_date || null,
    sectors: event.sectors || [], companies: event.companies || [], source_url: event.source_url || null,
    figures: figures([event.title, event.summary].filter(Boolean).join(' ')),
    documents: docs ? docs.parts.map(p => ({ kind: p.kind, url: p.url, status: p.status })) : [] };
  if (!docs) return { base, reasons: ['ai_pending'] };
  if (docs.status !== 'ok') return { base, reasons: ['source_unreadable'] };
  const money = docs.parts.some(p => p.status === 'ok' && MONEY.has(p.kind)) || /impactul financiar|fi[sș]a financiar/i.test(docs.text);
  return { base, reasons: money ? ['ai_pending'] : ['ai_pending', 'no_financial_sheet'] };
}

// Downloads one document: { kind, url, status, text }.
export async function readDocument(link, fetchImpl = fetch) {
  try {
    const r = await fetchImpl(link.url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(45000) });
    if (!r.ok) return { ...link, status: 'unreadable', text: '' };
    const len = Number(r.headers.get('content-length') || 0);
    if (len > MAX_PDF_BYTES) return { ...link, status: 'unreadable', text: '' };
    const buf = Buffer.from(await r.arrayBuffer());
    return { ...link, ...(await extractText(buf, r.headers.get('content-type') || '')) };
  } catch (e) {
    return { ...link, status: 'unreadable', text: '' };
  }
}

// The ingestion's part (node ingest/main.mjs, after the policy sources): reads the documents of
// events that have none yet, from the sources GitHub can reach (not the Chamber: the PC does it),
// and writes a base sheet for every event that has none, or whose sheet is still the base one.
// The batch's sheets (origin 'auto') are never overwritten here.
export async function runDocuments({ db, fetchImpl = fetch, limit = 40 }) {
  const errors = [];
  const events = await db.read('policy_events', 'select=id,title,summary,source_url,status,stage,institution,event_date,sectors,companies&order=event_date.desc.nullslast&limit=3000');
  const have = new Set((await db.read('policy_documents', 'select=event_id')).map(d => d.event_id));
  const sheets = new Map((await db.read('fact_sheets', 'select=event_id,origin')).map(s => [s.event_id, s.origin]));
  let fetched = 0, unreadable = 0;
  const sheetRows = [], at = new Date().toISOString();
  const putSheet = (ev, docs) => {
    if (sheets.get(ev.id) === 'auto') return;
    const s = baseSheet(ev, docs);
    sheetRows.push({ event_id: ev.id, base: s.base, reasons: s.reasons, doc_sha256: docs ? docs.sha256 : null, origin: 'cloud', updated_at: at });
    sheets.set(ev.id, 'cloud');
  };
  for (const ev of events) {
    if (have.has(ev.id) || ev.id.startsWith('cdep:') || fetched >= limit) continue;
    const links = documentLinks(ev, '');
    if (!links.length) continue;
    try {
      const docs = bundle(await Promise.all(links.map(l => readDocument(l, fetchImpl))));
      await db.insert('policy_documents', [{ event_id: ev.id, sha256: docs.sha256, url: docs.url, parts: docs.parts, text: docs.text, chars: docs.text.length, status: docs.status, fetched_at: at }]);
      have.add(ev.id);
      fetched++;
      if (docs.status !== 'ok') unreadable++;
      putSheet(ev, docs);
    } catch (e) { errors.push(ev.id + ': ' + String(e.message || e).slice(0, 160)); }
  }
  for (const ev of events) if (!sheets.has(ev.id)) putSheet(ev, null);
  for (let i = 0; i < sheetRows.length; i += 200) await db.upsert('fact_sheets', sheetRows.slice(i, i + 200), { onConflict: 'event_id' });
  return { fetched, unreadable, sheets: sheetRows.length, errors };
}
