# Faza A – design: audit, migrare, reducere consum

Data: 2026-10-18 · Branch: `phase-a/audit-migrare` · Sursa cerințelor: MASTER PROMPT Market Pulse 2.0,
secțiunile 0–4, 8–10. Audit: `docs/plans/2026-10-18-faza-a-audit.md`.

Ce e marcat **[decizia mea]** e o alegere făcută de Claude, nu de proprietar; se poate schimba.

## De ce

Aplicația cheamă furnizorii externi (Finnhub, Yahoo) **din browserul fiecărui vizitator**,
printr-o funcție Netlify, la fiecare 5 minute, 24/7. Creditele Netlify sunt epuizate, Finnhub nu
poate fi folosit comercial pe planul gratuit, iar jumătate din apeluri sunt redundante (BMW.DE
eșuat garantat, polling noaptea, panou de browser mereu „vizibil”). Scopul Fazei A: datele de
piață sunt aduse **o singură dată, centralizat**, scrise în Supabase și citite de toți clienții de
acolo; frontend-ul devine static (Cloudflare Pages).

## Obiective
1. Cereri externe redundante: minimum −70% față de baseline (~4.000 invocări / 34 h).
2. Zero funcții serverless per vizitator pentru cotații și știri.
3. Feature flags: ACTIVE Following, BVB, Portfolio; ON HOLD US Market, EU Market, scanarea
   universului, prefetch știri neurmărite, refresh module invizibile – oprite în frontend, gateway,
   joburi și Edge Function.
4. Strat de furnizori cu câmp `license`; flag `COMMERCIAL_MODE` (implicit `false`).
5. Ingestie în GitHub Actions: batch, deduplicare, circuit breaker, bugete, alerte, keepalive.
6. Frontend gata de Cloudflare Pages (build, headere, redirect-uri, config static).

## Non-obiective (Faza A)
- Fără Policy/Impact/Scenarios (Faza B/C), fără plăți (Faza D).
- Nu se șterge codul tab-urilor US/EU, al funcției Netlify sau al gateway-ului: rămân în spatele
  flag-urilor până la verificarea migrării.
- Nu se schimbă nimic în producție / pe contul Supabase live fără acord (vezi „Pași manuali”).

## Anti-obiective (eșec chiar dacă „merge”)
- Date vechi prezentate ca live.
- Following, BVB, Portfolio, Watchlist sau alertele push stricate.
- Chei (service role, furnizori) ajunse în browser sau în log-uri publice (repo-ul e **public**).
- Date `dev_only` (Yahoo) expuse public, fără autentificare.

## Arhitectura

```
GitHub Actions (cron :07 :22 :37 :52, doar când e deschisă o bursă relevantă + job EOD)
  └─ ingest/run.mjs ── provider registry (yahoo=dev_only; eodhd/twelvedata/bvb = stub)
        │  universul = reuniunea watchlist ∪ holdings ∪ top BVB, deduplicat, filtrat pe flags
        │  circuit breaker + buget per furnizor/job (stare în Supabase)
        ├─ upsert market_quotes / market_recommendations / stories
        ├─ insert ingest_runs (pentru monitorizare și măsurare)
        └─ POST scan?mode=alerts (push pentru poveștile noi; scan nu mai aduce date)
Supabase (Postgres + RLS) ◄── browserul citește direct (PostgREST), un request per refresh
Cloudflare Pages (static) + o singură Pages Function opțională /api/finnhub pentru acțiuni
  inițiate de utilizator (grafic, căutare, profil) – fără Finnhub, fail-open.
```

### Decizii

| # | Decizie | Motiv |
|---|---|---|
| D1 | **[decizia mea]** Flag-urile stau în `config/flags.json`; `templates/shared/hif-flags.js` e copia pentru browser; un test verifică că sunt identice. | O singură sursă, fără pas de build pentru pagini deschise direct. |
| D2 | **[decizia mea]** Programul burselor (BVB 10:00–17:45 Europe/Bucharest, XETRA 09:00–17:30 Europe/Berlin, US 09:30–16:00 America/New_York, L–V) e un modul pur, comun browserului și joburilor. Sărbătorile legale nu sunt modelate în Faza A. | DST corect prin `Intl`; un job în zi de sărbătoare doar nu găsește prețuri noi. |
| D3 | Smart refresh: refresh doar dacă pagina e vizibilă **și** a existat interacțiune în ultimele 15 min **și** (o bursă relevantă e deschisă sau datele sunt mai vechi decât ultima închidere) **și** datele au trecut de intervalul minim (5 min). | Rezolvă panoul de browser mereu „vizibil” care producea ~2.750 de apeluri. |
| D4 | Datele afișate poartă `fetched_at`/`market_time`; peste 20 min în timpul bursei sau în afara ei, UI-ul arată „la HH:MM”, nu „live”. | Cerința „niciodată prezentate ca live”. |
| D5 | **[decizia mea]** Citirea datelor de piață: `anon` vede doar rânduri cu licență ≠ `dev_only`; utilizatorii aprobați (`is_approved()`) văd tot. | Specificația cere citire publică, dar Yahoo e `dev_only`; expunerea lui publică ar fi redistribuire. Cu date licențiate, citirea devine publică automat. |
| D6 | Recomandări: doar în jobul EOD, doar pentru simboluri US, cache 24 h **inclusiv pentru eșecuri/lipsă date** (`status = 'none'`). Clientul nu le mai cere la furnizor. | Elimină cererea BMW.DE care eșua la fiecare 5 min. |
| D7 | **[decizia mea]** Știri pentru Following: feed-urile RSS existente (RO press, US wires/CNBC/MarketWatch, EU press – modulele din `netlify/functions/_shared/market/`) citite o dată pe ciclu și filtrate pe tickerele urmărite. Nu se fac cereri per simbol. | Număr fix de cereri indiferent câte tickere; reutilizează codul testat. Feed-urile *de tab* US/EU rămân ON HOLD. |
| D8 | `scan` primește modul `alerts`: nu mai aduce știri, trimite push pentru `stories` cu `alerted_at is null`. Jobul de ingestie îl apelează după fiecare rulare. `MARKET_TOP` dispare când `usMarket` e off. | Push-ul rămâne funcțional fără Finnhub și fără cron la 10 min. |
| D9 | Circuit breaker: după 3 eșecuri consecutive furnizorul e „deschis” 30 min (stare în `ingest_provider_state`); fără retry în același ciclu. Buget zilnic per furnizor și per job în `config/budgets.json`; la depășire jobul degradează (sare peste furnizor) și deschide/actualizează un issue GitHub. | Cerința „fără retry loops”, „degradare controlată”. |
| D10 | Keepalive: workflow lunar care re-activează workflow-urile programate prin API (`gh workflow enable`), fără commit-uri goale. Health zilnic (inclusiv weekend): verifică rulările ratate din `ingest_runs` și face o interogare Supabase (proiectul gratuit intră în pauză după 7 zile fără activitate). | Secțiunea 4.6. |
| D11 | Cloudflare Pages: build-ul scrie `_headers`, `_redirects`, `_routes.json` (funcții doar pe `/api/*`) și `config.json` static (URL Supabase + cheia anon, verificată că e publică). `/api/finnhub` devine Pages Function care reutilizează gateway-ul, fără Finnhub în ordinea furnizorilor. | Static nelimitat; funcțiile rămân pentru acțiuni explicite ale utilizatorului. |
| D12 | **[decizia mea]** Adaptorul Yahoo din ingestie folosește `yahoo-finance2` (versiune fixată) pentru batch nativ de cotații. | Cerință explicită; un request pentru toate simbolurile. |

## Constrângeri
- Node ≥ 20 (local 22), ESM, `node --test`. Stil: comentarii în engleză, cum e codul existent.
- Fără chei în browser; `SUPABASE_SERVICE_ROLE_KEY` doar în secretele GitHub Actions/Supabase.
- Testele scrise înainte de cod pentru ingestie, adaptoare și calcule.
- SQL-ul nou se testează cu PGlite (Postgres în WASM), inclusiv politicile RLS.

## Pași manuali (doar proprietarul)
1. Secrete GitHub: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SCAN_URL`, `SCAN_SECRET`.
2. Rularea `supabase/market-data.sql` în SQL Editor; redeploy `scan`; oprirea cron-ului
   `market-pulse-scan` (după ce ingestia rulează verificat).
3. Proiect Cloudflare Pages conectat la repo (preview pe branch), variabilele `SUPABASE_URL`,
   `SUPABASE_ANON_KEY`, `VAPID_PUBLIC_KEY`.
4. După verificare: oprirea site-ului Netlify.

## Rollback
Fiecare piesă e reversibilă independent: flag `dataSource: "gateway"` readuce clientul pe
`/api/finnhub`; cron-ul `market-pulse-scan` se reactivează cu SQL-ul din `push.sql`; Netlify
rămâne neatins până la decizia finală; workflow-urile se dezactivează din tab-ul Actions.

## Lăsat la latitudinea implementării
Numele exacte de fișiere/funcții (fixate în plan), formatul mesajelor de issue, pragurile exacte
de buget (pornite conservator, documentate în `config/budgets.json`).
