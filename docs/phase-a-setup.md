# Faza A – pași de activare, verificare și rollback

Codul din branch-ul `phase-a/audit-migrare` nu schimbă nimic în producție până nu faci pașii de mai
jos. Ordinea contează: ingestia trebuie să ruleze verificat înainte ca aplicația să citească din
Supabase și înainte de oprirea cron-ului vechi.

## 1. Supabase (SQL Editor)
1. Rulează `supabase/market-data.sql` (se poate rula de mai multe ori).
2. Programează curățenia (opțional, recomandat):
   ```sql
   select cron.schedule('market-ingest-prune', '29 3 * * *', $job$ select public.ingest_prune(); $job$);
   ```
3. Redeploy pentru Edge Function `scan` (codul din `supabase/functions/scan/index.ts`, JWT verification
   rămâne oprit). Secrete noi, opționale: `FLAG_US_MARKET`, `FLAG_EU_MARKET` (implicit oprite).

## 2. GitHub (Settings → Secrets and variables → Actions)
Secrete:
| Nume | Valoare |
|---|---|
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | cheia service_role (doar aici, niciodată în Netlify/Cloudflare/app) |
| `SCAN_URL` | `https://<project-ref>.supabase.co/functions/v1/scan` |
| `SCAN_SECRET` | același `SCAN_SECRET` ca în Supabase |

Variabilă: `INGEST_ENABLED` = `true` (fără ea, workflow-urile nu rulează).

Verificare: Actions → *Ingest market data* → *Run workflow* (intraday, apoi eod). În sumarul
rulării: simboluri, cotații, povești noi, cereri externe. În Supabase: `market_quotes`,
`ingest_runs`. Local, fără credențiale:
```bash
node ingest/main.mjs --job=eod --dry-run --watchlist=AAPL,SNP.RO,BMW.DE
```

## 3. Oprirea scan-ului vechi (după 1–2 zile de ingestie verificată)
```sql
select cron.unschedule('market-pulse-scan');
```
Push-ul merge mai departe: jobul de ingestie cheamă `scan?mode=alerts` după fiecare rulare cu
povești noi. Alternativ, păstrezi cron-ul și setezi secretul `SCAN_FETCH=off` pe funcție.

## 4. Cloudflare Pages
1. Workers & Pages → Create → Pages → Connect to Git → `cyberther/StockNews`.
2. Build command `npm run build`, output `dist`, root `/`. Production branch: `main`
   (preview automat pe celelalte branch-uri, inclusiv acesta).
3. Variabile (Production și Preview): `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `VAPID_PUBLIC_KEY`,
   `NODE_VERSION=22`. Opțional pentru gateway: `TWELVEDATA_KEY`, `FMP_KEY`, `ALPHAVANTAGE_KEY`.
4. Supabase → Authentication → URL Configuration: adaugă domeniul `*.pages.dev` (și cel final)
   la Redirect URLs; `APP_URL` din `scan` → noul domeniu.
5. Verifică pe preview: Following, BVB, Portfolio, Watchlist; pe iPhone „Add to Home Screen”.

## 5. Netlify
Rămâne neatins până după verificarea pe Cloudflare. Apoi: Site configuration → Delete site
(sau doar dezactivarea deploy-urilor), după acordul tău.

## Rollback
| Problemă | Acțiune |
|---|---|
| Datele din Supabase lipsesc/greșite | `config/flags.json` + `templates/shared/hif-flags.js`: `dataSource: "gateway"` → aplicația revine la `/api/finnhub` |
| Ingestia face ceva greșit | variabila `INGEST_ENABLED` → `false` (oprire imediată) |
| Push-ul nu mai vine | reprogramează `market-pulse-scan` cu SQL-ul din `supabase/push.sql` |
| Cloudflare are probleme | Netlify rulează în paralel până la ștergere; DNS/link înapoi |
| Tab-urile US/EU trebuie repornite | `usMarket` / `euMarket` = `true` în ambele fișiere de flags (+ `FLAG_US_MARKET`/`FLAG_EU_MARKET` pe `scan`) |
