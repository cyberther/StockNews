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
//   LMSTUDIO_THREADS  auto (default: 4, or 3 during a remote desktop session) | a number | 0 = LM Studio's choice
//   SUMMARY_LANG    default ro,en,de (comma-separated, in order of preference)
//   BATCH_LIMIT     default 10 summaries a run
//   DIGEST_LIMIT    default 1 digest of the previous day per run and language (0 = none)
//   MAX_AGE_HOURS   default 24
//   READ_ARTICLES   default 1: summarize the whole article; 0 = headline and snippet only
//
// The summary is written from the whole article when the publisher allows it: the job
// fetches the page (identifying itself, and only where robots.txt permits), keeps the
// article text in memory for the model, and stores nothing but the model's short summary.
// Paywalled or blocked pages, and pages it can't read, fall back to the headline and the
// source's own short summary.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';
import http from 'node:http';
import zlib from 'node:zlib';
import dns from 'node:dns';
import net from 'node:net';
import { ensureModel, pickThreads } from './lmstudio-model.mjs';

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
  threads: env.LMSTUDIO_THREADS,
  langs: [...new Set(String(env.SUMMARY_LANG || 'ro,en,de').toLowerCase().split(/[\s,]+/).filter(l => ['ro', 'en', 'de'].includes(l)))],
  limit: Math.max(1, Math.min(Number(env.BATCH_LIMIT) || 10, 100)),
  digests: Math.max(0, Math.min(env.DIGEST_LIMIT === undefined ? 1 : Number(env.DIGEST_LIMIT) || 0, 20)),
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
  '- At most 4 sentences and under 600 characters: what happened and the 2-3 most important figures. Say why it ' +
    'matters for the company only if the story itself explains it. Never end with a general remark of your own ' +
    '("this reflects...", "this may influence investors..."): when the facts are told, stop. A short story gets a ' +
    'short summary. Do not list every metric.',
  '- If the story is a list about many companies (top downgrades, movers), summarize only the part about the ' +
    'ticker\'s company and say nothing about the rest of the list.',
  '- Analyst rating changes: name both ratings and the target as the story gives them ("de la Overweight la ' +
    'Neutral", "ținta de preț redusă de la 98 la 54 de dolari").',
  '- Attribute every figure and event to the company it belongs to in the story. The company named after ' +
    '"Ticker:" is the reader\'s interest: lead with what the story says about it. If the story is mainly about ' +
    'another company (a rival, a supplier), say so and name that company; never move its figures to the ticker\'s ' +
    'company. When more than one company appears, name the company in every sentence that gives a figure ' +
    '("Lucid a livrat 3.806 vehicule"), never just "the company".',
  '- Summarize what the story says, never what it leaves out: no "the article does not mention...", "no other ' +
    'figures are given" or "there is no relevant information". If the ticker\'s company only appears in passing, ' +
    'summarize the story as it is.',
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

// Article links come from news feeds, so a link (or a redirect) could point at this PC or
// its network: the router, LM Studio, the self-hosted server. Only public addresses are
// fetched, checked when the name is resolved, for every redirect too, and the connection
// goes to the address that was checked (no second DNS answer in between).
const BLOCKED = new net.BlockList();
[['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]].forEach(([a, n]) => BLOCKED.addSubnet(a, n, 'ipv4'));
[['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2001:db8::', 32]]
  .forEach(([a, n]) => BLOCKED.addSubnet(a, n, 'ipv6'));
export function isPublicAddress(ip) {
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const addr = v4 ? v4[1] : ip, type = net.isIPv4(addr) ? 'ipv4' : net.isIPv6(addr) ? 'ipv6' : '';
  return !!type && !BLOCKED.check(addr, type);
}
function publicLookup(host, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  dns.lookup(host, { all: true, family: opts.family || 0 }, (err, addrs) => {
    if (err) return cb(err);
    const ok = (addrs || []).filter(a => isPublicAddress(a.address));
    if (!ok.length || ok.length !== addrs.length) return cb(Object.assign(new Error('blocked address for ' + host), { code: 'EBLOCKED' }));
    if (opts.all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
}

// GET with redirects, decompression and a size cap. node:https rather than fetch, so large
// response headers (Yahoo sends tens of kilobytes of cookies) don't fail the request.
export function httpGet(url, { timeout = 15000, redirects = 5, accept = 'text/html' } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('not http'));
    if (u.port && u.port !== '80' && u.port !== '443') return reject(new Error('port ' + u.port));
    if (net.isIP(u.hostname.replace(/^\[|\]$/g, '')) && !isPublicAddress(u.hostname.replace(/^\[|\]$/g, ''))) return reject(new Error('blocked address'));
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.get(u, { lookup: publicLookup, headers: { 'user-agent': UA, accept, 'accept-encoding': 'gzip, deflate, br', 'accept-language': 'en, ro;q=0.8' }, maxHeaderSize: 256 * 1024, timeout }, res => {
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
// A page its publisher marks as paid content: schema.org's isAccessibleForFree set to false
// (as true/false or as text, "False" included) in its structured data, or a locked or metered
// content tier. Such pages often carry the whole paid text in their structured data for search
// engines; it is not read. The headline and the feed's own snippet are used instead.
export function isPaidPage(html) {
  const h = String(html || '');
  if (/"isAccessibleForFree"\s*:\s*"?false"?/i.test(h)) return true;
  if (/<meta[^>]+(?:property|name)=["'](?:article:content_tier|content_tier)["'][^>]+content=["'](?:locked|metered|premium)["']/i.test(h)) return true;
  if (/<meta[^>]+content=["'](?:locked|metered|premium)["'][^>]+(?:property|name)=["'](?:article:content_tier|content_tier)["']/i.test(h)) return true;
  return false;
}

// The whole article, or '' when it isn't there to read (blocked, paywalled, not HTML).
export async function readArticle(url) {
  if (!cfg.readArticles || !/^https?:\/\//.test(url || '')) return { text: '', why: 'no link' };
  if (!(await allowedByRobots(url))) return { text: '', why: 'robots.txt' };
  const r = await httpGet(url);
  if (r.status !== 200) return { text: '', why: 'HTTP ' + r.status };
  if (!/html/i.test(r.type)) return { text: '', why: 'not HTML' };
  if (isPaidPage(r.body)) return { text: '', why: 'paywall' };
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
    'datorie', 'producție', 'cerere', 'întârziere', 'anchetă', 'amendă', 'licență', 'parte', 'serie', 'țintă']
    .map(n => ['un ' + n, 'o ' + n]),
  ['superând', 'depășind'],
  ['un nou minim 52-week', 'un nou minim al ultimelor 52 de săptămâni'],
  ['niveluri de 52-week', 'minimele ultimelor 52 de săptămâni'],
  ['minim 52-week', 'minim al ultimelor 52 de săptămâni'],
  ['maxim 52-week', 'maxim al ultimelor 52 de săptămâni'],
  ['52-week lows', 'minimele ultimelor 52 de săptămâni'],
  ['52-week low', 'minimul ultimelor 52 de săptămâni'],
  ['52-week highs', 'maximele ultimelor 52 de săptămâni'],
  ['52-week high', 'maximul ultimelor 52 de săptămâni'],
  // "Downgrade" made Romanian by sound.
  ['a demovat', 'a retrogradat', true],
  ['au demovat', 'au retrogradat'],
  ['demovat', 'retrogradat'],
  ['demovează', 'retrogradează', true],
  ['demovare', 'retrogradare'],
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
// A closing sentence that only comments ("Această schimbare reflectă...", "Aceste cifre
// arată...", "...poate influența deciziile investitorilor"), which the model adds even when
// told not to. Dropped when the summary has other sentences.
const FILLER = /^(?:(?:Această|Acest|Aceste|Acestea|Aceasta)(?:\s+\p{L}+)?\s+(?:reflectă|indică|arată|evidențiază|subliniază|sugerează|consolidează|demonstrează|confirmă)|.*\bpoate (?:influența|afecta) (?:deciziile|percepția|sentimentul) investitorilor|Concluzia(?:\s+\p{L}+)? (?:este|e) că|(?:Dies|Das|Diese|Dieser)\s+(?:zeigt|unterstreicht|verdeutlicht|spiegelt|deutet|signalisiert|bestätigt)|.*\bkönnte (?:die )?(?:Entscheidungen|Stimmung) (?:der )?(?:Anleger|Investoren))/u;
// A sentence in English inside a Romanian summary ("No other figures given."): mostly
// common English words and no Romanian letters.
const EN_COMMON = new Set(('the a an and or of to in on at is are was were be been with for its it this that these ' +
  'no not other figures figure given provided mentioned mention article story company shares stock said says ' +
  'reported has have had will would which also further more details information available').split(' '));
export function dropEnglish(s) {
  const parts = s.match(/[^.!?]+(?:[.!?]+(?=\s+[A-ZĂÂÎȘȚÄÖÜ„"(]|\s*$)|$)/g);
  if (!parts || parts.length < 2) return s;
  const english = p => {
    if (/[ăâîșțĂÂÎȘȚ]/.test(p)) return false;
    const words = p.toLowerCase().match(/[a-z]+/g) || [];
    return words.length >= 3 && words.filter(w => EN_COMMON.has(w)).length / words.length >= 0.5;
  };
  const kept = parts.filter(p => !english(p));
  return kept.length && kept.length < parts.length ? kept.join('').trim() : s;
}

// A sentence about what the article leaves out ("Nicio altă informație financiară nu a
// fost furnizată în articol."): removed when the summary has other sentences.
const LACKING = /(?<!\p{L})(?:nici(?:o|un) (?:alt|alte|altă)\p{L}* (?:informați|cifr|detal|date)|nu (?:a|au) fost (?:furnizat|menționat|oferit|precizat|specificat)|nu (?:sunt|este|se) (?:menționat|furnizat|oferit|precizat|specificat|dau)|articolul nu |nu există (?:alte|informații|detalii)|keine (?:weiteren |anderen )?(?:Angaben|Informationen|Zahlen|Details)|nicht (?:genannt|erwähnt|angegeben)|(?:der|im) Artikel (?:enthält|nennt|macht) keine)/iu;
export function dropLacking(s) {
  const parts = s.match(/[^.!?]+(?:[.!?]+(?=\s+[A-ZĂÂÎȘȚÄÖÜ„"(]|\s*$)|$)/g);
  if (!parts || parts.length < 2) return s;
  const kept = parts.filter(p => !LACKING.test(p));
  return kept.length && kept.length < parts.length ? kept.join('').trim() : s;
}

export function dropFiller(s) {
  const parts = s.match(/[^.!?]+(?:[.!?]+(?=\s+[A-ZĂÂÎȘȚÄÖÜ„"(]|\s*$)|$)/g);
  if (!parts || parts.length < 2) return s;
  const last = parts[parts.length - 1].trim();
  // A sentence with a figure carries facts, so it stays.
  return FILLER.test(last) && !/\d/.test(last) ? parts.slice(0, -1).join('').trim() : s;
}

export function trimSentences(s, max = 650) {
  if (s.length <= max) return s;
  const ends = [];
  const re = /[.!?](?=\s+[A-ZĂÂÎȘȚÄÖÜ„"(]|\s*$)/g;
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
  if (lang === 'ro') s = dropFiller(dropLacking(dropEnglish(fixRomanian(s))));
  else if (lang === 'de') s = dropFiller(dropLacking(s));
  return trimSentences(s);
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
// A reply that is about the article rather than a summary of it: "Nu există informații
// relevante în articol.", "...și nu menționează compania VRT".
const NO_CONTENT = /(?<!\p{L})(?:nu (?:menționează|conține|oferă|există|include|precizează|specifică)(?!\p{L})[^.]*?(?<!\p{L})(?:compani|informați|detali|date|cifre|articol)|articolul nu(?!\p{L})|does not (?:mention|contain|provide)|no (?:other |further )?(?:figures|details|information)(?!\p{L})|not mentioned|erwähnt (?:das Unternehmen|die Firma|den Konzern)?\s*\S*\s*nicht(?!\p{L})|keine relevanten (?:Informationen|Angaben)|enthält keine (?:Informationen|Angaben))/iu;
export function looksWrong(text, story, lang) {
  if (!usable(text)) return 'not usable';
  if (NO_CONTENT.test(text)) return 'says what the story lacks';
  if (lang !== 'en' && (text.match(EN_WORDS) || []).length >= 4) return 'English words';
  const head = fold(story.headline);
  if (head.length > 30 && fold(text).startsWith(head.slice(0, 40))) return 'repeats the headline';
  return '';
}

// ------------------------------------------------------------------ the day's digest
// Every story about one ticker from the previous business day, as bullet points: each
// distinct fact once, the most important first. Same rules on facts as the summaries.
export const DIGEST_SYSTEM = [
  'You are a financial news editor. You get every news story published about one company on one trading day ' +
    '(time, source, headline and a short summary) and write the day\'s digest for investors.',
  '',
  'Rules:',
  '- Use ONLY information in the stories. Do not add figures, causes, opinions or advice.',
  '- 3 to 8 bullet points, one per distinct fact or event, the most important first (results, guidance, deals, ' +
    'contracts, regulators, analyst rating changes, big price moves). Several stories about the same event make ONE ' +
    'bullet. Leave out stories that say nothing new.',
  '- Stories marked "opinion" in their brackets come from sites that mostly publish commentary. The facts they ' +
    'report (rating changes, price moves, company announcements, filings) are facts: put them in the bullets like any ' +
    'other. Only their own views, forecasts and recommendations are opinions: at most two bullets, after the facts, ' +
    'saying whose view it is ("Potrivit Motley Fool...", "24/7 Wall St. consideră că..."). Never present a view as a fact.',
  '- Each bullet is one or two short sentences with the key figures, and ends with its source(s) in brackets, e.g. ' +
    '"(CNBC, Reuters)". Never two bullets about the same event or the same price move.',
  '- The digest is read the next day: never write "today", "astăzi" or "heute"; the day is shown above it.',
  '- If stories disagree, say so in the bullet. Analyst rating changes name both ratings and the target.',
  '- Name the company in a bullet when another company also appears in it; never move another company\'s figures to it.',
  '- Start every bullet with "• ". Reply with the bullets only: no title, no introduction, no conclusion.',
  '',
  'Romanian (ro): correct diacritics (ă, â, î, ș, ț), Romanian words rather than English ones (rezultate financiare, ' +
    'prognoză, preț-țintă, val de vânzări), Romanian number style (1,5 miliarde de dolari; 8%).',
  'German (de): correct German financial terms.',
  'English (en): plain, concise financial English.'
].join('\n');
const DIGEST_LANG = { ro: 'Scrie rezumatul zilei în limba română.', en: 'Write the digest in English.', de: 'Schreibe die Tageszusammenfassung auf Deutsch.' };

// The model's reply as clean bullets ("• ..." one per line), at most 8.
export function cleanDigest(text, lang = 'ro') {
  const raw = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/\*\*/g, '');
  return raw.split(/\r?\n/).map(l => l.trim()).filter(l => /^([•\-*–]|\d+[.)])\s+/.test(l))
    .map(l => l.replace(/^([•\-*–]|\d+[.)])\s+/, '').replace(/[\u2010\u2011]/g, '-').replace(/ş/g, 'ș').replace(/Ş/g, 'Ș').replace(/ţ/g, 'ț').replace(/Ţ/g, 'Ț').replace(/\s+/g, ' ').trim())
    .map(l => lang === 'ro' ? dropLacking(fixRomanian(l)) : lang === 'de' ? dropLacking(l) : l)
    .filter(l => l.length >= 15 && !NO_CONTENT.test(l))
    .slice(0, 8).map(l => '• ' + trimSentences(l, 360)).join('\n');
}
export function digestLooksWrong(d, lang) {
  const bullets = d ? d.split('\n') : [];
  if (bullets.length < 2) return 'too few bullets';
  if (d.length > 3000) return 'too long';
  if (lang !== 'en' && (d.match(EN_WORDS) || []).length >= 4 + bullets.length * 2) return 'English words';
  return '';
}
const hhmm = at => new Date(at).toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Bucharest' });
async function writeDigest(row, lang) {
  const list = (row.stories || []).slice(0, 40).map((x, i) =>
    `${i + 1}. [${hhmm(x.at)}, ${x.source || '?'}${x.opinion ? ', opinion' : ''}] ${x.headline}${x.summary ? ' — ' + String(x.summary).slice(0, 500) : ''}`).join('\n');
  const input = `Ticker: ${row.ticker}\nDay: ${row.day}\nStories (${row.stories.length}):\n${list}\n\n---\n${DIGEST_LANG[lang] || DIGEST_LANG.en}`;
  let text = '', why = '';
  for (const temperature of [0.2, 0.5]) {
    const res = await postJson(`${cfg.lmUrl}/chat/completions`, { model: cfg.model, temperature, max_tokens: 1800,
      messages: [{ role: 'system', content: DIGEST_SYSTEM }, { role: 'user', content: input }] }, 900_000);
    if (res.status !== 200) throw new Error(`model: ${res.status} ${res.body.slice(0, 200)}`);
    const d = JSON.parse(res.body);
    text = cleanDigest(d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content, lang);
    why = digestLooksWrong(text, lang);
    if (!why) return { text, why: '' };
    log('retry digest', row.ticker, lang, '-', why);
  }
  return { text, why };
}
// Up to DIGEST_LIMIT digests per language this run (or the one ticker asked for).
async function runDigests(onlyTicker) {
  const n = onlyTicker ? 1 : cfg.digests;
  if (!n) return;
  for (const lang of cfg.langs) {
    let rows = [];
    try { rows = await rpc('digests_pending', { p_secret: cfg.secret, p_lang: lang, p_limit: n, p_ticker: onlyTicker || null }) || []; }
    catch (e) { log('digests:', String(e.message || e)); return; }
    for (const row of rows) {
      const t0 = Date.now();
      try {
        const { text, why } = await writeDigest(row, lang);
        if (why) { log('skipped digest', row.ticker, row.day, lang, '-', why); continue; }
        await rpc('digests_save', { p_secret: cfg.secret, p_ticker: row.ticker, p_day: row.day, p_lang: lang, p_digest: text,
          p_stories: row.stories.length, p_model: cfg.model });
        log('saved digest', row.ticker, row.day, lang, `${row.stories.length} stories`, `${Math.round((Date.now() - t0) / 1000)}s`);
      } catch (e) { log('digest failed', row.ticker, lang, String(e.message || e)); }
    }
  }
}

export async function summarizeForTest(story, article, lang = 'ro') { return (await summarize(story, article, lang)).text; }
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
    if (!why) return { text, why: '' };
    log('retry', story.id, lang, '-', why);
  }
  return { text, why };
}

// Stories whose replies were rejected twice: not retried for a day (each try costs
// minutes), and in the apps they keep their headline and the source's snippet.
const REJECTED_FILE = join(homedir(), '.cache/market-pulse/rejected.json');
function loadRejected() {
  try {
    const all = JSON.parse(readFileSync(REJECTED_FILE, 'utf8')), now = Date.now(), out = {};
    for (const [k, at] of Object.entries(all)) if (now - at < 24 * 3600_000) out[k] = at;
    return out;
  } catch { return {}; }
}
function saveRejected(r) {
  try { mkdirSync(join(homedir(), '.cache/market-pulse'), { recursive: true }); writeFileSync(REJECTED_FILE, JSON.stringify(r)); } catch {}
}

// One article filed under several tickers ('AAPL:142903568', 'NVDA:142903568') is written
// once per language: the server copies the summary to the other tickers (summaries_save).
export function dedupeQueue(items) {
  const seen = new Set();
  return items.filter(({ story, lang }) => {
    const key = (String(story.id).split(':')[1] || story.id) + '|' + lang;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
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
  log(await ensureModel({ model: cfg.model, threads: pickThreads(cfg.threads), wsUrl: cfg.lmUrl.replace(/^http/, 'ws').replace(/\/v1$/, '') }));

  if (!cfg.langs.length) { log('SUMMARY_LANG has no supported language (ro, en, de)'); process.exitCode = 2; return; }
  // node tools/summarize-batch.mjs --digest ASTS: that ticker's digest of the previous day, nothing else.
  const di = process.argv.indexOf('--digest');
  if (di > 0) return runDigests(String(process.argv[di + 1] || '').toUpperCase());
  // What each language still needs, in the server's priority order; then one queue in which
  // a story's languages sit together, in the order of its best position in any list.
  const rank = new Map(), byId = new Map(), rejected = loadRejected();
  const extra = Object.keys(rejected).length;
  for (const lang of cfg.langs) {
    const rows = await rpc('summaries_pending', { p_secret: cfg.secret, p_lang: lang, p_limit: Math.min(cfg.limit + extra, 100), p_hours: cfg.hours }) || [];
    rows.filter(r => !rejected[r.id + '|' + lang]).forEach((r, i) => {
      byId.set(r.id, r);
      const e = rank.get(r.id) || { at: i, langs: [] };
      e.at = Math.min(e.at, i); e.langs.push(lang);
      rank.set(r.id, e);
    });
  }
  const queue = dedupeQueue([...rank.entries()].sort((a, b) => a[1].at - b[1].at)
    .flatMap(([id, e]) => cfg.langs.filter(l => e.langs.includes(l)).map(lang => ({ story: byId.get(id), lang }))))
    .slice(0, cfg.limit);
  if (!queue.length) { log('no stories waiting'); return runDigests(); }
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
      const { text, why } = await summarize(s, article.text, lang);
      if (why) {
        rejected[s.id + '|' + lang] = Date.now(); saveRejected(rejected);
        log('skipped', s.id, lang, '-', why, '(not retried for 24 h)'); continue;
      }
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
  await runDigests();
}

// The LM Studio SDK keeps a socket open, so the job exits explicitly when it is done.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { log('error', e.message); process.exitCode = 1; }).finally(() => process.exit());
}
