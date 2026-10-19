# Politici 2.0 – design: impact automat, fișe scurte, „Cine câștigă”

Data: 2026-10-19 · Cerut de proprietar în conversație. Ce e marcat **[decizia mea]** e alegerea lui Claude și
se poate schimba; restul a fost spus sau confirmat de proprietar.

## De ce
Monitorul de politici (Faza B) adună automat tot ce publică statul. Acum sunt 1.483 de acte: 1.463 de la
Camera Deputaților și 20 de la Ministerul Finanțelor. 304 dintre ele sunt legate de cel puțin o companie BVB.
Analiza de impact cu cifre (Faza C) există însă pentru o singură măsură (Legea 162/2026), scrisă de mână.

Proprietarul vrea trei lucruri:
1. **Analiză de impact pentru fiecare document nou, automat.** Doar cu date concrete și adevărate, iar
   fiecare ipoteză trebuie să aibă justificare.
2. **O fișă scurtă acolo unde analiza nu se poate face**, care spune și *de ce* nu se poate.
3. **O secțiune separată sub Politici: „Cine câștigă”.** Motto-ul proprietarului: „dacă nu-i poți învinge,
   alătură-te lor”. Statul nu face nimic fără un interes; cineva câștigă de pe urma legilor, comunicatelor și
   contractelor lui. Investitorul vrea să vadă cine și de ce, ca să-și construiască *singur* o strategie
   pornind de la ce face și ce publică statul.

## Obiective
1. **Fiecare document nou primește automat analiză sau fișă**, publicate fără aprobare manuală (confirmat de
   proprietar). Fiecare are eticheta „generată automat, verificată pe textul sursă” și un avertisment vizibil:
   analizele automate pot conține erori, iar cifrele trebuie verificate în documentul oficial (link alăturat)
   înainte de a te baza pe ele.
2. **Doar date adevărate.**
   - Orice cifră dintr-un fapt trebuie să apară în textul sursă stocat; altfel e respinsă (verificare
     automată).
   - Orice ipoteză vine dintr-o bibliotecă aprobată prin PR, cu justificare, sursă și interval.
   - Fără fapte suficiente nu există analiză. Rămâne doar fișa, cu motivul.
3. **Fișa scurtă**, pentru *toate* documentele:
   - ce schimbă;
   - pe cine atinge: sectoare, companii BVB, cu motivul legăturii;
   - stadiul, data și instituția;
   - linkul oficial;
   - secțiunea „De ce nu are analiză de impact”, cu motive concrete (lista de coduri de mai jos).
4. **Surse noi, ca să vedem și cui plătește statul efectiv, nu doar ce promite:**
   - Senatul (proiecte și stadii);
   - Guvernul: hotărâri și ordonanțe, inclusiv proiectele puse în dezbatere publică;
   - portalul legislativ al Ministerului Justiției (legislatie.just.ro): actele publicate, cu reutilizare
     liberă și API;
   - achizițiile publice (SEAP): contracte atribuite, câștigător (CUI), valoare;
   - ajutoarele de stat: beneficiarii publicați (registrul Consiliului Concurenței și modulul de transparență
     al Comisiei Europene).

   O sursă intră doar dacă termenii și robots.txt permit preluarea automată (Task 0). Altfel se notează în
   `LEGAL-SOURCES.md` și se lasă deoparte.
5. **„Cine câștigă”**, un tab nou în Politici, cu trei vederi:
   - **Pe măsură:** cine câștigă și cine pierde. Fiecare legătură are un tip (vezi „Legături”), o dovadă cu
     link și direcția efectului, doar când e demonstrabilă din fapte.
   - **Pe companie, „Expunerea la stat”:**
     - contractele publice câștigate în ultimele 12 luni, ca sumă și ca % din cifra de afaceri raportată;
     - ajutoarele de stat primite;
     - măsurile care o avantajează sau o costă;
     - totul pe o axă de timp.
   - **Pe sector, „Unde își mută statul banii”:** sume intrate (contracte, ajutoare, finanțări anunțate)
     versus sarcini (taxe, plafonări, contribuții), pe luni. Doar sume din fapte; fără estimări.
6. **Mesajul legal, clar, pe tab și în pagina legală.** „Cine câștigă” arată informații despre deciziile
   statului, nu recomandări de investiții. Strategia și deciziile îi aparțin utilizatorului. Market Pulse nu
   este consultant de investiții autorizat (ASF).

## Non-obiective
- Recomandări „cumpără / vinde / păstrează”, ținte sau predicții de preț, „top acțiuni de cumpărat”.
- **Un scor compus** de „beneficiu” per companie **[decizia mea]**: ar arăta ca un rating, adică exact ce nu
  facem. Se arată doar sume și fapte, sortabile.
- Surse plătite sau surse care interzic preluarea automată.
- Modele AI externe. Folosim doar LM Studio local, pe PC-ul proprietarului, în batch.

## Anti-obiective (eșec chiar dacă „merge”)
- O cifră publicată care nu se găsește în sursa citată.
- O ipoteză fără justificare și sursă, cum e „Nesursat” în analiza manuală Legea 162 (`diesel_volume`).
  Pentru analizele automate, asta e interzis.
- O analiză pentru un tip de măsură pe care motorul nu-l modelează, ca să umple un gol.
- Un ton de recomandare în „Cine câștigă”.
- Un contract SEAP atribuit greșit unei companii BVB (potrivire după nume în loc de CUI).

## Cum funcționează

### Fluxul pentru un document nou
```
[GitHub Actions, eod, zilnic]                       [PC proprietar, LM Studio, noaptea]
surse → policy_events (ca acum)                     documente fără analiză/fișă
     → documente: PDF/HTML descărcate,              → propunere structurată (JSON)
       text extras, stocat (policy_documents)         - tip măsură, fapte cu citat exact,
     → extragere deterministă:                        - companii/sectoare, chei de ipoteze
       sume, cote, date, fișa financiară            → VALIDATOR (determinist, același cod ca în CI)
     → legături deterministe:                         ├─ trece → analiză automată v1 (imuabilă)
       CUI → companie BVB (SEAP, ajutoare)             │         + rezultate calculate de motor
       sector/companie (clasificare actuală)          └─ nu trece → fișă cu motive (coduri)
```
- **De ce două locuri [decizia mea]:** descărcarea și extragerea deterministă rulează în cloud, fără PC.
  Citirea textelor lungi cere modelul local, deci rulează pe PC (ca `tools/policy-ai-batch.mjs`), în
  fereastra `AI_WINDOW`. Când PC-ul e oprit, documentele așteaptă. Fișa minimă (date deterministe, fără
  „ce schimbă”) apare oricum din cloud, cu motivul `ai_pending`.
- **Ce rulează automat:** jobul `eod` din ingestie (pornit de pg_cron, zilele lucrătoare, 21:40 UTC) și
  timerul systemd de pe PC.

### Validatorul (inima garanției „doar adevărat”)
Este cod determinist, partajat (`ingest/impact/auto-validate.mjs`), cu teste. O propunere devine analiză doar
dacă toate condițiile sunt îndeplinite:
1. **Fapte.** Fiecare fapt are `quote`. Citatul apare literal în textul stocat al documentului (după
   normalizarea spațiilor și diacriticelor). Fiecare cifră din `value` apare în citat (formate RO: `1.234,5`,
   `mil.`, `mld.`).
2. **Ipoteze.** Fiecare ipoteză are o `key` din `config/impact-assumptions.json` și o valoare în intervalul
   ei. Biblioteca se schimbă doar prin PR. Fiecare intrare are `why`, `source_url` și `range`.
3. **Companii.** Fiecare companie din analiză are cifre în `config/company-financials.json`, din raportul
   anual auditat, cu link.
4. **Tip de măsură.** Tipul e unul dintre cele pe care motorul le modelează (lista de mai jos), iar faptele
   obligatorii ale tipului sunt prezente.
5. **Motor.** Motorul `hif-impact.js` calculează fără erori, iar rezultatele sunt numere finite.

Dacă o regulă pică, documentul primește fișă cu motivul. Validatorul nu „repară” nimic.

### Tipurile de măsură modelate automat [decizia mea, extensibil prin PR]
| Tip | Fapte obligatorii | Ce calculează |
|---|---|---|
| `tax_rate_change` (taxă, acciză, contribuție, redevență) | cota veche și nouă (sau suma pe unitate), baza, data | efect buget (dacă fișa financiară dă suma) + efect pe companie (venituri × expunere × șoc) |
| `budget_program` (schemă de ajutor, program de finanțare, investiție publică) | suma alocată, perioada, beneficiarii eligibili | efect buget; pe companii doar dacă există beneficiari cu CUI (ajutoare, contracte) |
| `price_cap` (plafonare) | nivelul plafonului, perioada, cine e vizat | efect pe companie doar dacă există ipoteză din bibliotecă pentru volum |
| `contract_award` (SEAP) | câștigător (CUI), valoare, durată | pondere în cifra de afaceri a companiei; fără efect buget |

Orice alt tip (organizare instituțională, proceduri, ratificări fără sume etc.) primește doar fișă.

### Biblioteca de ipoteze (`config/impact-assumptions.json`)
- Pornește cu ipotezele generale din analiza Legea 162. Fiecare are o sursă oficială: INS, Eurostat, BNR sau
  raportul companiei.
- Ipotezele fără sursă, cum e `diesel_volume`, **nu intră** până nu primesc una.
- Fiecare intrare conține: `key`, `label`, `why`, `source_url`, `source_date`, `range`, `default` și
  `applies_to` (tipurile de măsură).

### Motive standard pentru „De ce nu are analiză” (coduri → text RO/EN/DE)
| Cod | Mesaj |
|---|---|
| `no_figures` | documentul nu conține sume sau cote |
| `no_financial_sheet` | proiectul nu are fișă financiară publicată |
| `type_not_modelled` | tipul măsurii nu se poate calcula |
| `no_company_data` | lipsesc cifrele auditate ale companiei {x} |
| `missing_assumption` | ar fi nevoie de o ipoteză fără sursă: {y} |
| `quote_not_found` | cifrele propuse nu s-au regăsit în text |
| `ai_pending` | documentul așteaptă citirea completă |
| `source_unreadable` | textul sursei nu s-a putut extrage |

### Legături „Cine câștigă” (tipuri, toate cu dovadă)
| Tip | De unde | Direcție |
|---|---|---|
| `named` | compania e numită în document | din fapte, altfel „neutru” |
| `contract` | câștigător SEAP, potrivit după **CUI** | câștigă |
| `state_aid` | beneficiar publicat de ajutor de stat (CUI) | câștigă |
| `tax_payer` | plătitor al unei taxe sau contribuții noi (din analiză) | pierde |
| `sector` | sectorul vizat (clasificarea actuală) | doar dacă e demonstrabilă din fapte, altfel neutru |
| `funded_program` | program finanțat pentru care compania e eligibilă după CAEN (fapt) | potențial |

- **Maparea companii BVB ↔ CUI:** se face în `config/company-entities.json`. Conține emitentul și filialele,
  fiecare cu sursă (raportul anual sau ONRC).
- **Fără CUI nu există legătură `contract` sau `state_aid`.** Asta previne potrivirile greșite după nume.

### Ecrane
- **Politici → card de document:** analiza automată, cu eticheta „automată” și avertismentul, sau fișa
  scurtă cu „De ce nu are analiză”.
- **Politici → tab nou „Cine câștigă”:**
  - deasupra, banda cu mesajul legal (informații, nu recomandări; decizia îți aparține);
  - trei comutatoare: Măsuri / Companii / Sectoare;
  - filtre: perioada, sector, doar companiile mele (Following ∪ Portofoliu).
- **Alerte:** extind alertele de politici existente (cel mult una pe zi) cu „contract public câștigat” și
  „ajutor de stat primit” pentru companiile utilizatorului **[decizia mea]**.
- **Faza D:** în modul comercial, rezultatele analizelor și „Cine câștigă” sunt Pro, ca `impact_results`
  acum **[decizia mea]**. Fișele rămân pentru toți.

### Schimbare față de Faza C (aprobată de proprietar)
- **Înainte:** adnotările AI erau ascunse până la verificarea unui admin.
- **Acum:** fișele și analizele automate se publică direct, cu etichetă și avertisment. Ecranul Administrare
  păstrează butonul „Retrage” pentru o analiză greșită. Retragerea o ascunde, nu o șterge, iar motivul se
  vede public.
- **Imuabilitatea rămâne:** o corectură înseamnă o versiune nouă.

## Constrângeri
- **Cloud fără AI.** Nimic din cloud nu cheamă un model. Fără PC pornit, apar doar fișele deterministe.
- **Tabele noi** (`policy_documents`, `auto_analyses` sau o coloană `origin` pe `impact_analyses`,
  `state_links`, `public_contracts`, `state_aid`):
  - RLS: citire pentru conturi aprobate;
  - scriere doar prin funcții `service_role` sau prin secretul batch-ului, ca `ai_annotations_save`.
- **Volume.** Ținem doar ce privește companiile BVB din catalog și filialele lor, nu toate contractele SEAP,
  ca să rămânem în planul gratuit Supabase.
- **Securitate.** Textele descărcate sunt date nesigure: nu se execută nimic din ele. Promptul modelului
  le tratează ca text, iar validatorul e ultima barieră.

## Lăsate constructorului
- Formatul exact al tabelelor și al propunerii JSON.
- Parserele pentru fiecare sursă.
- Normalizarea cifrelor românești.
- Așezarea vizuală a tab-ului (în stilul ecranului Politici).

## Riscuri cunoscute
- **Multe documente vor primi doar fișă**, pentru că propunerile legislative rareori au fișă financiară.
  Asta e corect și se vede din motive.
- **Calitatea modelului local** poate fi slabă. Validatorul respinge, dar nu poate garanta că *alegerea*
  faptelor e cea mai relevantă, de aceea avertismentul e permanent.
- **Sursele se pot schimba sau bloca.** Fiecare parser are teste pe fișiere salvate și raportează în
  `ingest_runs`.
