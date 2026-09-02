# Live data (Finnhub) — setup

The prototypes render demo data by default. Real quotes, headlines, symbol search and
analyst ratings come from Finnhub through a server-side proxy, so the API key never sits
in the page.

## 0. The key

The Finnhub dashboard shows one 40-character string — that whole string **is** the key (the
two 20-char halves are rejected on their own). Verified working against `/quote`,
`/company-news`, `/search` and `/stock/recommendation`.

The deployed site keeps the key only in Netlify's protected `FINNHUB_KEY` environment
variable. Never place it in the `finnhubToken` tweak default or commit it to source.

## 1. Deploy from the repo (needed for the proxy)

The proxy is a Netlify Function, so the site has to be a **git-connected Netlify site** —
the one-file preview deploy can't run functions.

1. Netlify → Add new site → Import an existing project → pick `cyberther/StockNews`.
2. Build command: none. Publish directory: `.` (already set in `netlify.toml`).
3. Site configuration → Environment variables → add:

   ```
   FINNHUB_KEY = <your 20-character Finnhub key>
   ```

4. Deploy. The web app is at `/` (redirect), the mobile mock at `/mobile`.

Sanity check: `https://<site>/api/finnhub?path=/quote&symbol=NVDA` should return JSON with a
`c` (current price) field.

## 2. What comes from Finnhub

| In the app | Endpoint | Notes |
| --- | --- | --- |
| Price, daily change, tape | `/quote` | cached 60s |
| Feed + tape headlines, detail tape | `/company-news` | cached 5 min, latest five from a 30-day lookup, English only |
| Screener search | `/search` | cached 5 min, debounced 350ms |
| Analyst card | `/stock/recommendation` | cached 15 min; works on this key (NVDA: 65 / 3 / 1 → 94%); **card hides itself** if a plan blocks it |
| Price charts | Yahoo chart service via `/chart` | actual history for 1D, 1W, 1M, 6M, YTD, 1Y and 5Y |
| Earnings overlay | `/stock/earnings` | recent EPS actuals, estimates and surprises |

News score, volume versus average and the forward earnings countdown remain demo values.
Price history, technical averages, RSI and available historical earnings are live.

## 3. When to refresh

The detail page loads automatically — no polling:

- opening the **Feed** triggers a sync (usually served from cache),
- opening any ticker loads its quote, five latest stories, analyst data, selected chart range and earnings,
- changing a chart range fetches that range immediately,
- the **↻** button remains as an explicit retry that bypasses the client cache,
- following a new ticker fetches it immediately.

## 4. Running without the proxy (local dev)

Open the DC file directly and paste a key into **Tweaks → Live data → finnhubToken**. The
adapter probes `/api/finnhub` first, and falls back to calling finnhub.io straight from the
browser with that token. The badge in the top bar then reads `LIVE · FINNHUB (DIRECT)`.
Don't ship a published page that way — the key is readable in the source.

## 5. Files

- `netlify/functions/finnhub.js` — the proxy (endpoint allowlist + env key)
- `netlify.toml` — functions dir, publish dir, root redirects
- `templates/shared/hif-live.js` — client adapter (proxy → direct → demo), caching, formatting
- `templates/shared/hif-data.js` — demo content and all EN/RO/DE copy
