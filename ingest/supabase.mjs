// A minimal PostgREST client for the ingestion jobs, with the service-role key (GitHub
// Actions secret SUPABASE_SERVICE_ROLE_KEY). The key goes in headers only, and never into
// an error message: the repository and its Actions logs are public.
const URL_RE = /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i;
const PAGE = 1000;

export function createDb({ url, key, fetch: fetchImpl = globalThis.fetch }) {
  if (!url || !URL_RE.test(url)) throw new Error('SUPABASE_URL must be https://<project>.supabase.co');
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
  const base = url.replace(/\/$/, '') + '/rest/v1/';
  const headers = extra => ({ apikey: key, authorization: 'Bearer ' + key, 'content-type': 'application/json', accept: 'application/json', ...extra });
  async function call(table, path, init) {
    const res = await fetchImpl(base + path, { ...init, signal: AbortSignal.timeout(20000) });
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).split(key).join('[key]').slice(0, 200);
      throw new Error(`supabase ${table}: ${res.status} ${text}`);
    }
    return res.status === 204 || /minimal/.test(init.headers.prefer || '') ? [] : res.json();
  }
  return {
    // Every row, a page of 1000 at a time.
    async read(table, query) {
      const out = [];
      for (let from = 0; ; from += PAGE) {
        const rows = await call(table, `${table}?${query}`, { method: 'GET', headers: headers({ range: `${from}-${from + PAGE - 1}`, 'range-unit': 'items' }) });
        out.push(...rows);
        if (rows.length < PAGE) return out;
      }
    },
    // ignoreDuplicates: existing rows stay as they are, and only the new ones come back.
    upsert(table, rows, { onConflict, ignoreDuplicates = false } = {}) {
      return call(table, `${table}?on_conflict=${encodeURIComponent(onConflict)}`, { method: 'POST', body: JSON.stringify(rows),
        headers: headers({ prefer: `resolution=${ignoreDuplicates ? 'ignore' : 'merge'}-duplicates,return=representation` }) });
    },
    // A database function (PostgREST /rpc), with the service key.
    rpc(name, args) {
      return call(name, `rpc/${name}`, { method: 'POST', body: JSON.stringify(args || {}), headers: headers() });
    },
    insert(table, rows) {
      return call(table, table, { method: 'POST', body: JSON.stringify(rows), headers: headers({ prefer: 'return=minimal' }) });
    }
  };
}
