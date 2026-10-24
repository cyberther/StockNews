import test from 'node:test';
import assert from 'node:assert/strict';
import { configMatches, ensureModel, pickThreads, remoteDesktopActive, wantedConfig } from '../tools/lmstudio-model.mjs';

test('the wanted load config matches itself, and a different thread count does not', () => {
  assert.equal(configMatches(wantedConfig(3), 3), true);
  assert.equal(configMatches(wantedConfig(4), 3), false);
  assert.equal(configMatches(Object.assign(wantedConfig(3), { flashAttention: false }), 3), false);
  assert.equal(configMatches({ contextLength: 8192, flashAttention: true, maxParallelPredictions: 1,
    llamaCppArgumentsOverride: { enabled: false, overrideParameters: [] } }, 3), false);
  assert.equal(configMatches(null, 3), false);
});

test('with threads 0 or without the SDK the model is left alone, without throwing', async () => {
  assert.equal(await ensureModel({ model: 'm', threads: 0, wsUrl: 'ws://127.0.0.1:9' }), 'model settings left to LM Studio');
  assert.match(await ensureModel({ model: 'm', threads: 3, wsUrl: 'ws://127.0.0.1:9', sdkPath: '/nonexistent/sdk.cjs' }), /SDK not found/);
});

// loginctl as seen on the PC: the local desktop session, and a GNOME Remote Desktop login.
const fakeLoginctl = sessions => (cmd, args) => {
  if (args[0] === 'list-sessions') return Object.keys(sessions).map(id => `${id} 1000 yoda - - active no -`).join('\n') + '\n';
  return sessions[args[1]];
};
const LOCAL = 'Type=wayland\nClass=user\nRemote=no\nSeat=seat0\nState=active\n';
const REMOTE = 'Type=wayland\nClass=user\nRemote=no\nSeat=\nState=active\n';
const GREETER = 'Type=wayland\nClass=greeter\nRemote=no\nSeat=seat0\nState=active\n';
const SSH = 'Type=tty\nClass=user\nRemote=yes\nSeat=\nState=active\n';

test('a seatless graphical session is a remote desktop; the local desktop, the login screen and ssh are not', () => {
  assert.equal(remoteDesktopActive(fakeLoginctl({ 18: LOCAL })), false);
  assert.equal(remoteDesktopActive(fakeLoginctl({ 18: LOCAL, 3: REMOTE })), true);
  assert.equal(remoteDesktopActive(fakeLoginctl({ c1: GREETER, 4: SSH })), false);
  assert.equal(remoteDesktopActive(() => { throw new Error('no loginctl'); }), false);
});

test('auto threads: 4 alone, 3 with a remote desktop; a number wins; 0 leaves it to LM Studio', () => {
  assert.equal(pickThreads(undefined, () => false), 4);
  assert.equal(pickThreads('auto', () => true), 3);
  assert.equal(pickThreads('2', () => true), 2);
  assert.equal(pickThreads('0', () => false), 0);
  assert.equal(pickThreads('nonsense', () => true), 3);
});

// A stand-in for the LM Studio SDK: the loaded models, and what the job unloads and loads.
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
function fakeSdk(loaded) {
  const dir = mkdtempSync(join(tmpdir(), 'lms-sdk-')), file = join(dir, 'sdk.cjs');
  globalThis.__lms = { loaded, events: [] };
  writeFileSync(file, `
    const S = globalThis.__lms;
    class LMStudioClient {
      constructor() { this.llm = {
        listLoaded: async () => S.loaded.map(m => ({ modelKey: m.key, identifier: m.key, getLoadConfig: async () => m.config,
          unload: async () => { S.events.push('unload ' + m.key); S.loaded = S.loaded.filter(x => x !== m); } })),
        load: async (key) => { if (S.loaded.length) throw new Error('insufficient system resources'); S.events.push('load ' + key); S.loaded.push({ key, config: null }); } }; }
      async [Symbol.asyncDispose]() {}
    }
    module.exports = { LMStudioClient };`);
  return file;
}

test('another model in memory is unloaded first, so the wanted one can load (2026-10-24: a 27B model left loaded blocked the swap)', async () => {
  const sdkPath = fakeSdk([{ key: 'qwen3.8-27b', config: null }]);
  assert.match(await ensureModel({ model: 'openai/gpt-oss-20b', threads: 4, wsUrl: 'ws://x', sdkPath }), /model reloaded with 4 threads/);
  assert.deepEqual(globalThis.__lms.events, ['unload qwen3.8-27b', 'load openai/gpt-oss-20b']);
});

test('the wanted model already loaded with the right settings: nothing else is touched', async () => {
  const sdkPath = fakeSdk([{ key: 'openai/gpt-oss-20b', config: wantedConfig(4) }]);
  assert.equal(await ensureModel({ model: 'openai/gpt-oss-20b', threads: 4, wsUrl: 'ws://x', sdkPath }), 'model ready (4 threads)');
  assert.deepEqual(globalThis.__lms.events, []);
});
