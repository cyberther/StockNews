#!/usr/bin/env node
// Optional, internal and lowest priority (Phase C): the local model (LM Studio on this PC,
// its OpenAI-compatible API, nothing external) reads the policy events' titles and summaries
// and proposes a plain-language summary, the institutions and companies named, and sectors.
// Everything is saved through ai_annotations_save (supabase/impact.sql) as "generat automat,
// neverificat": readers see none of it until an admin marks it checked, and it never changes
// the deterministic classification. The site and the ingestion never wait for it.
//
//   node tools/policy-ai-batch.mjs
//     env (or ~/.config/market-pulse/summarizer.env, as the summary job):
//       SUPABASE_URL, SUPABASE_ANON_KEY, SUMMARY_SECRET
//       LMSTUDIO_URL (default http://127.0.0.1:1234/v1), LMSTUDIO_MODEL
//       AI_WINDOW     hours it may run, Bucharest time: '01-06' (default), '22-02', 'always'
//       AI_MAX_MINUTES  time limit per run (default 30)
//       AI_LIMIT        events per run (default 20)
//
// LM Studio not answering in 5 s: the run is postponed (exit 0), never retried in the same run.
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

export function inWindow(now, win, tz = 'Europe/Bucharest') {
  if (String(win || '').trim() === 'always') return true;
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(String(win || '').trim());
  if (!m) return false;
  const from = Number(m[1]), to = Number(m[2]);
  const h = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: tz }).format(now)) % 24;
  return from <= to ? h >= from && h < to : h >= from || h < to;
}

const list = (v, max) => Array.isArray(v) && v.length <= max && v.every(x => typeof x === 'string' && x.trim().length > 1 && x.length <= 120);
// One reply becomes up to three annotations; a part that fails its check is left out.
export function checkReply(d, ev, taxonomy, model) {
  if (!d || typeof d !== 'object') return [];
  const out = [], row = (kind, content) => out.push({ target_id: ev.id, kind, content, model });
  if (typeof d.summary === 'string' && d.summary.trim().length >= 20 && d.summary.length <= 600) row('summary', { text: d.summary.trim() });
  if (list(d.institutions, 8) && list(d.companies, 8)) row('entities', { institutions: d.institutions.map(s => s.trim()), companies: d.companies.map(s => s.trim()) });
  if (Array.isArray(d.sectors)) {
    const known = d.sectors.filter(s => typeof s === 'string' && Object.prototype.hasOwnProperty.call(taxonomy.sectors, s)).slice(0, 5);
    row('sectors', { sectors: [...new Set(known)] });
  }
  return out.length && out.some(r => r.kind !== 'sectors') ? out : [];
}

export const SYSTEM = 'You read the title (and summary, when there is one) of a Romanian legislative or government record and return JSON. ' +
  'summary: one or two plain Romanian sentences saying what the measure is about, using only what the text says; no opinion, no prediction, no advice. ' +
  'institutions: public institutions named. companies: companies named (none when none are named). sectors: from the given list only.';
export const schema = taxonomy => ({ type: 'object', additionalProperties: false, required: ['summary', 'institutions', 'companies', 'sectors'],
  properties: { summary: { type: 'string' }, institutions: { type: 'array', items: { type: 'string' } },
    companies: { type: 'array', items: { type: 'string' } }, sectors: { type: 'array', items: { type: 'string', enum: Object.keys(taxonomy.sectors) } } } });

export async function runPolicyAi({ lm, rpc, now = new Date(), window = '01-06', maxMinutes = 30, limit = 20, taxonomy, secret, model, log = () => {} }) {
  if (!inWindow(now, window)) return { status: 'outside_window', saved: 0, skipped: 0 };
  try { await lm.ping(); } catch (e) { log('LM Studio is not answering: postponed'); return { status: 'postponed', saved: 0, skipped: 0 }; }
  const deadline = Date.now() + maxMinutes * 60000;
  const events = (await rpc('ai_annotations_pending', { p_secret: secret, p_limit: limit })) || [];
  let saved = 0, skipped = 0;
  for (const ev of events) {
    if (Date.now() > deadline) return { status: 'time_limit', saved, skipped };
    let rows = [];
    try {
      const text = [ev.title, ev.summary].filter(Boolean).join('\n\n').slice(0, 4000);
      rows = checkReply(await lm.json(SYSTEM, 'Sectors: ' + Object.keys(taxonomy.sectors).join(', ') + '\n\n' + text, schema(taxonomy)), ev, taxonomy, model);
    } catch (e) { log(ev.id + ': ' + String(e.message || e).slice(0, 160)); }
    if (!rows.length) { skipped++; continue; }
    saved += Number(await rpc('ai_annotations_save', { p_secret: secret, p_rows: rows })) || 0;
    if (Date.now() > deadline) return { status: 'time_limit', saved, skipped };
  }
  return { status: 'done', saved, skipped };
}

// ------------------------------------------------------------------ the real run
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

// Shared with tools/policy-auto-batch.mjs: the env file, the local model and the RPC client.
export function loadEnvFile(file = join(homedir(), '.config/market-pulse/summarizer.env')) {
  if (existsSync(file)) for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return process.env;
}
export function localModel({ url = 'http://127.0.0.1:1234/v1', model = 'openai/gpt-oss-20b', maxTokens = 800, name = 'policy_annotation' } = {}) {
  const lmUrl = url.replace(/\/$/, '');
  return {
    model,
    ping: async () => { const r = await fetch(lmUrl + '/models', { signal: AbortSignal.timeout(5000) }); if (!r.ok) throw new Error(String(r.status)); },
    json: async (system, user, sch) => {
      const res = await postJson(lmUrl + '/chat/completions', { model, temperature: 0, max_tokens: maxTokens,
        response_format: { type: 'json_schema', json_schema: { name, strict: true, schema: sch } },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }, 600_000);
      if (res.status !== 200) throw new Error('model ' + res.status);
      const c = JSON.parse(res.body).choices?.[0]?.message?.content || '';
      return JSON.parse(c);
    }
  };
}
export function supabaseRpc({ sb, anon, secret }) {
  return async (fn, body) => {
    const res = await fetch(`${sb}/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
      headers: { apikey: anon, authorization: 'Bearer ' + anon, 'content-type': 'application/json' } });
    const text = await res.text();
    if (!res.ok) throw new Error(`${fn}: ${res.status} ${text.slice(0, 200).split(secret).join('[secret]')}`);
    return text ? JSON.parse(text) : null;
  };
}
export function batchConfig(env) {
  const sb = (env.SUPABASE_URL || '').replace(/\/$/, ''), anon = env.SUPABASE_ANON_KEY || '', secret = env.SUMMARY_SECRET || '';
  const ok = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(sb) && !!anon && secret.length >= 32;
  return { ok, sb, anon, secret, lmUrl: env.LMSTUDIO_URL || 'http://127.0.0.1:1234/v1', model: env.LMSTUDIO_MODEL || 'openai/gpt-oss-20b' };
}

async function main() {
  const env = loadEnvFile(), log = (...a) => console.log(new Date().toISOString(), ...a);
  const cfg = batchConfig(env);
  if (!cfg.ok) { log('not configured: SUPABASE_URL, SUPABASE_ANON_KEY, SUMMARY_SECRET'); process.exitCode = 2; return; }
  const lm = localModel({ url: cfg.lmUrl, model: cfg.model }), rpc = supabaseRpc(cfg), secret = cfg.secret, model = cfg.model;
  const taxonomy = JSON.parse(readFileSync(new URL('../config/policy-taxonomy.json', import.meta.url), 'utf8'));
  const r = await runPolicyAi({ lm, rpc, taxonomy, secret, model, log, window: env.AI_WINDOW || '01-06',
    maxMinutes: Math.max(1, Math.min(Number(env.AI_MAX_MINUTES) || 30, 240)), limit: Math.max(1, Math.min(Number(env.AI_LIMIT) || 20, 200)) });
  log('policy annotations:', JSON.stringify(r));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(e => { console.error(String(e.message || e)); process.exitCode = 1; });
