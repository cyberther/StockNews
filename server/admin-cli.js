#!/usr/bin/env node
// Admin account management. Run on the server, as the admin service user:
//
//   node admin-cli.js create <username>      new admin; prompts for a password, prints the 2FA secret
//   node admin-cli.js reset-2fa <username>   new 2FA secret (lost phone)
//   node admin-cli.js set-password <username>
//   node admin-cli.js disable <username>     / enable <username>
//   node admin-cli.js unlock <username>      clear a failed-login lockout
//   node admin-cli.js list
//
// There is deliberately no way to create an admin from the web panel.
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { assertTotpKey, hashPassword, newTotpSecret, otpauthUri, passwordProblem, sealSecret } from './admin-auth.js';

const here = dirname(fileURLToPath(import.meta.url));
try {
  for (const line of readFileSync(join(here, 'admin.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

function die(msg) { console.error(msg); process.exit(1); }
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) die('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in admin.env first.');
try { assertTotpKey(); } catch (e) { die(e.message); }
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

// Reads a line without echoing it to the terminal.
function askHidden(prompt) {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = s => { if (s.includes(prompt)) rl.output.write(prompt); };
    rl.question(prompt, answer => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

async function askPassword() {
  for (;;) {
    const pw = await askHidden('Password: ');
    const problem = passwordProblem(pw);
    if (problem) { console.log(problem); continue; }
    if (pw !== await askHidden('Repeat:   ')) { console.log('Passwords did not match.'); continue; }
    return pw;
  }
}

function showSecret(username, secret) {
  console.log('\nAdd this to an authenticator app (1Password, Aegis, Google Authenticator):');
  console.log('  Secret:', secret.match(/.{1,4}/g).join(' '));
  console.log('  URI:   ', otpauthUri(username, secret));
  console.log('This is shown once. It is stored encrypted and cannot be read back.\n');
}

async function audit(action, target) {
  await db.from('admin_audit').insert({ admin: 'cli:' + (process.env.USER || '?'), action, target });
}

async function byName(name) {
  const { data, error } = await db.from('admin_users').select('id, username').eq('username', name).maybeSingle();
  if (error) die(error.message);
  if (!data) die(`No admin named ${name}.`);
  return data;
}

async function update(name, patch, action) {
  const row = await byName(name);
  const { error } = await db.from('admin_users').update(patch).eq('id', row.id);
  if (error) die(error.message);
  await audit(action, name);
}

const [cmd, raw] = process.argv.slice(2);
const name = String(raw || '').trim().toLowerCase();
const needName = () => { if (!/^[a-z0-9_.-]{3,32}$/.test(name)) die('Username: 3-32 of a-z 0-9 _ . -'); };

switch (cmd) {
  case 'create': {
    needName();
    const pw = await askPassword();
    const secret = newTotpSecret();
    const { error } = await db.from('admin_users').insert({ username: name, pw_hash: await hashPassword(pw), totp_secret_enc: sealSecret(secret) });
    if (error) die(error.code === '23505' ? `${name} already exists.` : error.message);
    await audit('admin_create', name);
    console.log(`Created admin ${name}.`);
    showSecret(name, secret);
    break;
  }
  case 'reset-2fa': {
    needName();
    const secret = newTotpSecret();
    await update(name, { totp_secret_enc: sealSecret(secret), totp_last_step: 0 }, 'admin_reset_2fa');
    showSecret(name, secret);
    break;
  }
  case 'set-password': {
    needName();
    await update(name, { pw_hash: await hashPassword(await askPassword()), failed_count: 0, locked_until: null }, 'admin_set_password');
    console.log('Password changed.');
    break;
  }
  case 'disable': needName(); await update(name, { disabled: true }, 'admin_disable'); console.log(`${name} disabled.`); break;
  case 'enable': needName(); await update(name, { disabled: false }, 'admin_enable'); console.log(`${name} enabled.`); break;
  case 'unlock': needName(); await update(name, { failed_count: 0, locked_until: null }, 'admin_unlock'); console.log(`${name} unlocked.`); break;
  case 'list': {
    const { data, error } = await db.from('admin_users').select('username, disabled, locked_until, last_login_at, created_at').order('username');
    if (error) die(error.message);
    for (const r of data) console.log([r.username.padEnd(20), r.disabled ? 'disabled' : 'active  ', 'last login ' + (r.last_login_at || 'never'), r.locked_until && Date.parse(r.locked_until) > Date.now() ? 'LOCKED' : ''].join('  '));
    if (!data.length) console.log('No admins yet. Create one: node admin-cli.js create <username>');
    break;
  }
  default:
    console.log('Usage: node admin-cli.js create|reset-2fa|set-password|disable|enable|unlock <username>  |  list');
    process.exit(cmd ? 1 : 0);
}
