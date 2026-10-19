# Faza C – plan de implementare

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (Native, ca în Fazele A și B).
> Progres: `docs/plans/2026-10-18-faza-c-ledger.md`. Steps use checkbox (`- [ ]`) syntax.

**Goal:** analize de impact economic versionate și verificabile, legate de evenimentele de politici, de companiile
BVB și de Following/Portofoliu. Includ calculator, căutare, alerte și un graf de cunoștințe; totul e determinist.

**Architecture:**
- Motorul de calcul e un modul pur comun browser/Node (`hif-impact.js`, peste `hif-scenario.js`).
- Analizele și datele financiare sunt JSON în repo, validate și sincronizate de jobul `impact`. Ele ajung în
  tabele Supabase imuabile, cu rezultatele înghețate.
- Graful și acuratețea sunt view-uri SQL.
- Alertele se calculează în SQL și le trimite Edge Function `scan`.
- UI-ul stă în ecranul Politici, sub flag-ul `impact`.
- LM Studio e un job batch opțional pe PC.

**Tech Stack:** Node 22 ESM, `node --test`, PGlite 0.5.8, PostgREST, Supabase Edge (Deno), GitHub Actions, Playwright.

**Spec:** `docs/plans/2026-10-18-faza-c-design.md`

## Global Constraints
- **Formule și numere**
  - Toate formulele vin din design („Modelul de calcul”), exact.
  - Procentele se introduc 0–100; rotunjirea se face la 1e-10; minusul se afișează „−” (ca `HIFScenario.fmt`).
  - Fiecare număr afișat e `fact` (are `source_url` https), `assumption` (are `why` + `range` și valoarea în interval)
    sau `result` (are `formula`).
- **Imuabilitate**
  - Analizele publicate sunt imuabile: `analyses/LOCK.json` păstrează sha256 pentru fiecare `vN.json`.
  - Trigger SQL `impact_analyses_immutable` refuză UPDATE/DELETE (excepție: doar coloana `alerted_at`).
  - `ENGINE_VERSION = '1.0.0'`, exportat de `hif-impact.js` și salvat cu fiecare rezultat.
- **Texte și limbaj**
  - Fără limbaj de recomandare sau de preț. Disclaimerul e fix (cheia `impDisclaimer` RO/EN/DE):
    RO: „Nu este o recomandare de investiții. Modelul estimează efectul contabil direct asupra bugetului și a
    profitului operațional, nu prețul acțiunilor.”
- **Date și chei**
  - Datele financiare implicite în calculator: doar `verified = true`.
  - Fără chei în browser; repo-ul e public.
- **Livrare**
  - Doar staging; fără deploy de producție; fără merge fără acord.

## Review Focus
1. Analiză cu ipoteză în afara intervalului sau ticker inexistent → sincronizarea respinge fișierul cu un mesaj
   care numește cheia. Celelalte analize se sincronizează. (Task 2)
2. Modificarea unui `v1.json` deja publicat → testul LOCK pică. În Supabase, același id/versiune cu alt hash →
   eroare raportată, fără suprascriere. (Task 2, 4)
3. Baza de profit operațional 0 sau negativă → procentul e `null`, respectiv calculat față de |bază|; UI-ul arată „n/a”,
   nu „Infinity” sau „NaN”. (Task 1, 7)
4. Primul run după migrare: cele 1.483 de evenimente existente nu trimit nicio alertă. (Task 3, 5)
5. Utilizator cu poziții dar fără cotații încărcate → cardul de portofoliu spune „cotații indisponibile”, nu
   „0%”. (Task 1, 7)

---

### Task 1: Motorul de calcul `hif-impact.js`
**Files:** create `templates/shared/hif-impact.js`, `test/impact-engine.test.js`.
**Interfaces:**
- Consumes: `HIFScenario.compute({revenue, margin, exposure, shock, mitigation, contribution})` (existent).
- Produces: `globalThis.HIFImpact`, cu următoarele funcții:
  - `ENGINE_VERSION`, `SCENARIOS` (= `['full','partial','delayed']`);
  - `monthsInForce(startISO, delayMonths, year) -> number` (0–12);
  - `budget({cost, funded_pct, gdp, start, impl_pct, delay_months}) -> {net, pctGdp, byYear:{[Y]:n, [Y+1]:n}, formula}`;
  - `company({revenue, operating_profit, exposure, shock, mitigation, contribution}, {impl_pct, start, delay_months}) -> {revenueDelta, profitDelta, pctOfProfit|null, byYear, formula}`;
  - `scenarioParams(analysis, scenario) -> {impl_pct, delay_months, start}`;
  - `run(analysis, financials) -> {engine, budget:{full,partial,delayed}, companies:{[ticker]:{full,partial,delayed}|{missing:'financials'}}}`;
  - `portfolio(results, positions:{[ticker]:{value}}, scenario) -> {weighted|null, parts:[{ticker,weight,pct}], formula, reason?}`;
  - `accuracy(estimated, observed) -> {error, relError|null, direction:boolean}`.
- [ ] **Teste (fail → implementare → pass):**
  - `monthsInForce('2026-08-01',0,2026)===5`; `monthsInForce('2026-08-01',6,2026)===0`;
    `monthsInForce('2026-08-01',6,2027)===10`; `monthsInForce('2025-01-01',0,2026)===12`.
  - `budget({cost:1.2e10, funded_pct:25, gdp:2e12, start:'2026-01-01', impl_pct:100, delay_months:0})` → `net === -9e9`,
    `pctGdp === -0.45`, `byYear[2026] === -9e9`; un cost negativ (venit) dă `net` pozitiv.
  - Exemplul existent din `scenario.test.js` (1000 venit, 40% expunere, −5% șoc, 20% atenuare, 30% contribuție →
    −4,8), cu `impl_pct 50` și start 1 iulie → `byYear[Y] === -1.2`.
  - Pentru profitul operațional de bază: valoarea 0 dă `pctOfProfit === null`; −100 calculează față de 100.
  - `run` pe o analiză fixture (`test/fixtures/impact/sample-v1.json`) dă 3 scenarii pentru buget și pentru
    fiecare companie. O companie fără date financiare dă `{missing:'financials'}`.
  - `portfolio` cu ponderile 60/40 și procentele −10/5 dă `weighted === -4`. Fără poziții valorificate dă
    `weighted === null` și `reason:'no_values'`.
  - `accuracy(-10, -8)` → `{error:2, relError:0.2, direction:true}`; `accuracy(0,1).relError === null`.
  - Fiecare rezultat are `formula` care conține cifrele de intrare.
- [ ] Commit: `Impact engine: budget, company, scenario, portfolio and accuracy formulas`.

### Task 2: Formatul analizelor + validator + LOCK
**Files:**
- create `ingest/impact/schema.mjs`, `analyses/README.md`, `analyses/LOCK.json`, `config/company-financials.json`
  (inițial `[]`);
- create `test/impact-schema.test.js`, `test/fixtures/impact/sample-v1.json`, `test/fixtures/impact/bad-*.json`.

**Interfaces:**
- Consumes: `config/policy-taxonomy.json`, `bvbCatalog()` din `ingest/policy/classify.mjs`.
- Produces:
  - `validateAnalysis(json, {taxonomy, tickers:Set}) -> {ok:true}|{ok:false, errors:string[]}`;
  - `validateFinancials(rows, {tickers}) -> {ok, errors}`;
  - `loadAnalyses(dir='analyses') -> [{path, json, hash}]` (sha256 al conținutului brut);
  - `checkLock(list, lock) -> string[]` (lista de abateri);
  - `resolve(analysis, ref) -> number`, unde ref e `{ref:'key'}`, spre o ipoteză sau un fapt.

- [ ] **Teste:**
  - fixture-ul valid trece;
  - fiecare `bad-*` pică cu o eroare care numește cheia:
    - `source_url` http;
    - ipoteză fără `why` / fără `range` / în afara intervalului;
    - ticker necunoscut, sector necunoscut;
    - număr literal în `companies[].shock_pct` (nu ref);
    - `version` diferit de numele fișierului;
    - `id` cu caractere în afara `[a-z0-9-]`;
  - `checkLock`: hash schimbat → abatere; fișier nou nelistat → abatere, cu mesajul „run npm run impact:lock”;
  - testul de repo: toate fișierele reale din `analyses/` sunt valide și `checkLock(...)` e gol.
- [ ] Script `npm run impact:lock` (`node ingest/impact/schema.mjs --lock`): adaugă doar intrări noi și refuză să
  schimbe una existentă.
- [ ] Commit.

### Task 3: SQL `supabase/impact.sql`
**Files:** create `supabase/impact.sql`, `test/impact-sql.test.js` (folosește `test/helpers/supabase-pg.js` și
încarcă înainte `approval.sql`, `push.sql`, `holdings.sql`, `policy.sql`).

**Interfaces:**
- Tabele, view-uri și coloane: exact cele din design („Date”).
- Funcții:
  - `policy_alerts_due(p_since timestamptz) returns table(user_id uuid, items jsonb)`, doar service_role;
  - `policy_alerts_mark(p_event_ids text[], p_history_ids bigint[], p_analyses jsonb)`, doar service_role;
  - `ai_annotations_save(p_secret text, p_rows jsonb) returns integer`, cu `summary_secret_ok`;
  - `admin_ai_pending() returns setof ai_annotations` (is_admin);
  - `admin_ai_review(p_id bigint, p_decision text) returns integer` (is_admin; `verified|rejected`).

- [ ] **Teste RLS:**
  - aprobatul citește analize, rezultate, outcomes și financials doar `verified`; anon și neaprobatul nu citesc nimic;
  - adminul vede financials neverificate;
  - browserul (authenticated) nu poate scrie în nicio tabelă nouă.
- [ ] **Teste de imuabilitate:**
  - UPDATE pe `impact_analyses.title`, ca service_role, eșuează;
  - UPDATE pe `alerted_at` merge; DELETE eșuează.
- [ ] **Teste de alerte:**
  - backfill: după rularea scriptului, toate rândurile existente din `policy_events` / `policy_event_history` au
    `alerted_at`;
  - un eveniment nou cu `mentioned` M.RO, la un user cu M.RO în watchlist (push = true) și un dispozitiv cu
    `policy_alerts`, apare în `policy_alerts_due`;
  - același eveniment prin `sector` cu status `draft` nu apare; cu `adopted` apare;
  - tickerul din holdings (fără watchlist) apare;
  - dispozitivul cu `policy_alerts = false` exclude userul;
  - o analiză nouă (cu `alerted_at` null) care include M.RO apare la același user;
  - un singur rând per user, cu items agregate.
- [ ] **Teste AI:**
  - `ai_annotations_save` refuză un secret greșit;
  - aprobatul vede doar `verified`;
  - `admin_ai_review` refuză un non-admin.
- [ ] **Teste de view-uri:**
  - `knowledge_edges` conține `event→sector`, `event→company`, `analysis→event`, `scenario→company`,
    `company→instrument`, `outcome→scenario` pentru fixture;
  - `analysis_accuracy` calculează eroarea ca `HIFImpact.accuracy`.
- [ ] Scriptul se poate rula de două ori. Commit.

### Task 4: Jobul `impact` (sincronizare)
**Files:**
- create `ingest/impact/run.mjs`, `test/impact-run.test.js`;
- modify `ingest/main.mjs` (`--job=impact`; `eod` rulează `runPolicy` apoi `runImpact`), `.github/workflows/ingest.yml`
  (opțiunea `impact` în dispatch), `package.json` (`impact:lock`).

**Interfaces:**
- Consumes: Task 1 `run`, Task 2 `loadAnalyses`, `validateAnalysis`, `validateFinancials`; `db` din `ingest/supabase.mjs`.
- Produces: `runImpact({db, dir, financials, taxonomy, tickers, now}) -> {analyses, inserted, results, outcomes, errors}`.

Ce face:
- inserează financials (upsert pe ticker+an, `provenance: 'manual'`, `verified: true`);
- inserează analizele noi (id+versiune absente), apoi rezultatele lor înghețate cu `ENGINE_VERSION`;
- o analiză existentă cu alt `content_hash` produce eroarea „analysis X vN changed after publishing” și nu e scrisă;
- evenimentele din `events` care lipsesc din `policy_events` produc o eroare, iar analiza nu e scrisă;
- `ingest_runs` primește un rând `job: 'impact'`.

- [ ] **Teste** (db fals, ca în `policy-run.test.js`):
  - insert nou;
  - al doilea run nu scrie nimic;
  - hash schimbat → eroare, zero scrieri;
  - fișier invalid → eroare numită, celelalte merg;
  - rezultatele au `engine_version`;
  - outcomes din `analyses/<id>/outcomes.json` se scriu.
- [ ] Dry-run real: `node ingest/main.mjs --job=impact --dry-run`.
- [ ] Commit.

### Task 5: Alerte de politici în Edge Function `scan`
**Files:**
- modify `supabase/functions/scan/index.ts` (în modul alerts, după știri): apelează `policy_alerts_due`, trimite un push
  pe user (titlu „Politici: N noutăți pentru companiile tale”, corp cu primele 2 titluri, URL `APP_URL#policy`), apoi
  `policy_alerts_mark`; sub `FLAG_POLICY_ALERTS`;
- modify `test/scan-alerts.test.js`, `config/flags.json`, `templates/shared/hif-flags.js` (`impact: true`,
  `policyAlerts: true`, `aiAnnotations: false`), `test/flags.test.js`.
- [ ] **Teste:**
  - sintaxa TS e validă;
  - ramura de politici apelează doar RPC-urile, fără `fetch(`;
  - e protejată de `flagOn('FLAG_POLICY_ALERTS')`;
  - marcarea se face și când nu există dispozitive.
- [ ] Commit. Deploy-ul funcției se face în Task 9.

### Task 6: Conținut real — date financiare și primele analize
**Files:** `config/company-financials.json`, `analyses/<id>/v1.json` (2 analize), `analyses/LOCK.json`.

**Date financiare.** Pentru fiecare companie BVB din analize: ultimul raport anual auditat, deschis efectiv.
Fiecare rând are:
- `fiscal_year`, `currency`;
- `revenue`, `operating_profit`, `net_profit` (lei);
- `geo_*_pct` doar dacă raportul le dă, altfel `null`;
- `source_url` (PDF-ul sau pagina raportului).

Ce nu se poate citi rămâne `null`; nu se estimează.

**Analize.** Se aleg 2 măsuri din `policy_events` cu efect fiscal clar, adopted sau statement MF cu cifre.
Faptele se citează din sursa evenimentului și din documentele oficiale legate. Necunoscutele devin ipoteze, cu
motiv și interval, sau `approved: "unknown"`.

- [ ] `npm test` (validatorul și LOCK pe fișierele reale), apoi `npm run impact:lock`, apoi commit.

### Task 7: Client + UI (Analize, Companii, calculator, căutare, portofoliu)
**Files:**
- create `templates/shared/hif-impact-client.js`, `test/impact-client.test.js`;
- modify `templates/shared/hif-policy.js` (`query` primește `q`, `status`, `hasAnalysis`), `test/policy-client.test.js`;
- modify `templates/stock-news-web/StockNewsWeb.dc.html`, `templates/shared/hif-data.js` (chei `imp*` RO/EN/DE),
  `templates/stock-news-web/intelligence.html` (calculatorul pe `HIFImpact`, parametri în hash), `scripts/build.mjs`
  (dacă modulele noi trebuie copiate).

**Interfaces:**
- `HIFImpactClient.analyses({ticker?, event?}) -> Promise<Analysis[]>` (un request);
- `HIFImpactClient.results(id, version) -> Promise<Row[]>`;
- `HIFImpactClient.exposure(ticker) -> Promise<{financials, counts, analyses}>`;
- `HIFImpactClient.encodeHash(params) -> string` / `decodeHash(str) -> params`, validate cu `HIFScenario.LIMITS`;
  valorile invalide se ignoră.

`hif-policy.query`:
- `q` → `title=ilike.*<q>*`, cu `*`, `,`, `(`, `)` eliminate și maximum 80 de caractere;
- `status` → `status=eq.x`, doar din lista permisă.

- [ ] **Teste:**
  - query-urile PostgREST exacte;
  - `q` cu caractere speciale e curățat;
  - `decodeHash` respinge valori în afara limitelor;
  - `encodeHash` urmat de `decodeHash` e identitate.
- [ ] **UI în Chromium** (desktop + 390 px, cont aprobat pe staging local):
  - tab-urile Evenimente / Analize / Companii;
  - căutarea;
  - analiza cu cele 4 secțiuni separate și cele 3 scenarii;
  - butonul „Modifică ipotezele” deschide calculatorul precompletat;
  - pagina companiei;
  - cardul din portofoliu, inclusiv „cotații indisponibile”;
  - disclaimerul;
  - comutatorul „Alerte politici” în setări (`push_subscriptions.policy_alerts`);
  - zero erori în consolă.
- [ ] Commit.

### Task 8: AI intern opțional (LM Studio) + review admin
**Files:**
- create `tools/policy-ai-batch.mjs`, `tools/systemd/market-pulse-policy-ai.{service,timer}`, `test/policy-ai-batch.test.js`;
- modify ecranul Admin din `StockNewsWeb.dc.html` (lista + Validează/Respinge, sub `aiAnnotations`).

**Interfaces:**
- `inWindow(now, 'HH-HH', tz='Europe/Bucharest') -> boolean`;
- `runPolicyAi({lm, rpc, now, maxMinutes, window}) -> {status:'done'|'postponed'|'outside_window', saved}`.

- [ ] **Teste:**
  - `inWindow` la 00:59 / 01:00 / 05:59 / 06:00 cu fereastra `01-06`, plus o fereastră peste miezul nopții `22-02`;
  - `lm` care aruncă eroare sau nu răspunde în 5 s → `postponed` și zero scrieri;
  - răspunsul modelului care nu respectă schema JSON → rândul e sărit;
  - limita de timp oprește bucla;
  - rândurile salvate au `status` implicit `unverified` (setat de SQL, nu de client).
- [ ] Commit. Timerul nu se instalează automat: e un pas manual în docs.

### Task 9: Documentare, verificare, livrare
**Files:** `docs/impact-model.md` (formule, proveniență, cum se adaugă o analiză și un rezultat observat, alerte,
AI), `docs/plans/2026-10-18-faza-c-ledger.md`.
- [ ] `npm test`, `npm run check`.
- [ ] `supabase/impact.sql` aplicat în Supabase. Verificare din afară: anon refuzat; după backfill,
  `policy_alerts_due(now()-'1 day')` e gol.
- [ ] `node ingest/main.mjs --job=impact` real, apoi verificat în tabele.
- [ ] Edge Function `scan` deployată. Un run `?mode=alerts` dă 0 erori.
- [ ] `staging` actualizat și verificat pe `staging.aa-market-pulse.pages.dev`.
- [ ] /security-review, cu problemele critice reparate.
- [ ] PR spre main, apoi oprire pentru acord.
