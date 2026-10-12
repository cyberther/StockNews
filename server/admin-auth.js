// Admin credentials: scrypt password hashes, RFC 6238 TOTP, and AES-256-GCM
// for the TOTP secrets at rest. No dependencies beyond node:crypto.
//
// Used by admin.js (login) and admin-cli.js (creating accounts). Nothing here
// is imported by the public server.
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// ---- passwords --------------------------------------------------------
// N=2^15 keeps a login around 50-100 ms: cheap for one operator, expensive
// for an offline guesser holding a dump of admin_users.
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 32;

function scryptAsync(password, salt, params) {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, KEYLEN, params, (err, key) => (err ? reject(err) : resolve(key))));
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password.normalize('NFKC'), salt, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, expected] = parts;
  const want = Buffer.from(expected, 'base64');
  const got = await scryptAsync(password.normalize('NFKC'), Buffer.from(salt, 'base64'),
    { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return want.length === got.length && timingSafeEqual(want, got);
}

// A real hash of a random password: verifying against it for unknown usernames
// makes "no such admin" take as long as "wrong password".
export const DUMMY_HASH = await hashPassword(randomBytes(16).toString('hex'));

export function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 14) return 'Use at least 14 characters.';
  if (pw.length > 256) return 'Use at most 256 characters.';
  if (new Set(pw).size < 6) return 'Use a less repetitive password.';
  return null;
}

// ---- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ----------------------------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function newTotpSecret() {
  const bytes = randomBytes(20);
  let bits = '', out = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function base32Decode(s) {
  let bits = '';
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error('bad base32');
    bits += v.toString(2).padStart(5, '0');
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}

function hotp(key, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', key).update(msg).digest();
  const off = mac[mac.length - 1] & 0xf;
  const code = (mac.readUInt32BE(off) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

// Returns the matched time step, or null. Accepts one step either side for
// clock drift; the caller rejects any step <= the last one used (replay).
export function checkTotp(secret, code, now = Date.now()) {
  if (!/^\d{6}$/.test(String(code || ''))) return null;
  const key = base32Decode(secret);
  const step = Math.floor(now / 30_000);
  for (const s of [step, step - 1, step + 1]) {
    const want = Buffer.from(hotp(key, s)), got = Buffer.from(String(code));
    if (timingSafeEqual(want, got)) return s;
  }
  return null;
}

export function otpauthUri(username, secret, issuer = 'Market Pulse Admin') {
  const label = encodeURIComponent(issuer + ':' + username);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// ---- secrets at rest ---------------------------------------------------
// ADMIN_TOTP_KEY is 32 random bytes as hex, held only in admin.env. A dump of
// admin_users alone is then not enough to mint 2FA codes.
function totpKey() {
  const hex = process.env.ADMIN_TOTP_KEY || '';
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('ADMIN_TOTP_KEY must be 64 hex characters (openssl rand -hex 32)');
  return Buffer.from(hex, 'hex');
}

export function sealSecret(plain) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', totpKey(), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), body.toString('base64')].join('.');
}

export function openSecret(sealed) {
  const [v, iv, tag, body] = String(sealed || '').split('.');
  if (v !== 'v1') throw new Error('unknown secret format');
  const d = createDecipheriv('aes-256-gcm', totpKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8');
}

export function assertTotpKey() { totpKey(); }
