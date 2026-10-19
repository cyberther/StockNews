# Faza C – design: Economic Impact & Investment Engine

Data: 2026-10-18 · Branch: `phase-c/impact-engine` · Cerințe: MASTER PROMPT, secțiunea Faza C (+ 8–10).
Proprietarul a cerut ca întrebările să primească răspuns „în interesul investitorilor”. Tot ce e marcat
**[decizia mea]** e alegerea lui Claude, nu a proprietarului, și se poate schimba.

## De ce
În ecranul Politici (Faza B) investitorul vede *că* o lege sau o măsură fiscală atinge o companie pe
care o urmărește. Nu vede însă *cât*, *cât de sigur* și *când*. Faza C îi răspunde la cele trei
întrebări pe care și le pune în primele 30 de secunde:

1. **Mă atinge, și cât?** Efectul asupra profitului operațional al companiilor lui, ca procent, și efectul
   ponderat pe portofoliul lui.
2. **Cât de sigur e?** E aprobată sau doar declarată? Are buget și sursă de finanțare? Ce poate să o întârzie?
3. **Când?** De când produce efecte. Ce se întâmplă dacă se aplică doar parțial sau cu întârziere.

Toate răspunsurile vin din formule pe care le poate vedea și modifica, cu fapte citate din surse oficiale.
Ipotezele sunt marcate ca ipoteze. Nu dăm nicio predicție de preț și nicio recomandare.

## Ce ar dori investitorii (răspunsurile la întrebările brainstorming-ului)
| Întrebare | Răspuns **[decizia mea]** |
|---|---|
| Ce vrea să afle în primele 30 s? | Dacă îl atinge, mărimea (ca % din profitul operațional), statutul (aprobat/proiect) și momentul. Pe prima linie a cardului de analiză. |
| În ce are încredere? | Doar în fapte cu link spre sursa oficială. Ipotezele trebuie să aibă un motiv scris și un interval plauzibil. Rezultatele trebuie să aibă formula afișată. Nicio cifră fără proveniență. |
| Ce l-ar face să plece? | Notificări prea multe, cifre fabricate, un ton care pare recomandare („cumpără/vinde”), predicții de preț. |
| Ce vrea să compare? | Cele trei scenarii (integral / parțial / întârziat), una lângă alta, plus propriul scenariu, cu parametri editabili. |
| Cum știe dacă analizele merită ceva? | Un istoric de acuratețe: estimarea făcută atunci versus rezultatul observat ulterior în rapoartele companiei. Estimarea veche nu se modifică niciodată. |
| Ce notificări vrea? | Doar pentru companiile lui (Following ∪ Portfolio). Mențiunea directă contează mereu. Legătura prin sector contează doar când actul e adoptat. Cel mult un rezumat pe zi. |
| Portofoliu? | Un card „Expunere la politici”: pentru fiecare analiză activă, efectul ponderat cu greutatea pozițiilor lui. |

## Obiective
1. **Analize de impact versionate** pentru măsuri concrete. Fiecare analiză are câmpurile cerute de spec:
   - buget aprobat (da / nu / necunoscut, cu sursă);
   - sursa de finanțare;
   - sustenabilitate (recurentă sau one-off, orizont);
   - efect asupra deficitului (sumă și % din PIB);
   - sectoare, companii cu expunere demonstrabilă, riscuri de implementare;
   - scenariile **integral / parțial / întârziat**.

   Faptele, ipotezele și rezultatele modelului stau în secțiuni separate, atât în date, cât și pe ecran.
2. **Motor de calcul determinist**: `templates/shared/hif-impact.js`, un modul pur partajat de browser și
   Node, construit peste `hif-scenario.js`. Fiecare rezultat vine cu formula scrisă cu cifrele introduse.
   E testat (TDD).
3. **Expunerea companiilor BVB**: venit, marjă operațională, distribuția geografică a vânzărilor,
   segmente → sectoare, expunere fiscală (evenimentele care o ating). Totul e legat de Following și Portofoliu.
4. **Knowledge graph**:
   - noduri: eveniment, politică (măsură), sector, companie, instrument, scenariu, rezultat observat;
   - analizele sunt imuabile după publicare (o versiune nouă = un rând nou);
   - acuratețea se evaluează ulterior față de rezultatele observate.
5. **Funcții pentru utilizator, toate deterministe**:
   - căutare și filtre pe evenimente, sectoare și companii BVB;
   - calculator de scenarii cu formular (parametri editabili, formule afișate, link partajabil);
   - alerte când apare un eveniment sau o analiză legată de companiile din Following sau Portfolio.
6. **AI intern, opțional, prioritate minimă**: LM Studio local, doar în batch:
   - clasificare, extragere de entități, rezumate;
   - rezultatele intră în Supabase marcate „generat automat, neverificat” până le validează administratorul;
   - site-ul și ingestia nu depind de el.

## Non-obiective
- Predicții de preț, ținte de preț, ratinguri, „cumpără/vinde/păstrează”, recomandări personalizate.
- Modelare macroeconomică (multiplicatori, efecte de ordinul doi). Modelul are un singur pas: efectul contabil
  direct asupra bugetului și asupra profitului operațional al companiei.
- Asistent sau chat AI pentru utilizatori. Modele AI externe.
- Plăți și entitlements (Faza D).
- Salvarea scenariilor utilizatorului în cont. **[decizia mea]** Parametrii stau în link (hash-ul URL-ului),
  deci scenariul se poate păstra și trimite fără o cale nouă de scriere în baza de date.

## Anti-obiective (eșec chiar dacă „merge”)
- O cifră fără proveniență: fiecare număr e fie **fapt** (cu link), fie **ipoteză** (cu motiv și interval), fie
  **rezultat** (cu formulă).
- O analiză publicată modificată retroactiv.
- Un rezultat de model prezentat ca fapt sau ca prognoză de preț.
- Notificări zilnice în avalanșă (cele 930 de proiecte existente nu trebuie să trimită nimic).
- Text generat de AI arătat utilizatorilor ca informație verificată.
- Limbaj evaluativ sau partizan (regulile din Faza B rămân).

## Decizii de arhitectură

| # | Decizie | De ce |
|---|---|---|
| C1 | **[decizia mea]** Analizele și datele financiare ale companiilor sunt **fișiere JSON în repo**: `analyses/<id>/v<N>.json` și `config/company-financials.json`. Un job de ingestie le validează, calculează rezultatele și le scrie în Supabase. | Git dă versionare, istoric și review prin PR, adică validarea proprietarului. Nu apare nicio cale nouă de scriere din browser, deci suprafața de securitate e mică. Repo-ul fiind public, oricine poate verifica cifrele. |
| C2 | Imuabilitate pe două niveluri: (a) un test respinge modificarea unui fișier `vN.json` deja publicat (hash în `analyses/LOCK.json`); (b) în Supabase, un trigger refuză `UPDATE`/`DELETE` pe `impact_analyses`, inclusiv pentru service role. | „Ipotezele nu se schimbă retroactiv” trebuie garantat de cod, nu de disciplină. |
| C3 | La sincronizare, rezultatele modelului se calculează și se **îngheață** în `impact_results`, împreună cu versiunea motorului (`ENGINE_VERSION`). Dacă motorul se schimbă, rezultatul vechi rămâne; UI-ul poate arăta în plus „recalculat cu motorul vX”. | Acuratețea se evaluează față de ce s-a afirmat atunci, nu față de un recalcul. |
| C4 | Knowledge graph = **view-uri SQL** (`knowledge_nodes`, `knowledge_edges`) peste tabele relaționale, nu tabele de graf separate. | Fără date duplicate care se pot desincroniza. Muchiile spun mereu din ce rând provin. |
| C5 | Alertele de politici sunt calculate de o funcție SQL (`policy_alerts_due`, doar service role). Edge Function `scan` (modul alerts) doar trimite push-ul și marchează rândurile. | Logica de potrivire se testează în PGlite. Edge Function rămâne subțire, ca acum. |
| C6 | Datele financiare au proveniență: `manual` (din raportul anual, cu link, verificate prin PR) sau `filing_auto` (extrase de LM Studio din rapoartele BVB, neverificate). În calculator intră implicit **doar** cele verificate; cele automate apar doar ca sugestie etichetată. | Din cele 32 de rapoarte de rezultate extrase automat, unele sunt din 2014 sau au unități amestecate. Nu sunt bune ca valori implicite. |
| C7 | „Expunerea fiscală” a unei companii e o **defalcare**, nu un scor: evenimente active care o menționează, evenimente prin sector, acte adoptate în ultimele 12 luni, analize care o includ. | Un scor opac ar fi o recomandare deghizată. Defalcarea e verificabilă. |
| C8 | Validarea rezultatelor AI se face printr-un ecran de administrare cu două RPC-uri `is_admin()`: `admin_ai_review(id, decision)` și lista. Utilizatorii obișnuiți văd doar adnotările `verified`, etichetate „generat automat, verificat manual”. | Cerința din spec, cu o singură cale de scriere, rezervată adminului. |

## Modelul de calcul (`hif-impact.js`)
Toate sumele sunt anuale, în lei. Procentele se introduc ca 0–100. Rotunjirea se face la 1e-10, ca în `hif-scenario.js`.

**Buget (efectul asupra deficitului)**
```
efect brut anual         = cost   (+ = cheltuială/pierdere de venit la buget, − = venit suplimentar)
efect net asupra soldului = −cost × (1 − finanțat%)              (negativ = crește deficitul)
% din PIB                = efect net / PIB × 100                 (PIB = ipoteză cu sursă, ex. prognoza CNSP)
efect în anul Y          = efect net × implementare% × luni_în_vigoare(Y) / 12
```
`luni_în_vigoare(Y)` se calculează din data de start a scenariului (data de start a măsurii + întârziere),
plafonat între 0 și 12. Rezultatele se arată pentru anul de start și pentru anul următor.

**Scenarii** (parametrii sunt ipoteze ale analizei; utilizatorul îi poate schimba în calculator)
| Scenariu | implementare% | întârziere (luni) |
|---|---|---|
| Integral | 100 | 0 |
| Parțial | ipoteza analizei (implicit 50) | 0 |
| Întârziat | 100 | ipoteza analizei (implicit 6) |

**Companie** (refolosește `HIFScenario.compute`)
```
variația veniturilor          = venit × expunere% × șoc% × (1 − atenuare%)
variația profitului operațional = variația veniturilor × marjă de contribuție%
în scenariu                   = × implementare% × luni_în_vigoare(an) / 12
% din profitul operațional     = variația profitului / |profit operațional de bază| × 100   (null dacă baza e 0)
```

**Portofoliu**
```
efect ponderat = Σ (pondere_i × %profit_i)   pe companiile din analiză pe care utilizatorul le deține
```
Ponderea e valoarea poziției la cotația curentă împărțită la valoarea portofoliului. Se afișează cu eticheta
„medie ponderată a variației profitului operațional, nu a valorii portofoliului”.

**Acuratețe** (pentru fiecare rezultat observat)
```
eroare = observat − estimat;  eroare relativă = eroare / |estimat|;  direcție corectă = semn(observat) = semn(estimat)
```

## Formatul unei analize (`analyses/<id>/v<N>.json`)
```json
{
  "id": "tva-2026", "version": 1, "published_at": "2026-10-19",
  "title": "…", "policy": "tva-cota-standard",
  "events": ["cdep:12345", "mf:678"],
  "facts": [{ "key": "cota", "text": "…", "value": 21, "unit": "%", "source_url": "https://…", "source_date": "2026-…" }],
  "budget": { "approved": "yes|no|unknown", "approved_fact": "key|null", "funding_source": "…|null",
              "funding_fact": "key|null", "recurring": true, "horizon_years": null, "sustainability_note": "…" },
  "assumptions": [{ "key": "cost", "label": "…", "value": -1.2e10, "unit": "RON", "why": "…", "range": [lo, hi] },
                  { "key": "funded_pct", … }, { "key": "gdp", … }, { "key": "start", "value": "2026-08-01" },
                  { "key": "partial_pct", … }, { "key": "delay_months", … }],
  "sectors": ["fiscal-general"],
  "companies": [{ "ticker": "M.RO", "why": "…", "exposure_pct": {"ref": "a_key"}, "shock_pct": …,
                  "mitigation_pct": …, "contribution_pct": … }],
  "risks": [{ "kind": "legal|administrative|funding|timing", "text": "…" }]
}
```
Validatorul (`ingest/impact/schema.mjs`) cere următoarele:
- fiecare `source_url` începe cu `https://`;
- fiecare ipoteză are `why` și `range`, iar `value` cade în `range`;
- tickerele există în catalogul BVB;
- sectoarele există în taxonomie;
- evenimentele există în `policy_events` (verificat la sincronizare);
- câmpurile numerice ale companiilor sunt referințe spre ipoteze sau fapte, nu numere fără proveniență.

Venitul și profitul operațional al companiei vin din `config/company-financials.json`, unde fiecare rând are
`source_url` (raportul anual) și `fiscal_year`. **[decizia mea]** Pun cifre doar pentru companiile al căror
raport l-am deschis și citit în timpul fazei. Pentru celelalte, calculatorul cere valorile utilizatorului.

## Date (Supabase, `supabase/impact.sql`)
**Tabele**
| Tabel | Conținut | Citire | Scriere |
|---|---|---|---|
| `company_financials` | (ticker, fiscal_year, currency, revenue, operating_profit, net_profit, geo_ro_pct, geo_eu_pct, geo_other_pct, segments jsonb, source_url, provenance `manual`/`filing_auto`, verified) | aprobați: doar `verified`; admin: tot | service |
| `impact_analyses` | (id, version, …tot JSON-ul…, content_hash, synced_at); PK (id, version); trigger care refuză update/delete | aprobați | service, doar insert |
| `impact_results` | (analysis_id, version, engine_version, scenario, subject `budget`/ticker, values jsonb, formula text); PK pe primele patru + subject | aprobați | service, doar insert |
| `impact_outcomes` | (analysis_id, version, subject, metric, period, observed, source_url, recorded_at): rezultatele observate, tot din repo (`analyses/<id>/outcomes.json`) | aprobați | service |
| `ai_annotations` | (target_type, target_id, kind `summary`/`entities`/`sectors`, content, model, status `unverified`/`verified`/`rejected`, reviewed_by, reviewed_at) | aprobați: doar `verified`; admin: tot | RPC cu secret (PC); review prin RPC admin |

**View-uri**: `knowledge_nodes` și `knowledge_edges` (C4), `analysis_accuracy`, `company_exposure`
(numărătorile din C7), toate `security_invoker`.

**Alerte**
- `policy_events.alerted_at` și `policy_event_history.alerted_at`, cu un backfill care marchează ca alertate
  toate rândurile existente.
- `impact_analyses.alerted_at`.
- `push_subscriptions.policy_alerts` (boolean, implicit true; comutator pe dispozitiv).

## Alerte (reguli) **[decizia mea]**
- Destinatari: utilizatorii la care tickerul e în Following cu push activ sau în Portofoliu, și care au un
  dispozitiv cu `policy_alerts = true`.
- Se trimite:
  - **eveniment nou sau schimbare de statut** la o companie **menționată** (`why = mentioned`), indiferent de statut;
  - **act adoptat** (nou sau trecut în `adopted`) la o companie legată **prin sector**;
  - **analiză nouă publicată** care include compania.
- Un singur push pe utilizator pe rulare, sub formă de rezumat: „3 evenimente noi pentru companiile tale: …”.
  Jobul `eod` rulează o dată pe zi, deci rezultă cel mult un push pe zi.
- În aplicație: eticheta „Nou” pe evenimentele apărute de la ultima vizită (localStorage, doar convenience).

## UI (în ecranul Politici, flag `impact`)
- Tab-uri: **Evenimente** (ce există) · **Analize** · **Companii**.
- **Evenimente**:
  - căutare în titlu (PostgREST `ilike`, server-side);
  - filtre pe status, sector și companie, plus „cu analiză” și „doar ce mă afectează”;
  - cardul arată istoricul de statut și linkul spre analiză, dacă există.
- **Analiză**:
  - prima linie: statut · aprobat bugetar da/nu/necunoscut · start · efect asupra deficitului (% PIB) ·
    „te atinge: X companii (−Y% profit operațional, scenariu integral)”;
  - secțiuni vizual separate: **Fapte** (cu link), **Ipoteze** (cu motiv și interval), **Rezultate model**
    (cu formulă), **Riscuri**;
  - cele 3 scenarii unul lângă altul; butonul „Modifică ipotezele” deschide calculatorul cu valorile analizei;
  - versiunea, data și versiunea motorului; versiunile vechi rămân accesibile;
  - acuratețea, când există rezultate observate.
- **Calculator** (înlocuiește formularul din `intelligence.html`, păstrând pagina):
  - parametrii de buget și de companie, toți editabili, cu limitele din `LIMITS`;
  - formula afișată cu cifrele introduse;
  - link partajabil (parametrii în `#hash`);
  - butonul „Revino la ipotezele analizei”.
- **Companii**:
  - listă BVB cu căutare și filtru pe sector;
  - pagina companiei: date financiare (anul, sursa, „verificat” sau nu), distribuția geografică, segmente →
    sectoare, defalcarea expunerii fiscale, analizele care o includ, apartenența la Following/Portofoliu.
- **Portofoliu**: cardul „Expunere la politici” (efect ponderat pe analiză, cu formula).
- **Admin**: lista adnotărilor AI neverificate, cu butoanele Validează / Respinge (flag `aiAnnotations`).
- Disclaimer fix pe fiecare analiză și în calculator:
  > Nu este o recomandare de investiții. Modelul estimează efectul contabil direct asupra bugetului și a
  > profitului operațional, nu prețul acțiunilor.

## AI intern (LM Studio), prioritate minimă
- `tools/policy-ai-batch.mjs` pe PC, cu un timer systemd ca `market-pulse-summaries`. Refolosește
  `lmstudio-model.mjs` și pattern-ul RPC-cu-secret din `summaries.sql`.
- Fereastră configurabilă (`AI_WINDOW=01-06`, ora București), limită de timp pe rulare (`AI_MAX_MINUTES=30`),
  `nice 19` și firele limitate ca la batch-ul existent.
- Dacă LM Studio nu răspunde în 5 s, jobul iese cu „amânat”, fără eroare și fără reîncercare în aceeași rulare.
- Sarcini:
  - rezumat al fișei proiectului (PC-ul poate citi cdep.ro);
  - entități (instituții, companii);
  - sugestii de sectoare.

  Totul merge în `ai_annotations` cu `status = unverified`. Nu modifică niciodată clasificarea deterministă.
- Flag `aiAnnotations: false` până la prima rulare verificată.

## Flag-uri noi
| Flag | Valoare | Ce face |
|---|---|---|
| `impact` | true | tab-urile Analize/Companii, calculatorul nou, cardul din portofoliu |
| `policyAlerts` | true | regulile de alertă de mai sus (frontend: comutatorul; Edge Function: secretul `FLAG_POLICY_ALERTS`) |
| `aiAnnotations` | false | ecranul de admin și afișarea adnotărilor verificate |

## Constrângeri
Rămân cele din Fazele A și B:
- Node 22, `node --test`, PGlite;
- TDD pentru motor, validator, sincronizare, SQL/RLS și alerte;
- fără chei în browser, repo public;
- doar staging, fără deploy de producție;
- `/security-review` la final; e obligatoriu, pentru că faza atinge RLS și RPC-uri admin.

## Rollback
- Flag-urile `impact`, `policyAlerts` și `aiAnnotations` pe false ascund tot.
- Jobul `impact` e un pas separat.
- Tabelele noi nu ating nimic existent. Excepție fac coloanele `alerted_at` și `policy_alerts`, aditive și
  cu valori implicite sigure.

## Ce lăsăm builder-ului
Aspectul exact al cardurilor (păstrând tema), formulările exacte EN/DE și ordinea câmpurilor din formular.
