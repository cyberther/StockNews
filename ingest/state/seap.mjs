// Public contracts won by listed companies (Politici 2.0): SEAP's quarterly open data on
// data.gov.ro (CC BY 4.0: "Sursa: SEAP / data.gov.ro"; robots.txt asks for 10 s between
// requests). Each contracts file is ~22 MB (a ~200 MB sheet): it is streamed through `unzip -p`
// and only rows whose winner's fiscal code is in config/company-entities.json are kept, mapped to
// the listed parent. A file is read once (state_sources).
import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const SEAP_DATASETS = year => [`https://data.gov.ro/dataset/achizitii-publice-${year}`];
const UA = 'MarketPulse/1.0 (+https://www.marketpulse.ro)';
const COLS = { authority: 'autoritate contractanta', cpv: 'cod cpv', lot: 'numar lot', notice: 'numar anunt atribuire', date: 'data contract',
  number: 'numar contract', value: 'valoare contract (ron)', winner: 'ofertant castigator', cui: 'cui ofertant castigator' };

// Contracts files only: xlsx, not amendments, direct purchases or other reports.
export function contractFiles(html) {
  const urls = [...String(html || '').matchAll(/href="(https:\/\/data\.gov\.ro\/dataset\/[^"]+\/download\/[^"]+)"/g)].map(m => m[1]);
  return [...new Set(urls.filter(u => /raport-contracte[^/]*\.xlsx$/i.test(u) && !/modificare/i.test(u)))];
}

const unxml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
function entry(file, name) {
  return spawn('unzip', ['-p', file, name], { stdio: ['ignore', 'pipe', 'ignore'] }).stdout;
}
async function readAll(stream) { const out = []; for await (const c of stream) out.push(c); return Buffer.concat(out).toString('utf8'); }
const colOf = ref => ref.replace(/\d+$/, '');
const excelDate = n => Number.isFinite(n) ? new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000).toISOString().slice(0, 10) : null;

export async function readContracts(file, { cuiIndex, sourceUrl }) {
  const strings = [...(await readAll(entry(file, 'xl/sharedStrings.xml'))).matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map(m => unxml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join('')));
  const out = [];
  let head = null, buf = '';
  const take = rowXml => {
    const cells = {};
    for (const c of rowXml.matchAll(/<c r="([A-Z]+\d+)"([^>]*)>(?:<v>([\s\S]*?)<\/v>|<is><t[^>]*>([\s\S]*?)<\/t><\/is>)?<\/c>/g)) {
      const raw = c[3] != null ? c[3] : c[4] != null ? unxml(c[4]) : '';
      cells[colOf(c[1])] = / t="s"/.test(c[2]) ? strings[Number(raw)] : / t="(?:str|inlineStr)"/.test(c[2]) ? unxml(raw) : raw;
    }
    if (!head) {
      head = {};
      for (const [col, name] of Object.entries(cells)) {
        const n = String(name).trim().toLowerCase();
        for (const [k, label] of Object.entries(COLS)) if (n === label && !head[k]) head[k] = col;
      }
      if (!head.cui || !head.value) throw new Error('not a SEAP contracts sheet');
      return;
    }
    const cui = String(cells[head.cui] || '').replace(/\D/g, '').replace(/^0+/, '');
    const ticker = cui && cuiIndex.get(cui);
    if (!ticker) return;
    const value = Number(cells[head.value]);
    out.push({ id: ['seap', cells[head.notice] || '', cells[head.lot] || '', cells[head.number] || ''].join(':').slice(0, 200), cui, ticker,
      authority: String(cells[head.authority] || '').slice(0, 300), title: String(cells[head.winner] || '').slice(0, 300), cpv: cells[head.cpv] || null,
      value_ron: Number.isFinite(value) ? value : null, currency: 'RON', signed_on: excelDate(Number(cells[head.date])), duration_months: null, source_url: sourceUrl });
  };
  for await (const chunk of entry(file, 'xl/worksheets/sheet1.xml')) {
    buf += chunk.toString('utf8');
    let end;
    while ((end = buf.indexOf('</row>')) >= 0) {
      const start = buf.lastIndexOf('<row', end);
      if (start >= 0) take(buf.slice(start, end));
      buf = buf.slice(end + 6);
    }
  }
  return out;
}

// The ingestion's part (eod): files not read yet, one at a time, 10 s apart.
export async function runStateMoney({ db, fetchImpl = fetch, cuiIndex, now = new Date(), wait = ms => new Promise(r => setTimeout(r, ms)), tmp = tmpdir(), datasets = SEAP_DATASETS(now.getUTCFullYear()) }) {
  const errors = [], done = new Set((await db.read('state_sources', 'select=url')).map(r => r.url));
  let files = 0, contracts = 0;
  for (const ds of datasets) {
    let list = [];
    try {
      const r = await fetchImpl(ds, { headers: { 'user-agent': UA } });
      list = r.ok ? contractFiles(await r.text()) : [];
    } catch (e) { errors.push(ds + ': ' + e.message); }
    for (const url of list) {
      if (done.has(url)) continue;
      await wait(10000);
      const path = join(tmp, 'seap-' + Date.now() + '.xlsx');
      try {
        const r = await fetchImpl(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(180000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        writeFileSync(path, Buffer.from(await r.arrayBuffer()));
        const rows = await readContracts(path, { cuiIndex, sourceUrl: url });
        for (let i = 0; i < rows.length; i += 500) await db.upsert('public_contracts', rows.slice(i, i + 500), { onConflict: 'id' });
        await db.upsert('state_sources', [{ url, kind: 'seap_contracts', rows: rows.length, processed_at: new Date().toISOString() }], { onConflict: 'url' });
        files++; contracts += rows.length;
      } catch (e) { errors.push(url.split('/').pop() + ': ' + String(e.message || e).slice(0, 160)); }
      finally { try { unlinkSync(path); } catch (e) {} }
    }
  }
  return { files, contracts, errors };
}
