// Editable site content: the shape of every key the admin panel may write to
// public.site_content. The public server serves stored values as-is, so this
// validator is the only gate — it rejects rather than trims, like the
// settings validator in server.js.

export const CONTENT_KEYS = ['featured', 'tickers', 'sources', 'copy', 'universe'];
export const LANGS = ['EN', 'RO', 'DE'];

const SYMBOL_RE = /^[A-Z0-9][A-Z0-9.\-]{0,11}$/;
const COPY_KEY_RE = /^[A-Za-z][A-Za-z0-9]{0,40}$/;

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max, required) =>
  v === undefined || v === '' ? (required ? 'required' : null)
    : typeof v !== 'string' ? 'not_text'
    : v.length > max ? 'too_long'
    : /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v) ? 'control_chars'
    : null;
const onlyKeys = (o, keys) => Object.keys(o).find(k => !keys.includes(k));

function localized(v, max, field) {
  if (!isObj(v)) return `${field}: expected EN/RO/DE text`;
  const extra = onlyKeys(v, LANGS); if (extra) return `${field}.${extra}: unknown language`;
  for (const l of LANGS) { const e = str(v[l], max, l === 'EN'); if (e) return `${field}.${l}: ${e}`; }
  return null;
}

const CHECKS = {
  // The landing page's "Top story now" card.
  featured(v) {
    if (!isObj(v)) return 'expected an object';
    const extra = onlyKeys(v, ['ticker', 'score', 'delta', 'source', 'stamp', 'headline', 'watch']);
    if (extra) return `${extra}: unknown field`;
    if (typeof v.ticker !== 'string' || !SYMBOL_RE.test(v.ticker)) return 'ticker: expected a symbol like NVDA';
    for (const [k, max] of [['score', 8], ['delta', 10], ['source', 40], ['stamp', 20]]) {
      const e = str(v[k], max, k !== 'stamp'); if (e) return `${k}: ${e}`;
    }
    return localized(v.headline, 160, 'headline') || localized(v.watch, 240, 'watch');
  },
  // Symbols on the landing ticker strip, in order.
  tickers(v) {
    if (!Array.isArray(v) || v.length < 1 || v.length > 8) return 'expected 1-8 symbols';
    const bad = v.find(t => typeof t !== 'string' || !SYMBOL_RE.test(t)); if (bad !== undefined) return `bad symbol: ${String(bad).slice(0, 16)}`;
    if (new Set(v).size !== v.length) return 'duplicate symbol';
    return null;
  },
  // The "N news sources" figure shown on the landing and the app rail.
  sources(v) {
    if (!isObj(v) || onlyKeys(v, ['count'])) return 'expected { count }';
    return Number.isInteger(v.count) && v.count >= 0 && v.count <= 100000 ? null : 'count: expected a whole number 0-100000';
  },
  // Per-language overrides of interface copy, keyed by the UI string id.
  copy(v) {
    if (!isObj(v)) return 'expected { EN, RO, DE }';
    const extra = onlyKeys(v, LANGS); if (extra) return `${extra}: unknown language`;
    for (const l of Object.keys(v)) {
      if (!isObj(v[l])) return `${l}: expected an object`;
      const keys = Object.keys(v[l]);
      if (keys.length > 300) return `${l}: too many overrides`;
      for (const k of keys) {
        if (!COPY_KEY_RE.test(k)) return `${l}.${k.slice(0, 40)}: bad key`;
        const e = str(v[l][k], 400, true); if (e) return `${l}.${k}: ${e}`;
      }
    }
    return null;
  },
  // Extra names added to the searchable market (screener, search).
  universe(v) {
    if (!Array.isArray(v) || v.length > 200) return 'expected up to 200 entries';
    const seen = new Set();
    for (const row of v) {
      if (!isObj(row) || onlyKeys(row, ['ticker', 'name'])) return 'each entry is { ticker, name }';
      if (typeof row.ticker !== 'string' || !SYMBOL_RE.test(row.ticker)) return `bad symbol: ${String(row.ticker).slice(0, 16)}`;
      if (seen.has(row.ticker)) return `duplicate symbol: ${row.ticker}`;
      seen.add(row.ticker);
      const e = str(row.name, 60, true); if (e) return `${row.ticker}.name: ${e}`;
    }
    return null;
  }
};

export function validateContent(key, value) {
  if (!CONTENT_KEYS.includes(key)) return 'unknown content key';
  if (JSON.stringify(value).length > 60_000) return 'too large';
  return CHECKS[key](value);
}
