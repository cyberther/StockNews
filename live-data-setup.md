# Live data (Finnhub) — setup

The prototypes render demo data by default. Real quotes, headlines, symbol search and
analyst ratings come from Finnhub through a server-side proxy, so the API key never sits
in the page.

## 0. The key

The Finnhub dashboard shows one 40-character string — that whole string **is** the key (the
two 20-char halves are rejected on their own). Verified working against `/quote`,
`/company-news`, `/search` and `/stock/recommendation`.

It is currently set as the default of the `finnhubToken` tweak so the prototype runs live
out of the box, which means **it travels with the source** (repo, downloads, any page I
publish). Once the proxy site is up, clear that tweak default and keep the key only in
`FINNHUB_KEY`.

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
| Feed + tape headlines, detail tape | `/company-news` | cached 5 min, last 48h, English only |
| Screener search | `/search` | cached 5 min, debounced 350ms |
| Analyst card | `/stock/recommendation` | cached 15 min; works on this key (NVDA: 65 / 3 / 1 → 94%); **card hides itself** if a plan blocks it |

Not available on the free plan, so these stay demo values: news score, volume vs average,
earnings countdown, 6-month chart (the chart is generated per ticker from its 6-month figure).

## 3. When to refresh

Manual by design — no polling:

- opening the **Feed** triggers a sync (usually served from cache),
- the **↻** button on a ticker's detail page forces a fresh fetch for that ticker,
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
