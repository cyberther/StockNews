// The legislation portal (legislatie.just.ro, its public SOAP service: GetToken, Search): the
// Government's ordinances (OUG, OG) as published in the Official Gazette. Laws come from the
// Chamber and decisions from the Government's notes. The service answers a client that names
// itself (LEGAL-SOURCES.md §6).
import { text, clip } from './common.mjs';

export const JUST_SOAP = 'https://legislatie.just.ro/apiws/FreeWebService.svc/SOAP';
export const JUST_UA = 'MarketPulse/1.0 (+https://www.marketpulse.ro)';
const MONTHS = ['ianuarie', 'februarie', 'martie', 'aprilie', 'mai', 'iunie', 'iulie', 'august', 'septembrie', 'octombrie', 'noiembrie', 'decembrie'];
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const env = body => `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>${body}</s:Body></s:Envelope>`;

export const justTokenBody = () => env('<GetToken xmlns="http://tempuri.org/"/>');
export function justSearchBody(token, title, year, page, size) {
  return env(`<Search xmlns="http://tempuri.org/"><SearchModel xmlns:a="http://schemas.datacontract.org/2004/07/FreeWebService">` +
    `<a:NumarPagina>${Number(page)}</a:NumarPagina><a:RezultatePagina>${Number(size)}</a:RezultatePagina><a:SearchAn>${Number(year)}</a:SearchAn>` +
    `<a:SearchNumar></a:SearchNumar><a:SearchText></a:SearchText><a:SearchTitlu>${esc(title)}</a:SearchTitlu></SearchModel><tokenKey>${esc(token)}</tokenKey></Search>`);
}

const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[şșŞȘ]/g, 's').replace(/[ţțŢȚ]/g, 't').toUpperCase();
const TYPES = [[/^ORDONANTA DE URGENTA\b/, 'OUG'], [/^ORDONANTA\b/, 'OG']];

export function parseJustSearch(xml, { now = new Date() } = {}) {
  const today = now.toISOString().slice(0, 10), out = [];
  for (const m of String(xml || '').matchAll(/<a:Legi>([\s\S]*?)<\/a:Legi>/g)) {
    const g = k => { const x = new RegExp(`<a:${k}>([\\s\\S]*?)</a:${k}>`).exec(m[1]); return x ? text(x[1]) : ''; };
    const titlu = g('Titlu'), kind = TYPES.find(([re]) => re.test(fold(titlu).trim()));
    if (!kind) continue;
    const head = /nr\.\s*(\d+)\s+din\s+(\d{1,2})\s+([a-zăâîșțşţ]+)\s+(\d{4})\s*(.*?)\s*EMITENT/i.exec(titlu);
    const link = /DetaliiDocument\/(\d+)/.exec(g('LinkHtml'));
    if (!head || !link) continue;
    const month = MONTHS.indexOf(fold(head[3]).toLowerCase()) + 1;
    if (!month) continue;
    const date = `${head[4]}-${String(month).padStart(2, '0')}-${head[2].padStart(2, '0')}`, num = `${kind[1]} ${head[1]}/${head[4]}`;
    const vigoare = /^\d{4}-\d{2}-\d{2}$/.test(g('DataVigoare')) ? g('DataVigoare') : null;
    out.push({
      id: 'just:' + link[1], title: clip(`${num}: ${head[5] || 'ordonanță a Guvernului'}`, 500), summary: null,
      event_date: date, institution: 'Guvernul României', initiator: 'Guvernul României', doc_number: num,
      source_url: 'https://legislatie.just.ro/Public/DetaliiDocument/' + link[1],
      status: vigoare && vigoare <= today ? 'in_force' : 'adopted',
      stage: vigoare ? `publicată în Monitorul Oficial; în vigoare de la ${vigoare.split('-').reverse().join('.')}` : 'publicată în Monitorul Oficial',
      certainty: 'official_act'
    });
  }
  return out;
}

// GetToken, then the first pages of this year's ordinances (the service does not sort by date).
export async function loadJust({ fetchImpl = fetch, now = new Date(), pages = 3, size = 50 } = {}) {
  const post = async (action, body) => {
    const r = await fetchImpl(JUST_SOAP, { method: 'POST', headers: { 'content-type': 'text/xml; charset=utf-8', soapaction: `"http://tempuri.org/IFreeWebService/${action}"`, 'user-agent': JUST_UA },
      body, signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error('legislatie.just.ro HTTP ' + r.status);
    return r.text();
  };
  const token = (/<GetTokenResult>([^<]+)</.exec(await post('GetToken', justTokenBody())) || [])[1];
  if (!token) throw new Error('legislatie.just.ro: no token');
  const year = now.getUTCFullYear();
  let xml = '';
  for (const title of ['ordonanta de urgenta', 'ordonanta']) for (let p = 0; p < pages; p++) xml += await post('Search', justSearchBody(token, title, year, p, size));
  return xml;
}
