# Market Pulse (StockNews): context pentru proiectul Claude

Actualizat: 2026-10-19. Repo: https://github.com/cyberther/StockNews (public; nu pune niciodată chei aici).

## Ce este
Aplicație web (desktop + telefon, instalabilă ca PWA pe iPhone) cu știri și date de piață pentru acțiunile
urmărite și pentru portofoliu. Accent pe Bursa de Valori București (BVB). Limbi: română, engleză, germană.
Conturile se aprobă manual de administrator; adminul are 2FA.

## Ce face (funcții active)
- **Feed**: știri pe companii, în ordine cronologică, tab-uri Following și BVB.
- **Following / Watchlist**: tickerele urmărite, cu alerte push pentru știri noi.
- **Portfolio**: poziții cu profit/pierdere live, ponderi, grafic de valoare (USD / RON).
- **BVB**: catalog de companii BVB, cotații, rapoarte curente (tabelul `filings`, crawler pe PC).
- **Politici (Faza B)**: evenimente legislative și politice din surse oficiale RO:
  - surse: Camera Deputaților (inițiative și legi promulgate) și comunicatele Ministerului Finanțelor;
  - statutul vine doar din forma sursei, niciodată din cuvintele titlului:
    declarație / proiect / adoptată / în vigoare / implementată / oprită;
  - certitudinea: act oficial / procedură oficială / comunicat oficial;
  - clasificare deterministă pe 14 sectoare, coduri CAEN și companii BVB, fiecare legătură cu motivul ei
    („menționată” sau „prin sectorul X”);
  - cifre extrase (procente, % din PIB, sume);
  - filtre pe sector și companie; „Te afectează?” legat de Following și Portfolio;
  - în Supabase sunt circa 1.483 de evenimente.
- **Analize de impact (Faza C)**, în ecranul Politici (tab-urile Evenimente / Analize / Companii):
  - fiecare cifră e fapt (cu link oficial), ipoteză (cu motiv și interval) sau rezultat (cu formula);
  - buget aprobat, finanțare, efect asupra deficitului (% din PIB), scenarii integral / parțial / întârziat;
  - efectul asupra rezultatului din exploatare al companiilor și efectul ponderat pe pozițiile în lei;
  - analizele sunt JSON în `analyses/`, imuabile după publicare (`LOCK.json` + trigger SQL); prima:
    Legea 162/2026 (acciza la motorină, contribuția de solidaritate, OMV Petrom);
  - pagina companiei: cifre verificate din raportul anual, expunere fiscală ca numărători;
  - graf de cunoștințe și acuratețe (estimare înghețată vs. rezultat observat), ca view-uri SQL.
- **Calculator de scenarii** (`intelligence.html`): același motor (`hif-impact.js`), parametri editabili,
  formule afișate, link partajabil.
- **Alerte de politici**: cel mult un rezumat pe zi pentru companiile din Following (push) sau Portofoliu.
- **AI local opțional** (LM Studio, noaptea): adnotări „generat automat, neverificat”, validate de admin;
  flag-ul `aiAnnotations` e oprit.
- **Smart refresh**: datele se reîmprospătează doar dacă pagina e vizibilă, a fost folosită în ultimele
  15 minute și bursa relevantă e deschisă (minimum 5 minute între refresh-uri).

**Oprite prin feature flags** (codul rămâne): piața US, piața EU, scanarea universului, preîncărcarea
știrilor neurmărite, refresh-ul modulelor ascunse, modul comercial. Flag-urile sunt în `config/flags.json`.

## Arhitectura
```
GitHub Actions (ingest.yml: cron la :07 :22 :37 :52, 07–21 UTC, L–V, plus job EOD la 21:40 UTC)
  └─ ingest/ → furnizori (Yahoo = doar dev), circuit breaker, bugete, deduplicare
       ├─ Supabase: market_quotes, market_recommendations, stories, policy_events, ingest_runs
       └─ Edge Function `scan?mode=alerts` → notificări push
Supabase (Postgres + RLS + PostgREST + pg_cron + pg_net) ← browserul citește direct, cu cheia anon + login
Cloudflare Pages (proiect aa-market-pulse): frontend static + o funcție /api/* opțională
```
- Paginile camerei (cdep.ro) nu răspund de pe runner-ele GitHub. Le aduce Supabase prin pg_net,
  doar pentru URL-uri din allowlist și doar cu rolul service.
- Staging: https://staging.aa-market-pulse.pages.dev/
- Producția pe Cloudflare se publică manual, la cerere.
- Netlify e suspendat (credite epuizate), iar ramura `production` e înghețată până în noiembrie.
- Teste: `npm test` (Node 22, `node --test`), PGlite pentru SQL/RLS, Playwright pentru măsurători în browser.

## Fazele proiectului (MASTER PROMPT „Market Pulse 2.0”)
- **Faza A – făcută (PR #83–#87)**: audit; ingestie centralizată în loc de apeluri din fiecare browser;
  Supabase; Cloudflare Pages; feature flags; smart refresh; furnizori cu licență (`dev_only` /
  `commercial_display` / `redistribution`).
- **Faza B – făcută (PR #88, #89)**: Political Intelligence (ecranul Politici), taxonomia sectoarelor,
  relay-ul pg_net, termenii surselor (`docs/policy-sources.md`).
- **Faza C – făcută (PR #91)**: Economic Impact & Investment Engine: motorul de calcul, analize versionate
  și imuabile, expunerea companiilor, graful de cunoștințe, calculatorul, alertele de politici, AI local
  opțional (`docs/impact-model.md`).
- **Faza D – mai târziu**: pregătirea monetizării: entitlements în Supabase Auth, Lemon Squeezy/Paddle în
  modul test, poarta `COMMERCIAL_MODE`, flag-uri legale.

## Reguli de lucru (de respectat în orice conversație)
**Branch-uri și publicare**
- Fiecare fază are propriul branch și propriul PR.
- Fără merge în main și fără publicare în producție fără acordul proprietarului.
- Se lucrează și se verifică pe staging.

**Proces**
- Superpowers: brainstorm → plan în `docs/plans/` → execuție pe branch, cu TDD pentru ingestie,
  adaptoare, entitlements și calcule financiare.
- Nimic nu e declarat „făcut” fără verificare reală. Se separă ce funcționează de ce e demonstrativ.
- `/security-review` la finalul fiecărei faze; obligatoriu înainte de PR-uri care ating auth, plăți, RLS
  sau chei.
- Funcțiile puse pe pauză nu se șterg; se opresc prin feature flags.
- Rezumatele de fază explică „de ce”.

**AI și date**
- Fără asistent AI sau chat AI pentru utilizatori și fără modele AI externe.
- Fără predicții de preț și fără recomandări personalizate de tranzacționare.

**Securitate**
- Cheia service_role nu ajunge niciodată în browser, Netlify sau Cloudflare; doar în GitHub Secrets / Supabase.
- Fără proxy-uri terțe pentru Claude Code și fără certificate MITM.

## De făcut de proprietar
- Testarea Politici, Following, BVB și Portfolio pe staging (desktop + iPhone).
- În Supabase Auth, adăugarea Redirect URLs `https://aa-market-pulse.pages.dev/**` și
  `https://*.aa-market-pulse.pages.dev/**`, plus corectarea Site URL.
- Verificarea juridică a termenilor de reutilizare a surselor.
- După verificarea ingestiei din 2026-10-20: oprirea jobului vechi `market-pulse-scan` din pg_cron.
- Testarea Fazei C pe staging; sursa oficială pentru consumul de motorină (ipoteză nesursată în analiza v1).
- Opțional: prima rulare reală a AI-ului local, apoi pornirea flag-ului `aiAnnotations`.
