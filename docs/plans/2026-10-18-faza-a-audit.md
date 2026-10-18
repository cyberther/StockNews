# Faza A – audit inițial al cererilor (read-only)

Data: 2026-10-18. Branch: `phase-a/audit-migrare`. Stare: **doar citire de cod**, nimic modificat
în aplicație. Cifrele de trafic sunt baseline-ul din prompt (observability Netlify, 16–17 oct);
nu le-am remăsurat încă.

Teste existente la pornire: `npm test` → 113 trecute, 0 eșuate.

## Ce generează traficul (cauze găsite în cod)

### 1. Polling-ul de 5 minute vine din client, nu dintr-un cron
`templates/stock-news-web/StockNewsWeb.dc.html` → `startAutoRefresh()` (în jur de linia 1855):
`setInterval(tick, 5 * 60000)`. Fiecare tick cheamă `syncLive`, `syncPositions`,
`syncSummaries`, `syncHistory` și, după tab, `syncMarket` / `syncBvb` / `syncEu`.

- Tick-ul se oprește doar dacă `document.hidden` e adevărat. Un panou de browser deschis
  permanent (ex. browserul din aplicația Claude) raportează pagina ca vizibilă, deci
  polling-ul merge non-stop, inclusiv noaptea. **Explică cele ~2.750 de apeluri din „browserul
  aplicației Claude”.**
- Nu există nicio verificare a programului burselor sau a vechimii datelor.
- Al doilea interval: `syncSummaries` la 2 minute cât timp feed-ul e deschis (Supabase, nu Finnhub).

Cele 4 cereri per ciclu din baseline corespund: `quotes` pentru poziții (PL), `quotes` pentru
watchlist, `quotes` pentru cele 23 de acțiuni .RO (tab-ul BVB) și `recommendation` BMW.DE.

### 2. Recomandarea BMW.DE eșuată se reîncearcă la fiecare ciclu
`templates/shared/hif-live.js` → `recommendation()`: la eroare face `return null` **fără**
`put('recs', …)` („a failed call isn't remembered”). Gateway-ul răspunde 502 (Finnhub dă 403 pe
planul gratuit pentru simboluri non-US) cu `cache-control: no-store`, deci nici CDN-ul nu-l
reține. Rezultat: o invocare plătită, garantat eșuată, la fiecare 5 minute.
Remediere planificată: cache negativ 24 h + nu cerem recomandări pentru simboluri non-US
(Finnhub free nu le are).

### 3. Cache-ul „stale” nu scutește invocarea funcției
`netlify/functions/_shared/market/gateway.js`:
- TTL quote = 30 s, polling = 300 s → fiecare ciclu e un miss la CDN → funcția rulează.
- Când toți furnizorii eșuează, se servește răspunsul vechi cu `ttl: 0` → header
  `cache-control: public, max-age=5` și **fără** `netlify-cdn-cache-control`. CDN-ul nu-l
  păstrează, deci următoarea cerere invocă din nou funcția (care iar eșuează, iar e 1–3 s).
- Cache-ul din memoria funcției (`Map`) se pierde la fiecare cold start.

### 4. Supabase Edge Function `scan` (cele ~760 de apeluri)
`supabase/push.sql`: `cron.schedule('market-pulse-scan', '*/10 * * * *', …)` – la fiecare
10 minute, 24/7. `supabase/functions/scan/index.ts`:
- știri Finnhub direct pentru toate tickerele din watchlist-urile tuturor utilizatorilor
  (max 50) **plus** cele 10 nume fixe ale tab-ului US Market (`MARKET_TOP`), indiferent dacă
  le urmărește cineva;
- pentru tickerele BVB și pentru unele căi cheamă **`/api/finnhub` pe Netlify** (liniile ~141
  și ~173) → invocări Netlify generate de Supabase;
- `stock/profile2` direct la Finnhub.

### 5. Alte surse de cereri (de verificat la runtime)
- La deschidere, utilizator nelogat: `quotes` pentru `LANDING_TICKERS` (linia ~1613).
- `componentDidUpdate` cheamă `syncSummaries()` și `syncHistory()` la *fiecare* update de
  stare (au gărzi interne – de confirmat că nu trimit cereri).
- Tab-urile Market/BVB/EU se încarcă la prima afișare și apoi la fiecare tick dacă sunt
  tab-ul curent.
- Graficul live (`LC_INTERVALS`): refresh la 5–60 s cât e deschis un grafic intraday.
- `load()` face pentru fiecare simbol urmărit `news` + `recommendation` (în paralel), deci
  N simboluri → până la 2N cereri după expirarea cache-ului local (știri 5 min, recs 15 min).
- Nu există feature flags în cod (căutat `FEATURE|flags`); tab-urile US/EU nu au comutator.

## Concluzie pentru planul Fazei A
Cea mai mare reducere vine din trei schimbări mici, care se pot face înaintea migrării:
1. smart refresh (program burse + vechimea datelor + pauză fără interacțiune), nu doar `document.hidden`;
2. cache negativ 24 h pentru recomandări + fără recomandări non-US;
3. oprirea `MARKET_TOP` și a feed-urilor US/EU din `scan` și din client (feature flags).

Apoi ingestia în GitHub Actions → Supabase scoate complet funcția per vizitator.

## Întrebări deschise (pentru brainstorm)
Vezi rezumatul din conversație; răspunsurile se trec aici.
