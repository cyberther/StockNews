#!/usr/bin/env node
// AI news summaries, in batches, from a local model (LM Studio's OpenAI-compatible server).
//
// Each run asks Supabase for the stories without a summary in each chosen language (stories
// for followed and held tickers first), summarizes them one at a time, and saves the results
// (supabase/summaries.sql). A story gets all its languages before the next story starts, and
// its article is read once for all of them. Meant for a
// systemd timer every 10 minutes (tools/systemd/); it exits when done, and exits quietly
// when LM Studio isn't running.
//
// Settings come from the environment or from ~/.config/market-pulse/summarizer.env:
//   SUPABASE_URL, SUPABASE_ANON_KEY  the project's public URL and key
//   SUMMARY_SECRET                   the batch job's secret (Vault 'summary_secret')
//   LMSTUDIO_URL    default http://127.0.0.1:1234/v1
//   LMSTUDIO_MODEL  default openai/gpt-oss-20b
//   LMSTUDIO_THREADS  default 3: CPU threads the model is loaded with (tools/lmstudio-model.mjs); 0 = LM Studio's choice
//   SUMMARY_LANG    default ro,en,de (comma-separated, in order of preference)
//   BATCH_LIMIT     default 10 summaries a run
//   MAX_AGE_HOURS   default 24
//   READ_ARTICLES   default 1: summarize the whole article; 0 = headline and snippet only
//
// The summary is written from the whole article when the publisher allows it: the job
// fetches the page (identifying itself, and only where robots.txt permits), keeps the
// article text in memory for the model, and stores nothing but the model's short summary.
// Paywalled or blocked pages, and pages it can't read, fall back to the headline and the
// source's own short summary.
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';
import http from 'node:http';
import zlib from 'node:zlib';
import { ensureModel } from './lmstudio-model.mjs';

const ENV_FILE = join(homedir(), '.config/market-pulse/summarizer.env');
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
const env = process.env;
const cfg = {
  supabaseUrl: (env.SUPABASE_URL || '').replace(/\/$/, ''),
  anonKey: env.SUPABASE_ANON_KEY || '',
  secret: env.SUMMARY_SECRET || '',
  lmUrl: (env.LMSTUDIO_URL || 'http://127.0.0.1:1234/v1').replace(/\/$/, ''),
  model: env.LMSTUDIO_MODEL || 'openai/gpt-oss-20b',
  threads: env.LMSTUDIO_THREADS === undefined ? 3 : Math.max(0, Math.min(Number(env.LMSTUDIO_THREADS) || 0, 64)),
  langs: [...new Set(String(env.SUMMARY_LANG || 'ro,en,de').toLowerCase().split(/[\s,]+/).filter(l => ['ro', 'en', 'de'].includes(l)))],
  limit: Math.max(1, Math.min(Number(env.BATCH_LIMIT) || 10, 100)),
  readArticles: env.READ_ARTICLES !== '0',
  hours: Math.max(1, Math.min(Number(env.MAX_AGE_HOURS) || 24, 168))
};

// One system prompt for every story and language. LM Studio keeps it in its prompt cache,
// so after the first story its length costs nothing; the story follows, then one line naming
// the language, so a story's summaries in several languages share the article as well.
// On a CPU, reading the prompt is most of the time a summary takes.
export const SYSTEM = [
  'You are a financial news editor. You summarize one news story at a time for investors.',
  '',
  'Rules for every summary:',
  '- Use ONLY information in the story. Do not add figures, names, causes or opinions, and do not generalize ' +
    '(one company\'s deliveries are not the whole market\'s).',
  '- At most 4 sentences and under 600 characters: what happened, the 2-3 most important figures, and why it ' +
    'matters for the company. Do not list every metric.',
  '- Attribute every figure and event to the company it belongs to in the story. The company named after ' +
    '"Ticker:" is the reader\'s interest: lead with what the story says about it. If the story is mainly about ' +
    'another company (a rival, a supplier), say so and name that company; never move its figures to the ticker\'s ' +
    'company. When more than one company appears, name the company in every sentence that gives a figure ' +
    '("Lucid a livrat 3.806 vehicule"), never just "the company".',
  '- Keep tickers, company names and figures exactly as in the story. Write a fall as "fell 1.2%", never with a minus sign.',
  '- Third person; past tense for what happened. Reply with the summary only: no title, no quotation marks, no ' +
    'bullet points, no introduction.',
  '',
  'Romanian (ro): correct diacritics (ă, â, î, ș, ț) and correct grammatical gender and agreement ("o pierdere ' +
    'netă", "o marjă negativă", "acțiunile Tesla", "investitorii rămân optimiști"). Use Romanian words, not English ' +
    'ones: închidere (close), tranzacționare (trading), avans (rally), val de vânzări (sell-off), rezultate financiare ' +
    '(earnings), prognoză (guidance), perspective (outlook), preț-țintă (price target), valoare de piață (market cap), ' +
    'program de răscumpărare (buyback), contracte futures (futures), centre de date (data centers), optimist / ' +
    'pesimist (bullish / bearish), investitori individuali (retail investors), anul fiscal 2025 (FY 2025). Romanian ' +
    'number style: 1,5 miliarde de dolari; 8%; 678.000 de unități.',
  'A summary in the right style (it is about another story; never copy its facts): „Acțiunile companiei au scăzut ' +
    'cu 3,1%, după ce aceasta și-a redus prognoza de vânzări pentru 2026 la 12 miliarde de dolari. Conducerea a ' +
    'explicat scăderea prin cererea mai slabă din Europa, iar analiștii se așteaptă la o marjă mai mică în trimestrul ' +
    'următor.”',
  '',
  'English (en): plain, concise financial English.',
  'German (de): correct German financial terms; no English words where German ones exist (bullish: optimistisch).'
].join('\n');
// The line after the story: the language, and how much there is to go on.
const LANG_LINE = { ro: 'Scrie rezumatul în limba română.', en: 'Write the summary in English.', de: 'Schreibe die Zusammenfassung auf Deutsch.' };
const SNIPPET_LINE = { ro: 'Ai doar titlul și un scurt fragment: 1-2 propoziții.', en: 'Only the headline and a short snippet are given: 1-2 sentences.',
  de: 'Nur Überschrift und kurzer Auszug liegen vor: 1-2 Sätze.' };

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ------------------------------------------------------------------ reading articles
const UA = 'Mozilla/5.0 (compatible; MarketPulseSummarizer/1.0; +https://github.com/cyberther/StockNews)';
const MAX_PAGE = 3 * 1024 * 1024;
const MAX_TEXT = 3500;   // characters given to the model: the substance of a story, at CPU speed

// GET with redirects, decompression and a size cap. node:https rather than fetch, so large
// response headers (Yahoo sends tens of kilobytes of cookies) don't fail the request.
export function httpGet(url, { timeout = 15000, redirects = 5, accept = 'text/html' } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.get(u, { headers: { 'user-agent': UA, accept, 'accept-encoding': 'gzip, deflate, br', 'accept-language': 'en, ro;q=0.8' }, maxHeaderSize: 256 * 1024, timeout }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(httpGet(new URL(res.headers.location, u).toString(), { timeout, redirects: redirects - 1, accept }));
      }
      const enc = String(res.headers['content-encoding'] || '');
      const stream = enc.includes('br') ? res.pipe(zlib.createBrotliDecompress()) : enc.includes('gzip') ? res.pipe(zlib.createGunzip())
        : enc.includes('deflate') ? res.pipe(zlib.createInflate()) : res;
      const chunks = []; let size = 0;
      stream.on('data', c => { size += c.length; if (size > MAX_PAGE) { req.destroy(); reject(new Error('page too large')); } else chunks.push(c); });
      stream.on('end', () => resolve({ status: res.statusCode, url: u.toString(), type: String(res.headers['content-type'] || ''), body: Buffer.concat(chunks).toString('utf8') }));
      stream.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// robots.txt: the rules for "*" (or for this job by name), longest match wins, Allow beats
// Disallow on a tie. A missing or unreadable file allows everything, as the convention says.
const robotsCache = new Map();
export function robotsAllow(txt, path, agent = 'marketpulsesummarizer') {
  const groups = []; let cur = null, lastWasAgent = false;
  for (const raw of String(txt || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === 'user-agent') {
      if (!lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase()); lastWasAgent = true;
    } else if (cur && (key === 'allow' || key === 'disallow')) {
      cur.rules.push({ allow: key === 'allow', path: val }); lastWasAgent = false;
    } else lastWasAgent = false;
  }
  const mine = groups.filter(g => g.agents.some(a => a !== '*' && agent.includes(a)));
  const rules = (mine.length ? mine : groups.filter(g => g.agents.includes('*'))).flatMap(g => g.rules);
  let best = null;
  for (const r of rules) {
    if (!r.path) continue;   // "Disallow:" with nothing allows everything
    const re = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (re.test(path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  }
  return !best || best.allow;
}
async function allowedByRobots(url) {
  const u = new URL(url);
  if (!robotsCache.has(u.host)) {
    let txt = '';
    try { const r = await httpGet(`${u.protocol}//${u.host}/robots.txt`, { timeout: 8000, accept: 'text/plain' }); if (r.status === 200) txt = r.body; } catch {}
    robotsCache.set(u.host, txt);
  }
  return robotsAllow(robotsCache.get(u.host), u.pathname + u.search);
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', bdquo: '„' };
const textOf = h => String(h || '')
  .replace(/<(script|style|noscript|figure|figcaption|aside|nav|form|button)[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6])>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] != null ? ENT[n.toLowerCase()] : m)
  .replace(/[ \t\u00a0]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
// Lines that are page furniture rather than the story.
const BOILER = /^(advertisement|reclam[aă]|citește (și|mai mult)|read more|related|sign up|subscribe|abonea|newsletter|cookie|share|distribuie|urmărește|follow us|copyright|©|all rights reserved|toate drepturile)/i;

// The article's own text: the publisher's structured data (JSON-LD articleBody) when it
// has it, else the paragraphs of the <article>, else the text of an article-body block.
export function extractArticleText(html) {
  let best = '';
  for (const m of String(html).matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const j = JSON.parse(m[1]);
      for (const x of [].concat(j, (j && j['@graph']) || [])) if (x && typeof x.articleBody === 'string' && x.articleBody.length > best.length) best = x.articleBody;
    } catch {}
  }
  const clean = t => t.split('\n').map(l => l.trim()).filter(l => l.length > 40 && !BOILER.test(l)).join('\n');
  if (best.length >= 400) return clean(textOf(best)).slice(0, MAX_TEXT);
  const scope = (/<article[\s>][\s\S]*?<\/article>/i.exec(html) || [html])[0];
  const paras = [...scope.matchAll(/<p[\s>][\s\S]*?<\/p>/gi)].map(m => textOf(m[0])).filter(p => p.length > 60 && !BOILER.test(p));
  const fromParas = paras.join('\n');
  if (fromParas.length >= 400) return fromParas.slice(0, MAX_TEXT);
  const block = /<(div|section)[^>]+(class|itemprop)="[^"]*(article-body|articleBody|article__body|entry-content|post-content|story-body|content-body|article-content)[^"]*"[^>]*>/i.exec(html);
  if (block) {
    const t = clean(textOf(html.slice(block.index, block.index + 60000)));
    if (t.length >= 400) return t.slice(0, MAX_TEXT);
  }
  return '';
}

// A subscription wall in place of the story: short text that asks the reader to subscribe.
const PAYWALL = /(doar dac[aă] e[sș]ti abonat|pentru abona[tț]i|devino abonat|subscribe to (read|continue)|subscription required|subscribers only|to continue reading|premium (article|content))/i;
export const isPaywall = t => t.length < 1500 && PAYWALL.test(t);

// The whole article, or '' when it isn't there to read (blocked, paywalled, not HTML).
export async function readArticle(url) {
  if (!cfg.readArticles || !/^https?:\/\//.test(url || '')) return { text: '', why: 'no link' };
  if (!(await allowedByRobots(url))) return { text: '', why: 'robots.txt' };
  const r = await httpGet(url);
  if (r.status !== 200) return { text: '', why: 'HTTP ' + r.status };
  if (!/html/i.test(r.type)) return { text: '', why: 'not HTML' };
  const text = extractArticleText(r.body);
  if (text && isPaywall(text)) return { text: '', why: 'paywall' };
  return text ? { text, why: '' } : { text: '', why: 'no article text' };
}

async function rpc(fn, body) {
  const res = await fetch(`${cfg.supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: cfg.anonKey, authorization: 'Bearer ' + cfg.anonKey, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${fn}: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

// English finance terms small models leave in Romanian text. The Romanian keeps the
// grammatical gender where it can (these terms are used as neuter nouns: "un rally
// puternic" -> "un avans puternic"), and common article + adjective phrases are fixed as a
// whole. Longest phrases first. Bare terms are matched in lowercase only, so names
// ("Close Brothers", "Rally Health") are left alone; a capitalised form is replaced only
// with a Romanian ending ("Sell-off-ul"), which no name has.
const RO_TERMS = [
  ['față de ultimul close', 'față de închiderea anterioară'],
  ['ultimului close', 'închiderii anterioare'],
  ['ultimul close', 'închiderea anterioară'],
  ['close-ul', 'închiderea', true],
  ['la close', 'la închidere'],
  ['close', 'închidere'],
  ['trading-ul', 'tranzacționarea', true],
  ['de trading', 'de tranzacționare'],
  ['rally-ul', 'avansul', true],
  ['rally', 'avans'],
  ['sell-off-ul', 'valul de vânzări', true],
  ['selloff-ul', 'valul de vânzări', true],
  ['sell-off', 'val de vânzări'],
  ['selloff', 'val de vânzări'],
  ['raportul de earnings', 'raportul de rezultate'],
  ['earnings-urile', 'rezultatele financiare', true],
  ['earnings', 'rezultatele financiare'],
  ['noul guidance', 'noua prognoză'],
  ['un guidance', 'o prognoză'],
  ['guidance-ul', 'prognoza', true],
  ['guidance', 'prognoza'],
  ['outlook-ul', 'perspectivele', true],
  ['outlook', 'perspectivele'],
  ['price target-ul', 'prețul-țintă', true],
  ['price target', 'preț-țintă'],
  ['market cap-ul', 'valoarea de piață', true],
  ['market cap', 'valoare de piață'],
  ['buyback-ul', 'programul de răscumpărare', true],
  ['buyback', 'program de răscumpărare'],
  ['futures-urile', 'contractele futures', true],
  ['futures-urilor', 'contractelor futures', true],
  ['în premergerea', 'înaintea', true],
  ['unui board de alimentare', 'unei plăci de alimentare'],
  ['un board de alimentare', 'o placă de alimentare'],
  ['board-ul de alimentare', 'placa de alimentare', true],
  ['board de alimentare', 'placă de alimentare'],
  ['data-centerelor', 'centrelor de date', true],
  ['data-centerele', 'centrele de date', true],
  ['data-centerului', 'centrului de date', true],
  ['data-centerul', 'centrul de date', true],
  ['data-centere', 'centre de date', true],
  ['data-center', 'centru de date', true],
  ['data centerelor', 'centrelor de date'],
  ['data centerele', 'centrele de date'],
  ['data center', 'centru de date'],
  ['bullish', 'optimist'],
  ['bearish', 'pesimist'],
  // Plural subjects ("investitorii rămân optimist"): the adjective agrees. Runs after
  // bullish/bearish, which give the singular.
  ['rămân optimist', 'rămân optimiști'],
  ['rămân pesimist', 'rămân pesimiști'],
  ['sunt optimist', 'sunt optimiști'],
  ['sunt pesimist', 'sunt pesimiști'],
  // Gender and spelling slips the model makes in otherwise Romanian text.
  ...['pierdere', 'marjă', 'lună', 'creștere', 'scădere', 'majorare', 'reducere', 'rețea', 'companie', 'piață',
    'investiție', 'cotă', 'prognoză', 'estimare', 'livrare', 'vânzare', 'ofertă', 'achiziție', 'fuziune', 'tranzacție',
    'decizie', 'strategie', 'platformă', 'fabrică', 'uzină', 'acțiune', 'evaluare', 'recomandare', 'dobândă',
    'datorie', 'producție', 'cerere', 'întârziere', 'anchetă', 'amendă', 'licență', 'parte', 'serie']
    .map(n => ['un ' + n, 'o ' + n]),
  ['superând', 'depășind'],
  ['analistilor', 'analiștilor'],
  ['analistii', 'analiștii'],
  ['analisti', 'analiști']
];
// A match may not start or end inside a word ("închidere", "enclosed", "closely").
const LETTER = 'A-Za-zĂÂÎȘȚăâîșț';
const esc = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cap = t => t.charAt(0).toUpperCase() + t.slice(1);
const RO_RULES = [];
RO_TERMS.forEach(([en, ro, suffixed]) => {
  const around = body => new RegExp(`(?<![${LETTER}-])${body}(?![${LETTER}-])`, 'g');
  RO_RULES.push([around(esc(en)), ro]);
  if (suffixed) RO_RULES.push([around(esc(cap(en))), cap(ro)]);
});
export function fixRomanian(s) {
  let out = s;
  for (const [re, ro] of RO_RULES) out = out.replace(re, ro);
  // Numbers: "$6,2 trilioni de dolari" -> "6,2 trilioane de dolari"; "1 500 %" -> "1.500%".
  out = out.replace(/(?<![\p{L}])trilioni(?![\p{L}])/gu, 'trilioane')
    .replace(/\$\s?(\d[\d.,]*)\s+(mii|milioane|miliarde|trilioane)\s+de\s+dolari/g, '$1 $2 de dolari')
    .replace(/(?<![\d.,])(\d{1,3})[ \u00a0\u202f](\d{3})(?![\d])/g, '$1.$2')
    .replace(/(\d)[ \u00a0\u202f]%/g, '$1%');
  // "Tesla acționările au scăzut" -> "Acțiunile Tesla au scăzut".
  out = out.replace(/(^|[.!?]\s+)([A-Z][\w&.-]*(?: [A-Z][\w&.-]*)*) acționările\b/g, (m, p, name) => p + 'Acțiunile ' + name)
    .replace(/(?<![A-Za-zĂÂÎȘȚăâîșț])acționările(?![A-Za-zĂÂÎȘȚăâîșț])/g, 'acțiunile');
  return out;
}

// At most `max` characters, cut after the last whole sentence that fits. A sentence ends
// at . ! or ? followed by a space and a capital (or the end), so "1.500%" and "aprox. 13"
// don't count as ends.
export function trimSentences(s, max = 650) {
  if (s.length <= max) return s;
  const ends = [];
  const re = /[.!?](?=\s+[A-ZĂÂÎȘȚ„"(]|\s*$)/g;
  let m;
  while ((m = re.exec(s))) ends.push(m.index + 1);
  const fit = ends.filter(i => i <= max).pop();
  if (fit) return s.slice(0, fit).trim();
  return s.slice(0, max).replace(/\s+\S*$/, '') + '…';
}

// Cedilla forms (ş ţ) to the correct comma-below letters, and tidy the model's reply.
export function cleanSummary(text, lang = 'ro') {
  let s = String(text || '')
    .replace(/ş/g, 'ș').replace(/Ş/g, 'Ș').replace(/ţ/g, 'ț').replace(/Ţ/g, 'Ț')
    // Non-breaking and other Unicode hyphens ("data‑center") to a plain one.
    .replace(/[\u2010\u2011]/g, '-')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/^\s*(rezumat|summary|zusammenfassung)\s*:\s*/i, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/^["„“”«»']+|["„“”«»']+$/g, '').trim();
  return trimSentences(lang === 'ro' ? fixRomanian(s) : s);
}
// A reply worth saving: prose of a sensible length, not a tool call or JSON.
export function usable(s) {
  return s.length >= 40 && s.length <= 1200 && !/^[{[]/.test(s) && !/"(name|parameters)"\s*:/.test(s);
}

// A POST that waits as long as the model needs. fetch() gives up after 300 s without
// response headers, and LM Studio sends none until the whole reply is written.
function postJson(url, body, timeout) {
  return new Promise((resolve, reject) => {
    const u = new URL(url), data = Buffer.from(JSON.stringify(body));
    const req = (u.protocol === 'https:' ? https : http).request(u, { method: 'POST', timeout,
      headers: { 'content-type': 'application/json', 'content-length': data.length } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('model: no reply in ' + Math.round(timeout / 1000) + ' s')));
    req.on('error', reject);
    req.end(data);
  });
}

// What a Romanian summary should not look like: English sentences, or the headline repeated.
const EN_WORDS = /(?<![\p{L}])(the|and|of|to|is|are|was|with|for|its|shares|stock|said)(?![\p{L}])/giu;
const fold = t => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
export function looksWrong(text, story, lang) {
  if (!usable(text)) return 'not usable';
  if (lang !== 'en' && (text.match(EN_WORDS) || []).length >= 4) return 'English words';
  const head = fold(story.headline);
  if (head.length > 30 && fold(text).startsWith(head.slice(0, 40))) return 'repeats the headline';
  return '';
}

export async function summarizeForTest(story, article, lang = 'ro') { return summarize(story, article, lang); }
// One try, and a second (a little less conservative) when the first looks wrong; the
// second reuses the cached prompt, so it costs only the writing.
async function summarize(story, article, lang) {
  const input = article
    ? `Ticker: ${story.ticker}\nTitle: ${story.headline}\nArticle:\n${article}`
    : `Ticker: ${story.ticker}\nTitle: ${story.headline}\nSource summary: ${story.summary || '(none)'}`;
  const tail = '\n\n---\n' + (LANG_LINE[lang] || LANG_LINE.en) + (article ? '' : ' ' + (SNIPPET_LINE[lang] || SNIPPET_LINE.en));
  let text = '', why = '';
  for (const temperature of [0.2, 0.5]) {
    const res = await postJson(`${cfg.lmUrl}/chat/completions`, { model: cfg.model, temperature, max_tokens: 800,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: input + tail }] }, 600_000);
    if (res.status !== 200) throw new Error(`model: ${res.status} ${res.body.slice(0, 200)}`);
    const d = JSON.parse(res.body);
    text = cleanSummary(d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content, lang);
    why = looksWrong(text, story, lang);
    if (!why) return text;
    log('retry', story.id, lang, '-', why);
  }
  return text;
}

async function main() {
  if (!cfg.supabaseUrl || !cfg.anonKey || cfg.secret.length < 32) {
    log('not configured: set SUPABASE_URL, SUPABASE_ANON_KEY and SUMMARY_SECRET in', ENV_FILE);
    process.exitCode = 2; return;
  }
  try {
    const r = await fetch(`${cfg.lmUrl}/models`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(String(r.status));
  } catch (e) { log('LM Studio is not answering at', cfg.lmUrl, '- nothing to do this run'); return; }
  log(await ensureModel({ model: cfg.model, threads: cfg.threads, wsUrl: cfg.lmUrl.replace(/^http/, 'ws').replace(/\/v1$/, '') }));

  if (!cfg.langs.length) { log('SUMMARY_LANG has no supported language (ro, en, de)'); process.exitCode = 2; return; }
  // What each language still needs, in the server's priority order; then one queue in which
  // a story's languages sit together, in the order of its best position in any list.
  const rank = new Map(), byId = new Map();
  for (const lang of cfg.langs) {
    const rows = await rpc('summaries_pending', { p_secret: cfg.secret, p_lang: lang, p_limit: cfg.limit, p_hours: cfg.hours }) || [];
    rows.forEach((r, i) => {
      byId.set(r.id, r);
      const e = rank.get(r.id) || { at: i, langs: [] };
      e.at = Math.min(e.at, i); e.langs.push(lang);
      rank.set(r.id, e);
    });
  }
  const queue = [...rank.entries()].sort((a, b) => a[1].at - b[1].at)
    .flatMap(([id, e]) => cfg.langs.filter(l => e.langs.includes(l)).map(lang => ({ story: byId.get(id), lang })))
    .slice(0, cfg.limit);
  if (!queue.length) { log('no stories waiting'); return; }
  log(`${queue.length} summaries to write (${cfg.langs.join(', ')}) with ${cfg.model}`);

  let saved = 0;
  const articles = new Map();
  for (const { story: s, lang } of queue) {
    const t0 = Date.now();
    try {
      if (!articles.has(s.id)) {
        let article = { text: '', why: 'off' };
        try { article = await readArticle(s.url); } catch (e) { article = { text: '', why: String(e.message || e) }; }
        articles.set(s.id, article);
      }
      const article = articles.get(s.id);
      const text = await summarize(s, article.text, lang);
      if (!usable(text)) { log('skipped', s.id, lang, '- reply not usable'); continue; }
      // The model field records what the summary was written from.
      const basis = article.text ? 'article' : 'snippet';
      // Saved one at a time, so a slow batch still shows progress in the apps.
      saved += await rpc('summaries_save', { p_secret: cfg.secret, p_rows: [{ story_id: s.id, lang, summary: text, model: cfg.model + ' · ' + basis }] }) || 0;
      log('saved', s.id, lang, basis + (article.why ? ` (${article.why})` : ` (${article.text.length} chars)`), `${Math.round((Date.now() - t0) / 1000)}s`);
    } catch (e) {
      log('failed', s.id, lang, String(e.message || e));
    }
  }
  log(`done: ${saved} of ${queue.length} saved`);
}

// The LM Studio SDK keeps a socket open, so the job exits explicitly when it is done.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { log('error', e.message); process.exitCode = 1; }).finally(() => process.exit());
}
