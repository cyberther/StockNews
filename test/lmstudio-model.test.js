import test from 'node:test';
import assert from 'node:assert/strict';
import { configMatches, ensureModel, wantedConfig } from '../tools/lmstudio-model.mjs';

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
