# Market Pulse (StockNews)

Stock news for the tickers you follow, plus a portfolio, in a web app and a mobile app.
US listings and the Bucharest Stock Exchange (BVB), in English, Romanian and German.

- **Feed** – company news in time order (Following, Market, BVB tabs), with AI summaries in
  the reader's language and a link to read the full article translated.
- **Portfolio** – positions with live P/L and weight, and a value chart (USD / RON).
- **Watchlist** – the tickers you follow, with push alerts for new stories.

## Layout

| Path | What it is |
| --- | --- |
| `templates/stock-news-web/StockNewsWeb.dc.html` | Web app (desktop and phone layouts) |
| `templates/stock-news-dark/StockNewsDark.dc.html` | Mobile app (kept in the repo, not published) |
| `templates/shared/` | Shared client code: data, live adapter, auth, push, charts, motion, BVB catalog |
| `netlify/functions/` | Market data gateway (`/api/finnhub`), config, health endpoint |
| `netlify/functions/_shared/market/` | Gateway: providers (Finnhub, Yahoo, Twelve Data, FMP, Alpha Vantage), Romanian news, caching, failover, usage |
| `supabase/` | Database SQL, the background scan Edge Function, setup guide |
| `server/` | Self-hosted Node server (`/srv/hif`), see `server/SETUP.md` |
| `tools/` | BVB catalog update, AI summary batch job (LM Studio), export rebuild |
| `export/` | Single-file HTML exports of both apps |
| `test/` | `npm test` |

## Run it

```bash
npm install
npm run serve        # builds dist/ and serves it on http://127.0.0.1:8080
npm test
```

Without a Finnhub key the apps fall back to demo data. Netlify builds with
`node scripts/build-netlify.mjs` and publishes `dist/`.

## Guides

- `live-data-setup.md` – market data, backup providers, BVB
- `supabase/README.md` – accounts, background scan and push alerts, positions, usage
  counters and health endpoint, AI summaries
- `server/SETUP.md` – running the server on your own Ubuntu machine
- `SECURITY.md` – security notes
