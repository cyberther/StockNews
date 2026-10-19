import test from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.window = globalThis;
globalThis.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
await import('../templates/shared/hif-unlock.js');
const U = window.HIFUnlock;

test('first sign-in on a device: offer what this device can do and is not on yet', () => {
  assert.deepEqual(U.setupItems({ userId: 'u1', push: 'off', bioAvail: true, bioOn: false }), ['push', 'bio']);
  assert.deepEqual(U.setupItems({ userId: 'u1', push: 'on', bioAvail: true, bioOn: false }), ['bio']);
  assert.deepEqual(U.setupItems({ userId: 'u1', push: 'off', bioAvail: false, bioOn: false }), ['push']);
  // An iPhone browser tab cannot get alerts: say how (add to Home Screen), once.
  assert.deepEqual(U.setupItems({ userId: 'u1', push: 'ios-install', bioAvail: true, bioOn: true }), ['ios-install']);
  // Nothing to offer: denied, unsupported, unavailable, already on.
  assert.deepEqual(U.setupItems({ userId: 'u1', push: 'denied', bioAvail: true, bioOn: true }), []);
  assert.deepEqual(U.setupItems({ userId: 'u1', push: 'unavailable', bioAvail: false, bioOn: false }), []);
  assert.deepEqual(U.setupItems({ userId: '', push: 'off', bioAvail: true, bioOn: false }), []);
});

test('asked once per device and account', () => {
  assert.equal(U.setupAsked('u2'), false);
  U.markSetupAsked('u2');
  assert.equal(U.setupAsked('u2'), true);
  assert.deepEqual(U.setupItems({ userId: 'u2', push: 'off', bioAvail: true, bioOn: false }), []);
  assert.equal(U.setupAsked('u3'), false);
});

test('a lock asks Face ID / Touch ID by itself once, never in a loop', () => {
  assert.equal(U.autoTry('lock-1'), true);
  assert.equal(U.autoTry('lock-1'), false);
  assert.equal(U.autoTry('lock-2'), true);
  assert.equal(U.autoTry(''), false);
});
