// What the filings reader (tools/filings-crawl.mjs) needs to make sense of an investor
// page: which links are announcements, of what kind, and from which day. No I/O here.

// decodeURIComponent that leaves a malformed address as it is.
export const decode = s => { try { return decodeURIComponent(s); } catch { return String(s); } };
export const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[șş]/gi, 's').replace(/[țţ]/gi, 't').toLowerCase();

// ------------------------------------------------------------------ kinds
// The first that matches wins: a dealing or a holding notice is the most specific, then
// dividends, general meetings, results, and any other current report.
const KINDS = [
  ['insider', /\bpdmr\b|\bart(?:\.|icolul|-)?\s*19\b|responsabilitati de conducere|persoane(?:lor)? (?:cu|care exercita) (?:functii|responsabilitati)|tranzactii(?:le)?[ -](?:ale[ -]|efectuate[ -]de[ -])?(?:management|managementului|conducerii|persoanelor|administratorilor|directorilor|insider)|managers?'?[ -]transactions|directors?'?[ -]dealings|insider/],
  ['holding', /notificare[ -](?:privind[ -])?(?:prag|detiner|drepturi de vot)|prag(?:uri|ului)?[ -]de[ -]detinere|detineri(?:\/|[ -])vot|depasire[ -]prag|major[ -]holding|holding[ -]notification|notification[ -]of[ -](?:major[ -])?holding|\bart(?:\.|icolul|-)?\s*(?:69|71|72|73)\b/],
  ['dividend', /dividend/],
  // AGA, AGOA... only in capitals in titles ("Aga" is also a surname); lower case in file names.
  ['agm', /adunar(?:ea|ii|ilor|i)[ -]general|convoca(?:re|rea|tor)|hotarar(?:ea|ile|i)[ -](?:ag|adunar)|general[ -]meeting|\b(?:agoa|agea)\b/],
  ['results', /rezultat(?:e|ele)[ -](?:financiare|preliminare|trimestriale|semestriale|anuale|consolidate|individuale)|situati(?:a|ile|i)[ -]financiare|raport(?:ul|area)?[ -](?:trimestrial|semestrial|anual|financiar|t[1-4]|s[12]|q[1-4]|h[12]|9l)|raportare(?:a)?[ -](?:trimestriala|semestriala|anuala)|\b(?:t[1-4]|q[1-4]|s[12]|h[12]|9m|9l)[ -]?20\d\d\b|trading[ -]update|financial[ -](?:results|statements|report)|(?:quarterly|half[ -]year(?:ly)?|annual|interim)[ -](?:report|results)|buget(?:ul)?[ -]de[ -]venituri/],
  ['report', /raport(?:ul)?[ -]curent|rapoart(?:e|ele)[ -]curente|ad[ -]?hoc|current[ -]report|comunicat|notificare|informare|press[ -]release|anunt/]
];
// Documents that are not announcements: governance texts, forms, CVs, asset declarations.
const NOISE = /frequently[ -]asked|intrebari[ -]frecvente|\bfaq\b|rules[ -]and[ -]procedure|procedura[ -](?:de[ -])?(?:vot|desfasurare)|information[ -]regarding[ -]the[ -]voting|informatii[ -]privind[ -]drepturile[ -]de[ -]vot|plangeri|indicatori(?:i)?[ -]de[ -]performanta|standard(?:ul)?[ -]de[ -]performanta|tarif|power[ -]of[ -]attorney|proxy[ -](?:form|card)|ballot|voting[ -](?:form|by[ -]correspondence)|articles[ -]of[ -]association|\bmodel(?:ul)?[ -](?:de[ -])?(?:procura|imputernicire|special)|statut|act(?:ul)?[ -]constitutiv|cod(?:ul)?[ -](?:de[ -])?(?:guvernanta|etica|conduita)|regulament|politic(?:a|i)[ -](?:de|privind)(?![ -]dividend)|declarati(?:e|i|a|ile)[ -]de[ -](?:avere|interese)|\bcv\b|curriculum|formular|procura|imputernicire|buletin(?:ul)?[ -]de[ -]vot|vot[ -]prin[ -]corespondenta|cookie|gdpr|termeni|privacy|confidentialitate|cariere|achizitii[ -]publice|licitati|anunt[ -]de[ -](?:angajare|recrutare|concurs)|oferta[ -]de[ -]munca/;

// By the title; a document's address counts too (its title is often just its file name).
export function classifyKind(title, url = '') {
  let path = String(url).replace(/^https?:\/\/[^/]+/, '');
  try { path = decodeURIComponent(path); } catch {}
  const t = fold(title), u = fold(path).replace(/[_/.%]+/g, ' ');
  if (NOISE.test(t) || (url && NOISE.test(u))) return null;
  for (const [kind, re] of KINDS) {
    if (re.test(t)) return kind;
    if (kind === 'agm' && /\b(?:AGA|AGOA|AGEA|GMS|EGM|OGM|AGM)\b/.test(String(title))) return kind;
  }
  if (isDocument(url) && /(?:^|[^a-z])(?:aga|agoa|agea|gms)(?:[^a-z]|$)/.test(u)) return 'agm';
  if (isDocument(url)) for (const [kind, re] of KINDS) if (kind !== 'report' && re.test(u)) return kind;
  return null;
}
// Whether an address alone suggests an announcement (to decide which pages to open).
export function looksLikeFiling(url) {
  let path = String(url).replace(/^https?:\/\/[^/]+/, '');
  try { path = decodeURIComponent(path); } catch {}
  const u = fold(path).replace(/[_/.%-]+/g, ' ');
  return !NOISE.test(u) && KINDS.some(([, re]) => re.test(u));
}
// "AGA din 16 noiembrie 2026 | MedLife" -> "AGA din 16 noiembrie 2026"
export const stripSiteName = t => String(t || '').replace(/\s+[|–—-]\s+[^|–—-]{2,40}$/, '').trim();
// The press: only a named manager's share dealing or a current report counts.
const PRESS_ROLE = /\b(?:director|directorul|ceo|cfo|presedinte|presedintele|administrator|administratorul|membru|membrul|membrii|fondator|fondatorul|fondatorii|conducerea|sef|seful|managerii|managementul)\b/;
const PRESS_DEAL = /\b(?:a|au) (?:cumparat|vandut|achizitionat|instrainat)\b|\b(?:cumpara|vinde)\b/;
export function classifyPress(title) {
  const f = fold(title);
  if (KINDS[0][1].test(f) || (/\bactiuni\b/.test(f) && PRESS_ROLE.test(f) && PRESS_DEAL.test(f))) return 'insider';
  if (/raport(?:ul)? curent|potrivit unui raport (?:transmis|publicat)/.test(f)) return 'report';
  if (KINDS[1][1].test(f)) return 'holding';
  return null;
}

// ------------------------------------------------------------------ dates
const MONTHS = { ian: 1, ianuarie: 1, jan: 1, january: 1, feb: 2, februarie: 2, february: 2, mar: 3, martie: 3, march: 3,
  apr: 4, aprilie: 4, april: 4, mai: 5, may: 5, iun: 6, iunie: 6, jun: 6, june: 6, iul: 7, iulie: 7, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, septembrie: 9, september: 9, oct: 10, octombrie: 10, october: 10,
  noi: 11, nov: 11, noiembrie: 11, november: 11, dec: 12, decembrie: 12, december: 12 };
const iso = (y, m, d) => {
  y = +y; m = +m; d = +d;
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = Date.UTC(y, m - 1, d);
  return new Date(t).getUTCDate() === d ? new Date(t).toISOString().slice(0, 10) : null;
};
// Every date written in the text, in order: 2026-10-09, 09.10.2026, 9/10/2026,
// 20261009 (in file names), "9 octombrie 2026", "October 9, 2026".
export function datesIn(text) {
  const s = fold(text), out = [];
  const push = (at, v) => { if (v) out.push([at, v]); };
  for (const m of s.matchAll(/(?<!\d)(20\d\d)[-_.\/](\d{1,2})[-_.\/](\d{1,2})(?!\d)/g)) push(m.index, iso(m[1], m[2], m[3]));
  for (const m of s.matchAll(/(?<!\d)(\d{1,2})[-_.\/](\d{1,2})[-_.\/](20\d\d)(?!\d)/g)) push(m.index, iso(m[3], m[2], m[1]));
  for (const m of s.matchAll(/(?<!\d)(20[0-4]\d)(0[1-9]|1[0-2])([0-2]\d|3[01])(?!\d)/g)) push(m.index, iso(m[1], m[2], m[3]));
  for (const m of s.matchAll(/(?<!\d)(\d{1,2})\s+([a-z]{3,10})\.?\s+(20\d\d)(?!\d)/g)) if (MONTHS[m[2]]) push(m.index, iso(m[3], MONTHS[m[2]], m[1]));
  for (const m of s.matchAll(/\b([a-z]{3,10})\.?\s+(\d{1,2}),?\s+(20\d\d)(?!\d)/g)) if (MONTHS[m[1]]) push(m.index, iso(m[3], MONTHS[m[1]], m[2]));
  return out.sort((a, b) => a[0] - b[0]).map(x => x[1]);
}
// The day an announcement was published: the first date that isn't in the future (a
// meeting's own date often is), from its surroundings first, then its link.
// A document stored under /2021/03/ (WordPress uploads, most CMSs) was published that month
// or later: a date before that in its title is the period it covers, not its day.
export function publishedDay(context, url, today = new Date().toISOString().slice(0, 10)) {
  let path = String(url || '').split(/[?#]/)[0].split('/').slice(3).join('/');
  try { path = decodeURIComponent(path); } catch {}
  const up = /(?:^|\/)(20\d\d)\/(0[1-9]|1[0-2])\//.exec(path), floor = up ? `${up[1]}-${up[2]}-01` : '';
  for (const src of [context, path]) {
    const d = datesIn(src).find(x => x <= today && x >= floor);
    if (d) return d;
  }
  return floor && floor <= today ? floor : null;
}

// ------------------------------------------------------------------ links
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', bdquo: '„' };
export const decodeText = h => String(h || '').replace(/<[^>]+>/g, ' ')
  .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] != null ? ENT[n.toLowerCase()] : m)
  .replace(/\s+/g, ' ').trim();
// Link texts that say nothing about the document.
const GENERIC = /^(?:descarca|download|vezi|view|citeste|read|detalii|details|more|mai mult|aici|here|click|pdf|doc|docx|xls|ro|en|eng|engleza|romana|romanian|english|fisier|file|document|deschide|open|\d+(?:[.,]\d+)?\s*(?:kb|mb))(?:\s*(?:pdf|aici|here|»|>|\(.*\)))?$/i;
export const isDocument = url => /\.(pdf|docx?|xlsx?)(?:$|[?#])/i.test(url);
// "Raport_curent_09.10.2026_EN.pdf" -> "Raport curent 09.10.2026"
export const titleFromFile = url => decode(String(url).split(/[?#]/)[0].split('/').pop() || '')
  .replace(/\.(pdf|docx?|xlsx?)$/i, '').replace(/[_+-]+/g, ' ').replace(/\s+/g, ' ').trim();
// English copies of a Romanian document.
export const isEnglishCopy = (url, text) => /(?:^|[\/_.-])(?:en|eng|english)(?:[\/_.-]|$)/i.test(String(url).replace(/^https?:\/\/[^/]+/, '').replace(/\.(pdf|docx?)$/i, '-'))
  || /^(?:en|eng|english|engleza)$/i.test(String(text || '').trim());

// The page's links in blocks (table rows, list items, paragraphs): each link with its text
// and the text of its block, where its date usually is.
export function linksIn(html, base) {
  const out = [];
  const blocks = String(html).replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .split(/<\/(?:tr|li|p|article|h[1-6])>|<br\s*\/?>|<\/div>\s*(?=<div)/i);
  for (const b of blocks) {
    const blockText = decodeText(b).slice(0, 600);
    for (const m of b.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      let url;
      try { url = new URL(m[1].replace(/&amp;/g, '&').trim(), base).toString(); } catch { continue; }
      if (!/^https?:\/\//.test(url)) continue;
      out.push({ url, text: decodeText(m[2]).slice(0, 300), block: blockText });
    }
  }
  return out;
}
// A readable title for a link: its own text, unless that is "Descarcă" or "PDF"; then the
// block's text without its dates; then the file name.
export function linkTitle(l) {
  const file = isDocument(l.url) ? titleFromFile(l.url) : '';
  // "Convocator" next to "Convocator AGOA Transgaz 23-24 septembrie 2026.pdf": the file says more.
  const better = t => file && t.length < 20 && !/\d/.test(t) && /\d/.test(file) && file.length > t.length ? file : t;
  const own = l.text.replace(/\s*\(?\d+(?:[.,]\d+)?\s*(?:kb|mb)\)?\s*$/i, '').trim();
  const words = t => (fold(t).match(/[a-z]{3,}/g) || []).length >= 1;
  if (own.length >= 6 && !GENERIC.test(fold(own)) && words(own)) return better(own).slice(0, 300);
  const block = l.block.split(/\s+/).filter(w => !/^(?:descarca|download|vezi|pdf|ro|en|eng)$/i.test(fold(w))).join(' ').trim();
  if (block.length >= 6 && block.length <= 300 && !GENERIC.test(fold(block)) && words(block.replace(/\d[\d.\/-]*/g, ''))) return better(block).slice(0, 300);
  return (file || own || block).slice(0, 300);
}

// Links on a home page that lead to the investor section.
export const IR_LINK = /investitor|investor|relatii[ -]cu[ -]investitorii|actionar|shareholder|\/ir\/|\bir\b|guvernanta|raportari|rapoarte|comunicate|informatii[ -]pentru|bursa|\bbvb\b|financiar/;
export const isIrLink = l => IR_LINK.test(fold(l.text + ' ' + decode(l.url.replace(/^https?:\/\/[^/]+/, ''))));

// The registrable part of a host ("investors.bittnet.ro" -> "bittnet.ro"); good enough for
// .ro, .com and the like.
export const baseDomain = host => String(host || '').toLowerCase().replace(/^www\./, '').split('.').slice(-2).join('.');
export const sameSite = (a, b) => { try { return baseDomain(new URL(a).hostname) === baseDomain(new URL(b).hostname); } catch { return false; } };
// Never read: the exchange's own site (see the project's rules), and social networks.
export const OFF_LIMITS = /(?:^|\.)(?:bvb\.ro|facebook\.com|linkedin\.com|twitter\.com|x\.com|instagram\.com|youtube\.com|tiktok\.com|google\.[a-z.]+)$/i;
export const offLimits = url => { try { return OFF_LIMITS.test(new URL(url).hostname); } catch { return true; } };
