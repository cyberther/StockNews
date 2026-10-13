// Keeps the summary model loaded with the settings that are fastest on a small CPU-only PC.
//
// LM Studio's headless server (llmster) picks its own thread count and has no CLI option to
// change it; on the 4-core i5 it chose 1 thread. Measured on that PC per summary:
//   with a Remote Desktop session (the desktop then uses ~2 cores): 1 thread ~250 s,
//     2 threads 190 s, 3 threads 151 s, 4 threads 247 s (fighting the desktop for cores);
//   with nobody connected remotely: 3 threads 121 s, 4 threads 105 s.
// So before each batch the job picks 4 threads, or 3 while a remote graphical session is
// open, and reloads the model through LM Studio's own SDK (shipped inside LM Studio, so
// nothing extra to install) only when it is loaded differently.
//
//   LMSTUDIO_THREADS  auto (default) | a number | 0 to leave LM Studio's own choice alone
//   LMSTUDIO_SDK      path to @lmstudio/sdk's dist/index.cjs (default: the copy LM Studio ships)
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SDK_PATHS = ['rag-v1', 'js-code-sandbox'].map(p =>
  join(homedir(), '.lmstudio/extensions/plugins/lmstudio', p, 'node_modules/@lmstudio/sdk/dist/index.cjs'));

// Is someone connected to this PC's desktop remotely (GNOME Remote Desktop / RDP)? A
// graphical login session without a seat, or one systemd marks remote.
export function remoteDesktopActive(run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000 })) {
  try {
    const ids = run('loginctl', ['list-sessions', '--no-legend']).split('\n').map(l => l.trim().split(/\s+/)[0]).filter(Boolean);
    return ids.some(id => {
      const p = Object.fromEntries(run('loginctl', ['show-session', id, '-p', 'Type', '-p', 'Class', '-p', 'Remote', '-p', 'Seat', '-p', 'State'])
        .split('\n').filter(Boolean).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
      return p.Class === 'user' && (p.Type === 'wayland' || p.Type === 'x11') && p.State !== 'closing' && (p.Remote === 'yes' || !p.Seat);
    });
  } catch { return false; }
}
// "auto": 4 threads, or 3 while a remote desktop session is open.
export function pickThreads(setting, remote = remoteDesktopActive) {
  const v = String(setting == null ? 'auto' : setting).trim().toLowerCase();
  if (v === '' || v === 'auto') return remote() ? 3 : 4;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 64) : (remote() ? 3 : 4);
}

// The load settings: one conversation at a time (the batch job is the only user), flash
// attention on, an 8k context (an article is ~1,500 tokens), and the thread count.
export function wantedConfig(threads) {
  return {
    contextLength: 8192,
    maxParallelPredictions: 1,
    flashAttention: true,
    keepModelInMemory: true,
    llamaCppArgumentsOverride: { enabled: true, disabledParameters: [], excludeAllConfig: false,
      overrideParameters: [{ key: '--threads', value: String(threads) }] }
  };
}

// True when a loaded model's config already matches.
export function configMatches(cfg, threads) {
  const o = cfg && cfg.llamaCppArgumentsOverride;
  const t = o && o.enabled && (o.overrideParameters || []).find(p => p.key === '--threads');
  return !!(cfg && cfg.flashAttention === true && cfg.maxParallelPredictions === 1 && cfg.contextLength === 8192 &&
    t && t.value === String(threads));
}

// Returns a short note for the log. Never throws: the batch still runs on whatever is loaded.
export async function ensureModel({ model, threads, wsUrl, sdkPath }) {
  if (!threads) return 'model settings left to LM Studio';
  const path = sdkPath || SDK_PATHS.find(p => existsSync(p));
  if (!path || !existsSync(path)) return 'LM Studio SDK not found; model settings unchanged';
  let client;
  try {
    const { LMStudioClient } = createRequire(import.meta.url)(path);
    client = new LMStudioClient({ baseUrl: wsUrl, verboseErrorMessages: false });
    const loaded = (await client.llm.listLoaded()).filter(m => m.modelKey === model || m.identifier === model);
    for (const m of loaded) {
      if (configMatches(await m.getLoadConfig(), threads)) return `model ready (${threads} threads)`;
    }
    for (const m of loaded) await m.unload();
    const t0 = Date.now();
    await client.llm.load(model, { verbose: false, config: wantedConfig(threads) });
    return `model reloaded with ${threads} threads in ${Math.round((Date.now() - t0) / 1000)} s`;
  } catch (e) {
    return 'model settings unchanged: ' + String(e && e.message || e).slice(0, 160);
  } finally {
    try { if (client && client[Symbol.asyncDispose]) await client[Symbol.asyncDispose](); } catch {}
  }
}
