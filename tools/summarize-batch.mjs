#!/usr/bin/env node
// AI news summaries, in batches, from a local model (LM Studio's OpenAI-compatible server).
//
// Each run asks Supabase for the newest stories without a summary in the chosen language,
// summarizes them one at a time, and saves the results (supabase/summaries.sql). Meant for a
// systemd timer every 30 minutes (tools/systemd/); it exits when done, and exits quietly
// when LM Studio isn't running.
//
// Settings come from the environment or from ~/.config/market-pulse/summarizer.env:
//   SUPABASE_URL, SUPABASE_ANON_KEY  the project's public URL and key
//   SUMMARY_SECRET                   the batch job's secret (Vault 'summary_secret')
//   LMSTUDIO_URL    default http://127.0.0.1:1234/v1
//   LMSTUDIO_MODEL  default openai/gpt-oss-20b
//   SUMMARY_LANG    default ro
//   BATCH_LIMIT     default 15 stories a run
//   MAX_AGE_HOURS   default 24
//
// The model only gets the headline and the source's own short summary: it never fetches
// articles, so it can't add what the source didn't say or copy paywalled text.
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
  lang: env.SUMMARY_LANG || 'ro',
  limit: Math.max(1, Math.min(Number(env.BATCH_LIMIT) || 15, 100)),
  hours: Math.max(1, Math.min(Number(env.MAX_AGE_HOURS) || 24, 168))
};

const PROMPTS = {
  ro: 'Ești redactor financiar. Rezumă în limba română, în 2-3 propoziții scurte, DOAR informația din textul primit. ' +
      'Nu adăuga cifre, nume, cauze sau interpretări care nu apar în text și nu generaliza (de exemplu, livrările unei ' +
      'companii nu sunt livrările întregii piețe). Păstrează simbolurile bursiere și cifrele exact; scrie o scădere ca ' +
      '„a scăzut cu 1,2%”, fără semnul minus. Nu folosi cuvinte în engleză când există echivalent românesc. ' +
      'Folosește diacriticele corecte (ă, â, î, ș, ț). Răspunde doar cu rezumatul, fără titlu și fără ghilimele.',
  en: 'You are a financial editor. Summarize in English, in 2-3 short sentences, ONLY the information in the text given. ' +
      'Do not add figures, names, causes or interpretation that are not in it. Keep tickers and figures exact. ' +
      'Reply with the summary only.',
  de: 'Du bist Finanzredakteur. Fasse auf Deutsch in 2-3 kurzen Sätzen NUR die Informationen aus dem Text zusammen. ' +
      'Füge keine Zahlen, Namen, Ursachen oder Deutungen hinzu, die nicht im Text stehen. Ticker und Zahlen exakt übernehmen. ' +
      'Antworte nur mit der Zusammenfassung.'
};

const log = (...a) => console.log(new Date().toISOString(), ...a);

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

// Cedilla forms (ş ţ) to the correct comma-below letters, and tidy the model's reply.
export function cleanSummary(text) {
  let s = String(text || '')
    .replace(/ş/g, 'ș').replace(/Ş/g, 'Ș').replace(/ţ/g, 'ț').replace(/Ţ/g, 'Ț')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/^\s*(rezumat|summary|zusammenfassung)\s*:\s*/i, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/^["„“”«»']+|["„“”«»']+$/g, '').trim();
  return s;
}
// A reply worth saving: prose of a sensible length, not a tool call or JSON.
export function usable(s) {
  return s.length >= 40 && s.length <= 1200 && !/^[{[]/.test(s) && !/"(name|parameters)"\s*:/.test(s);
}

async function summarize(story) {
  const input = `Ticker: ${story.ticker}\nTitlu: ${story.headline}\nRezumat sursă: ${story.summary || '(fără rezumat)'}`;
  const res = await fetch(`${cfg.lmUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, temperature: 0.2, max_tokens: 600,
      messages: [{ role: 'system', content: PROMPTS[cfg.lang] || PROMPTS.en }, { role: 'user', content: input }] }),
    signal: AbortSignal.timeout(300_000)
  });
  if (!res.ok) throw new Error(`model: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const d = await res.json();
  return cleanSummary(d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content);
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

  const stories = await rpc('summaries_pending', { p_secret: cfg.secret, p_lang: cfg.lang, p_limit: cfg.limit, p_hours: cfg.hours }) || [];
  if (!stories.length) { log('no stories waiting'); return; }
  log(`${stories.length} stories to summarize with ${cfg.model}`);

  let saved = 0;
  for (const s of stories) {
    const t0 = Date.now();
    try {
      const text = await summarize(s);
      if (!usable(text)) { log('skipped', s.id, '- reply not usable'); continue; }
      // Saved one at a time, so a slow batch still shows progress in the apps.
      saved += await rpc('summaries_save', { p_secret: cfg.secret, p_rows: [{ story_id: s.id, lang: cfg.lang, summary: text, model: cfg.model }] }) || 0;
      log('saved', s.id, `${Math.round((Date.now() - t0) / 1000)}s`);
    } catch (e) {
      log('failed', s.id, String(e.message || e));
    }
  }
  log(`done: ${saved} of ${stories.length} saved`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { log('error', e.message); process.exitCode = 1; });
