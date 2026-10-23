// Local persistence + password heuristics for the Heard It First prototypes.
// One record per template (see STORE_KEY in each page), versioned so a shape
// change invalidates old records instead of half-restoring them.
(function(){
const VERSION = 2;
const serialized = new Map();
function read(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const o = JSON.parse(raw);
    return (o && o.v === VERSION && o.d && typeof o.d === 'object') ? migrate(o.d) : null;
  } catch (e) { return null; }
}
// Demo tickers that were renamed to their real US listing (NOVO was never a US symbol;
// Novo Nordisk trades as NVO). Saved watchlists move over on the next read.
const RENAMED = { NOVO:'NVO' };
function migrate(d) {
  const re = t => RENAMED[t] || t;
  if (Array.isArray(d.follows)) d.follows = d.follows.map(re).filter((t, i, a) => a.indexOf(t) === i);
  if (Array.isArray(d.stack)) d.stack = d.stack.map(re).filter((t, i, a) => a.indexOf(t) === i);
  if (typeof d.selected === 'string') d.selected = re(d.selected);
  if (d.push && typeof d.push === 'object') Object.keys(d.push).forEach(t => { if (RENAMED[t]) { d.push[RENAMED[t]] = d.push[t]; delete d.push[t]; } });
  return d;
}
function write(key, data) {
  try { const text = JSON.stringify({ v:VERSION, d:data }); if(serialized.get(key) === text && localStorage.getItem(key) === text) return; localStorage.setItem(key,text); serialized.set(key,text); } catch (e) {}
}
// Small, illustrative breach list — a prototype stand-in for a k-anonymity API call.
const BREACHED = ['password','password1','passw0rd','123456','12345678','123456789','qwerty','qwerty123',
  'letmein','iloveyou','admin','welcome','monkey','dragon','abc123','football','baseball','trustno1',
  'sunshine','master','shadow','superman','princess','starwars','freedom','whatever','ninja','azerty',
  'batman','zaq12wsx','qazwsx','1q2w3e4r','login','hello','charlie','donald','biteme'];
function strength(pw) {
  const s = String(pw || '');
  if (!s) return { score:0, breached:false, hints:[] };
  const breached = BREACHED.indexOf(s.toLowerCase()) !== -1 || /^(.)\1+$/.test(s) || /^(?:0123456789|1234567890)/.test(s);
  const hints = [];
  let score = 0;
  if (s.length >= 8) score++; else hints.push('len');
  if (/[a-z]/.test(s) && /[A-Z]/.test(s)) score++; else hints.push('case');
  if (/[0-9]/.test(s)) score++; else hints.push('digit');
  if (/[^A-Za-z0-9]/.test(s)) score++; else hints.push('symbol');
  if (s.length >= 14 && score === 4) score = 4;
  if (breached) score = Math.min(score, 1);
  return { score: Math.max(0, Math.min(4, score)), breached, hints };
}
function secret() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 16; i++) out += A[Math.floor(Math.random() * A.length)];
  return out.replace(/(.{4})(?=.)/g, '$1 ');
}
function recoveryCodes(n) {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', out = [];
  for (let i = 0; i < (n || 8); i++) {
    let c = '';
    for (let k = 0; k < 10; k++) c += A[Math.floor(Math.random() * A.length)];
    out.push(c.slice(0,5) + '-' + c.slice(5));
  }
  return out;
}
window.HIFStore = { read, write, strength, secret, recoveryCodes, VERSION };
})();
