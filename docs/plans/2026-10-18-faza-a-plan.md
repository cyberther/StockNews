# Faza A – plan de implementare

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (ales: Native — proprietarul a cerut
> pornirea directă). Pașii folosesc `- [ ]`. Progresul: `docs/plans/2026-10-18-faza-a-ledger.md`.

**Goal:** datele de piață aduse centralizat (GitHub Actions → Supabase), citite de client din Supabase cu smart
refresh, în spatele feature flag-urilor, cu frontend gata de Cloudflare Pages.

**Architecture:** module pure partajate browser/Node (`hif-flags`, `hif-markets`, `hif-refresh`) în
`templates/shared/`; ingestia în `ingest/` (Node ESM, rulată de Actions); SQL nou în `supabase/market-data.sql`;
Pages Function în `functions/api/finnhub.js` care reutilizează gateway-ul existent.

**Tech Stack:** Node 22 / ESM, `node --test`, PGlite (teste SQL/RLS), `yahoo-finance2@4.0.3` (fixat), GitHub
Actions, Supabase PostgREST, Cloudflare Pages.

**Spec:** `docs/plans/2026-10-18-faza-a-design.md`

## Global Constraints
- Fișierele din `templates/shared/` sunt scripturi clasice (IIFE) care se atașează la `window`/`globalThis`; testele
  Node le încarcă prin `import` pentru efect și citesc `globalThis.X`.
- Flags implicite: `following: true, bvb: true, portfolio: true, usMarket: false, euMarket: false,
  universeScan: false, prefetchUnfollowedNews: false, hiddenModuleRefresh: false, commercialMode: false,
  dataSource: "supabase"`.
- Licențe: `dev_only | commercial_display | redistribution`; yahoo = `dev_only`.
- Cron ingestie: `7,22,37,52 7-21 * * 1-5` (UTC) + EOD `40 21 * * 1-5`; gating fin în cod pe `hif-markets`.
- Smart refresh: interacțiune ≤ 15 min, interval minim 5 min, „live” doar dacă `fetched_at` ≤ 20 min și bursa e deschisă.
- Breaker: 3 eșecuri consecutive → deschis 30 min. Recomandări: cache 24 h, inclusiv negativ, doar US.
- Fără chei în browser; service role doar în secrete Actions. Repo public: nu se loghează secrete/URL-uri cu chei.

## Review Focus
1. Weekend / după închidere / DST (ultima duminică din martie/octombrie): job-ul nu aduce nimic, clientul nu face polling,
   datele apar cu ora lor. → teste în Task 2 și 3.
2. Ticker cu sufix necunoscut sau invalid (`FOO.XX`, `brk.b`, `'; drop`) în watchlist: ignorat la ingestie, nu
   strică batch-ul. → test în Task 6.
3. Furnizor căzut (timeout, 429, HTML în loc de JSON): breaker deschis, rularea se termină cu succes parțial,
   nu reîncearcă în buclă. → test în Task 5.
4. Utilizator nelogat / neaprobat citind `market_quotes` cu date `dev_only`: zero rânduri. → test în Task 4.
5. Panou de browser vizibil fără interacțiune ore întregi: zero refresh-uri după 15 min. → test în Task 3.

---

### Task 1: Feature flags
**Files:** create `config/flags.json`, `templates/shared/hif-flags.js`, `test/flags.test.js`; modify
`templates/stock-news-web/StockNewsWeb.dc.html` (încărcare script + tab-urile US/EU ascunse și fără sync când flag off),
`netlify/functions/_shared/market/gateway.js` (rutele `/us-news`, `/eu-news` → 404 `{error:'feature on hold'}` când off),
`supabase/functions/scan/index.ts` (`MARKET_TOP` doar dacă env `FLAG_US_MARKET=true`).
**Interfaces:** Produces `globalThis.HIFFlags = { get(name): any, all(): object }`, `config/flags.json`.
- [ ] Test: `hif-flags defaults match config/flags.json`; `unknown flag returns undefined`;
      `gateway refuses /us-news when usMarket is off` (status 404, body.error === 'feature on hold').
- [ ] Rulează → FAIL. Implementează. Rulează → PASS. Commit.

### Task 2: Programul burselor
**Files:** create `templates/shared/hif-markets.js`, `test/markets.test.js`.
**Interfaces:** Produces `HIFMarkets.marketOf(symbol) -> 'BVB'|'XETRA'|'LSE'|'US'|null`,
`HIFMarkets.isOpen(market, date) -> boolean`, `HIFMarkets.anyOpen(symbols, date) -> boolean`,
`HIFMarkets.lastClose(market, date) -> Date`.
- [ ] Teste: `SNP.RO open Tue 2026-10-20 11:00 Bucharest`, `closed Sat`, `US open 2026-11-03 14:31Z (after DST end)`,
      `US closed 2026-10-20 13:00Z`, `XETRA 2026-03-30 07:05Z open (CEST)`, `lastClose(US, Monday 08:00Z) is Friday 16:00 NY`,
      `marketOf('brk.b') === 'US'`, `marketOf('FOO.XX') === null`.
- [ ] FAIL → implement (Intl.DateTimeFormat cu timeZone) → PASS → commit.

### Task 3: Smart refresh + prospețimea datelor
**Files:** create `templates/shared/hif-refresh.js`, `test/refresh.test.js`; modify `StockNewsWeb.dc.html`
(`startAutoRefresh` folosește `HIFRefresh.shouldRefresh`; activitate utilizator înregistrată pe
pointerdown/keydown/scroll/visibilitychange; tick verificat la 60 s; eticheta de stare folosește `freshness`).
**Interfaces:** Produces `HIFRefresh.shouldRefresh({ hidden, lastActivity, lastRefresh, now, symbols }) -> boolean`,
`HIFRefresh.freshness(fetchedAtMs, symbols, now) -> 'live'|'delayed'|'closed'`, constants `IDLE_MS=900000`,
`MIN_INTERVAL_MS=300000`, `LIVE_MAX_AGE_MS=1200000`.
- [ ] Teste: hidden → false; idle 16 min → false; market closed and lastRefresh after lastClose → false;
      market closed but lastRefresh before lastClose → true (o dată); open, 6 min since refresh → true; 4 min → false;
      freshness 25 min old while open → 'delayed'; closed market → 'closed'.
- [ ] FAIL → implement → PASS; wire în app; commit.

### Task 4: Schema Supabase pentru date de piață
**Files:** create `supabase/market-data.sql`, `test/market-data-sql.test.js` (PGlite, cu stub-uri `auth.uid()`,
`public.is_approved()`, rolurile `anon`/`authenticated`); devDependency `@electric-sql/pglite`.
Tabele: `market_quotes(symbol pk, price, change, change_pct, prev_close, currency, market_time, fetched_at, source, license)`,
`market_recommendations(symbol pk, status 'ok'|'none', buy, hold, sell, period, fetched_at, source, license)`,
`ingest_runs(id, job, started_at, finished_at, ok, symbols, requests jsonb, errors text)`,
`ingest_provider_state(provider pk, fails, open_until, reason)`, `ingest_usage(day, provider, job, calls; pk(day,provider,job))`;
`stories.alerted_at timestamptz`.
- [ ] Teste: `anon sees licensed rows but not dev_only`; `approved user sees dev_only`; `authenticated non-approved sees
      no dev_only`; `nobody but service writes market_quotes`; `ingest_* not readable by anon`; script idempotent (rulat de 2 ori).
- [ ] FAIL → SQL → PASS → commit.

### Task 5: Strat de furnizori, breaker, buget
**Files:** create `ingest/providers/index.mjs` (registry + `LICENSES`), `ingest/providers/yahoo.mjs`,
`ingest/providers/stubs.mjs` (eodhd, twelvedata, bvb – `configured:false`), `ingest/breaker.mjs`, `ingest/budget.mjs`,
`config/budgets.json`, `test/ingest-providers.test.js`, `test/ingest-breaker.test.js`; dependency `yahoo-finance2@4.0.3`.
**Interfaces:**
`Provider = { name, license, configured, quotes(symbols) -> Promise<Quote[]>, recommendation(symbol) -> Promise<Rec|null> }`,
`Quote = { symbol, price, change, change_pct, prev_close, currency, market_time(ISO), source, license }`;
`providersFor(capability, { commercialMode }) -> Provider[]` (în commercial mode exclude `dev_only`);
`createBreaker(stateRows, now) -> { allowed(name), success(name), failure(name, reason), changes() }`;
`createBudget(limits, usageRows) -> { take(provider, job, n) -> boolean, over() -> string[], usage() }`.
- [ ] Teste: yahoo maps batch result (incl. GBp pence kept, `.RO` currency RON); yahoo adapter does ONE upstream call for 30
      symbols (chunk 50); `commercialMode excludes dev_only`; stubs throw `NotConfigured`; breaker opens after 3, closes
      after 30 min; budget refuses beyond daily limit and reports `over()`.
- [ ] FAIL → implement → PASS → commit.

### Task 6: Runner de ingestie
**Files:** create `ingest/universe.mjs`, `ingest/supabase.mjs` (client REST minimal: select/upsert/insert cu service key),
`ingest/run.mjs` (CLI: `node ingest/run.mjs --job=intraday|eod`), `ingest/news.mjs` (reutilizează feed-urile din
`netlify/functions/_shared/market/{ro-news,us-news,eu-news}.js`), `test/ingest-run.test.js`.
**Interfaces:** `buildUniverse({ watchlist, holdings, bvbTop, flags }) -> string[]` (sortat, unic, validat cu
`/^[A-Z0-9][A-Z0-9.\-]{0,11}$/`); `runIngest({ job, now, db, providers, fetchFeeds, flags, budgets, notify }) -> RunSummary`.
- [ ] Teste: universul deduplicat și filtrat; `intraday when all markets closed does no provider call`; numai simbolurile
      pieței deschise sunt cerute; quotes upsert + `ingest_runs` insert; știri filtrate pe tickerele urmărite, fără feed-urile
      de tab când flag-urile sunt off; EOD cere recs doar US și scrie `status:'none'` la lipsă; recs proaspete (<24 h) nu se
      re-cer; furnizor eșuat → summary.ok parțial, breaker scris; apel `scan?mode=alerts` după stories noi.
- [ ] FAIL → implement → PASS → commit.

### Task 7: `scan` în modul alerts
**Files:** modify `supabase/functions/scan/index.ts`: dacă `new URL(req.url).searchParams.get('mode') === 'alerts'` sau
env `SCAN_FETCH=off` → nu aduce știri; `fresh` = `stories` cu `alerted_at is null` și `found_at > now()-1h`; după trimitere
setează `alerted_at`. Logica de push extrasă neschimbată.
- [ ] Verificare: `deno check` indisponibil local → test static (`test/scan-alerts.test.js` verifică prin text că modul alerts
      nu apelează `companyNews`/`pressMarketNews`) + verificare manuală după deploy (pas în ghid).
- [ ] Commit.

### Task 8: Clientul citește din Supabase
**Files:** modify `templates/shared/hif-live.js`: când `HIFFlags.get('dataSource') === 'supabase'` și `HIFAuth.rest`
există: `quotes()` → un request `market_quotes?symbol=in.(...)`; `newsBatch(symbols)` → un request `stories?ticker=in.(...)`;
`roNews()` → `stories?ticker=like.*.RO`; `recommendation()` → `market_recommendations`; `load()` folosește batch-urile
(3 requesturi indiferent de N). Fără fallback la gateway în modul supabase. Recomandări: niciodată pentru non-US; în modul
gateway, eșecul e reținut 24 h. Quote primește `asOf` (ms). Test: `test/live-supabase.test.js` (jsdom-free: stub `window`,
`fetch`, `HIFAuth`).
- [ ] Teste: `load(10 symbols) makes 3 requests`; `BMW.DE recommendation makes no request`; `gateway mode caches failed
      recommendation 24h`; quote shape păstrată (`price`, `move`, `up`, `last`, `dp`) + `asOf`.
- [ ] FAIL → implement → PASS → commit.

### Task 9: GitHub Actions
**Files:** create `.github/workflows/ingest.yml` (intraday + eod, `concurrency: ingest`, `timeout-minutes: 8`,
`permissions: contents: read, issues: write`), `.github/workflows/health.yml` (zilnic 06:15 UTC: rulări ratate, ping Supabase,
issue la problemă), `.github/workflows/keepalive.yml` (lunar: `gh workflow enable` pentru ingest/health, `actions: write`),
`ingest/health.mjs`, `ingest/notify.mjs` (issue deduplicat după titlu prin `gh`), `test/ingest-health.test.js`.
- [ ] Teste: `expectedRuns(day)` numără sloturile cu bursă deschisă; `missed when < 70% of expected`; notify reuses open issue.
- [ ] `actionlint` indisponibil → validare YAML cu parser + revizuire. Commit.

### Task 10: Cloudflare Pages
**Files:** modify `scripts/build-netlify.mjs` → extras `scripts/build.mjs` (comun) care scrie și `_redirects`,
`_routes.json` (`include: ["/api/*"]`), `config.json` (doar cheie publică, aceeași regulă ca `config.js`); create
`functions/api/finnhub.js` (Pages Function: `onRequestGet` → `handleMarketRequest` cu ordinea fără Finnhub, try/catch →
503 JSON, nimic din pagină nu depinde de ea), `wrangler.toml` (`pages_build_output_dir="dist"`, `nodejs_compat`);
modify `templates/shared/hif-auth.js` (citește `/config.json`, apoi `/api/config`); `test/build-pages.test.js`.
- [ ] Teste: build scrie cele 4 fișiere; `config.json` omite o cheie service_role; `_routes.json` exclude statice;
      funcția răspunde 503 JSON când gateway-ul aruncă.
- [ ] FAIL → implement → PASS → commit.

### Task 11: Documente, măsurare, verificare
**Files:** create `docs/architecture-comparison.md`, `docs/phase-a-setup.md` (pași manuali + rollback),
`scripts/measure-usage.mjs` (din `ingest_runs`: cereri externe/zi, erori; din fișierul de baseline: comparație).
- [ ] Verificare reală în browser: app local (desktop + 375 px), Following/BVB/Portfolio, număr de requesturi într-o
      fereastră de 20 min cu panoul deschis și fără interacțiune (așteptat 0 după 15 min).
- [ ] Suita completă `npm test`, `npm run check`. /security-review. Push branch, PR (fără merge).
