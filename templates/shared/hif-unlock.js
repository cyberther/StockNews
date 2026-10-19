// Unlocking the app's lock screen with Face ID, Touch ID or a fingerprint (WebAuthn with
// the device's own authenticator), instead of typing the password. Works in Safari and in
// the app saved to an iPhone's home screen (iOS 16+), and in Chrome, Edge and Firefox.
//
// It guards the lock screen of a device that is already signed in: the account's sign-in
// (password, then the two-factor code) is unchanged. A credential is made per device and
// account, and kept by the device's keychain; this page keeps only its id.
//
//   await HIFUnlock.available()          -> true when the device has Face ID / Touch ID / similar
//   HIFUnlock.enabled(userId)            -> true when this device unlocks that account with it
//   await HIFUnlock.enable(userId, email, name) -> { ok } | { error }
//   HIFUnlock.disable(userId)
//   await HIFUnlock.unlock(userId)       -> { ok } | { error: 'cancelled' | 'failed' }
//
// The first sign-in on a device offers what it can do (alerts, Face ID / Touch ID), once:
//   HIFUnlock.setupItems({ userId, push, bioAvail, bioOn }) -> ['push' | 'ios-install' | 'bio', ...]
//   HIFUnlock.setupAsked(userId) / HIFUnlock.markSetupAsked(userId)
// A lock asks Face ID / Touch ID by itself, once per lock: HIFUnlock.autoTry(lockId) -> boolean.
(function () {
  if (window.HIFUnlock) return;
  const KEY = id => 'hif.unlock.' + id;
  const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const bytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
  const random = n => crypto.getRandomValues(new Uint8Array(n));
  const read = id => { try { return JSON.parse(localStorage.getItem(KEY(id)) || 'null'); } catch (e) { return null; } };

  async function available() {
    try {
      return !!(window.PublicKeyCredential && window.isSecureContext &&
        await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
    } catch (e) { return false; }
  }
  function enabled(userId) { const c = userId && read(userId); return !!(c && c.id); }

  async function enable(userId, email, name) {
    if (!userId || !(await available())) return { error: 'unavailable' };
    try {
      const cred = await navigator.credentials.create({ publicKey: {
        rp: { name: 'Market Pulse', id: location.hostname },
        user: { id: random(16), name: email || 'Market Pulse', displayName: name || email || 'Market Pulse' },
        challenge: random(32),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
        timeout: 60000, attestation: 'none'
      } });
      if (!cred) return { error: 'cancelled' };
      try { localStorage.setItem(KEY(userId), JSON.stringify({ id: b64(cred.rawId), at: Date.now() })); } catch (e) { return { error: 'failed' }; }
      return { ok: true };
    } catch (e) { return { error: e && e.name === 'NotAllowedError' ? 'cancelled' : 'failed' }; }
  }

  function disable(userId) { try { localStorage.removeItem(KEY(userId)); } catch (e) {} }

  async function unlock(userId) {
    const c = read(userId);
    if (!c || !c.id) return { error: 'failed' };
    try {
      const a = await navigator.credentials.get({ publicKey: {
        challenge: random(32), rpId: location.hostname, timeout: 60000, userVerification: 'required',
        allowCredentials: [{ type: 'public-key', id: bytes(c.id), transports: ['internal'] }]
      } });
      if (!a || b64(a.rawId) !== c.id) return { error: 'failed' };
      // The authenticator says the user was verified (Face ID, Touch ID, PIN): flag UV.
      const data = new Uint8Array(a.response.authenticatorData);
      return data.length > 32 && (data[32] & 0x04) ? { ok: true } : { error: 'failed' };
    } catch (e) { return { error: e && e.name === 'NotAllowedError' ? 'cancelled' : 'failed' }; }
  }

  const ASKED = id => 'hif.setup.' + id;
  function setupAsked(userId) { try { return !!localStorage.getItem(ASKED(userId)); } catch (e) { return true; } }
  function markSetupAsked(userId) { try { localStorage.setItem(ASKED(userId), String(Date.now())); } catch (e) {} }
  // push: HIFPush.status() ('on' | 'off' | 'denied' | 'ios-install' | 'unsupported' | 'unavailable').
  function setupItems(o) {
    if (!o || !o.userId || setupAsked(o.userId)) return [];
    const out = [];
    if (o.push === 'off') out.push('push');
    else if (o.push === 'ios-install') out.push('ios-install');
    if (o.bioAvail && !o.bioOn) out.push('bio');
    return out;
  }
  const tried = new Set();
  function autoTry(lockId) { if (!lockId || tried.has(lockId)) return false; tried.add(lockId); return true; }

  window.HIFUnlock = { available, enabled, enable, disable, unlock, setupItems, setupAsked, markSetupAsked, autoTry };
})();
