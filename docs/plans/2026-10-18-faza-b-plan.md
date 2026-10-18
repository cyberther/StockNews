# Faza B – plan de implementare

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (Native, ca în Faza A). Progres:
> `docs/plans/2026-10-18-faza-b-ledger.md`.

**Goal:** evenimente politice/legislative din surse oficiale RO, clasificate determinist, în Supabase și
într-un ecran „Politici” cu „Te afectează?”.

**Architecture:** parsere pe sursă în `ingest/policy/`, clasificator pur + taxonomie JSON, runner apelat de
jobul `eod` (și `--job=policy`), tabele `policy_events` + istoric; client `templates/shared/hif-policy.js`
(încărcare + logica „te afectează”), ecran nou în `StockNewsWeb.dc.html`.

**Tech Stack:** Node 22 ESM, `node --test`, PGlite, PostgREST, GitHub Actions. **Spec:** `docs/plans/2026-10-18-faza-b-design.md`

## Global Constraints
- Statut doar din forma sursei (tabelul din design); niciodată din cuvintele titlului.
- Id-uri stabile: `cdep:<idp>`, `mf:<content id>`; text păstrat: titlu ≤ 500, rezumat ≤ 600 caractere.
- Clasificare fără AI; fiecare companie legată are `why` (`mentioned` | `sector`).
- Fără nume de partide/adjective evaluative în textele UI; badge-ul de statut e text fix pe statut.
- Fetch-uri: user-agent identificabil, timeout 20 s, max 2 MB, fără retry în același run.

## Review Focus
1. Titlu care conține „lege”/„adoptat” dar vine dintr-un comunicat MF → rămâne `statement`. (Task 2)
2. Rând Camera cu stadiu necunoscut/nou (ex. „la promulgare”) → `draft`, stadiul brut păstrat. (Task 2)
3. Același proiect apare și în lista de inițiative, și în cea de legi → un singur eveniment, `adopted`,
   cu istoric `draft → adopted`. (Task 4)
4. HTML schimbat (0 rânduri parsate) → run-ul raportează eroare de sursă, nu șterge nimic. (Task 4)
5. Utilizator fără Following/Portfolio → „Doar ce mă afectează” arată o stare goală explicită. (Task 5)

---

### Task 1: Schema `policy_events` + istoric
**Files:** `supabase/policy.sql`, `test/policy-sql.test.js` (PGlite, stub ca în `market-data-sql.test.js`).
- [ ] Teste: aprobat citește; anon și neaprobat nu; doar service scrie; `status`/`certainty` în listele permise;
  `policy_event_history` invizibil din browser; script re-rulabil. FAIL → SQL → PASS → commit.

### Task 2: Parsere surse
**Files:** `ingest/policy/cdep.mjs`, `ingest/policy/mf.mjs`, fixture-uri trunchiate în `test/fixtures/policy/`,
`test/policy-sources.test.js`.
**Interfaces:** `parseCdepList(html, { kind: 'initiatives'|'laws', year }) -> Item[]`,
`parseMfRss(xml) -> Item[]`; `Item = { id, title, event_date, institution, initiator, doc_number, source_url,
status, stage, certainty, summary? }`.
- [ ] Teste: PL-x → Guvern, Pl-x → Parlamentari; „la Senat …” → draft; „procedura legislativa încetata” → stopped;
  „Lege 2/2026 05.01.2026” → adopted + `doc_number` „Lege 2/2026” + data 2026-01-05; link absolut cdep;
  MF: statement, `official_statement`, id din `/content/id/NNN`, titlu cu „lege” rămâne statement.

### Task 3: Clasificator
**Files:** `config/policy-taxonomy.json`, `ingest/policy/classify.mjs`, `test/policy-classify.test.js`.
**Interfaces:** `classify(text, taxonomy, catalog) -> { sectors, caen, companies:[{ticker,why,sector?}], figures }`.
- [ ] Teste: „acciza la motorină” → petrol-gaze + fiscal-general; SNP.RO prin sector; „Hidroelectrica” în text →
  H2O.RO `mentioned`; „deficit de 3,82% din PIB” → figure percent 3.82 unit „% din PIB”; „1,2 mld. lei” → amount
  1.2e9 RON; text fără reguli → sectoare goale; diacritice/fără diacritice la fel.

### Task 4: Runner + integrare în ingestie
**Files:** `ingest/policy/run.mjs`, modific `ingest/main.mjs` (`--job=policy`; `eod` rulează și politicile),
`config/budgets.json` (`policy` perRun 10), `test/policy-run.test.js`.
**Interfaces:** `runPolicy({ db, fetchText, now, taxonomy, catalog }) -> { events, changed, errors }`.
- [ ] Teste: upsert evenimente; istoric scris doar la schimbare de status/stadiu; promulgata + inițiativa același idp →
  un eveniment `adopted`; sursă cu 0 rânduri → eroare, fără ștergeri; `ingest_runs` primește rândul jobului `policy`.

### Task 5: Client + ecran „Politici”
**Files:** `templates/shared/hif-policy.js`, `test/policy-client.test.js`, modific `StockNewsWeb.dc.html`,
`hif-data.js` (texte EN/RO/DE), `config/flags.json` + `hif-flags.js` (`policy: true`).
**Interfaces:** `HIFPolicy.load({ sector, ticker }) -> Event[]` (un request PostgREST),
`HIFPolicy.affects(event, follows, positions) -> [{ticker, why, via:'following'|'portfolio'}]`,
`HIFPolicy.statusLabel(status, copy)`.
- [ ] Teste: affects intersectează corect și raportează motivul; statusLabel fix pe statut; load construiește filtrele
  PostgREST (`sectors=cs.{x}`, `companies=cs.[{"ticker":"…"}]`).
- [ ] UI în browser (desktop + 390 px): listă, filtre, badge, „Te afectează”, stare goală. Fără erori în consolă.

### Task 6: PR #82 continuat
**Files:** `templates/shared/hif-scenario.js`, `test/scenario.test.js`, `templates/stock-news-web/intelligence.html`
(din branch-ul PR #82, folosește modulul), link din ecranul „Politici”.
- [ ] Teste: exemplul din PR (1000 × 40% × −5% × 0,8 = −16; × 30% = −4,8; 150 → 145,2); validare intervale;
  marjă de bază 0 → procent null.

### Task 7: Documentare, verificare, livrare
**Files:** `docs/policy-sources.md`, `.github/workflows/ingest.yml` (fără schimbare de cron: `eod` include politicile).
- [ ] `npm test`, `npm run check`, dry-run real al politicilor, SQL rulat în Supabase, `staging` actualizat,
  verificare pe `staging.aa-market-pulse.pages.dev`, /security-review, PR (fără merge în producție).
