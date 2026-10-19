# Analizele de impact (Faza C): cum funcționează

Design: `docs/plans/2026-10-18-faza-c-design.md`. Formule: `templates/shared/hif-impact.js` (testate în
`test/impact-engine.test.js`). **Nu e consultanță de investiții**: modelul estimează efectul contabil direct
asupra bugetului și asupra rezultatului din exploatare, niciodată prețul acțiunilor.

## Trei feluri de cifre, ținute separat
| Fel | Ce are obligatoriu | Unde |
|---|---|---|
| **Fapt** | text, link `https://` spre sursa oficială, data sursei | `facts` în analiză |
| **Ipoteză** | etichetă, motiv (`why`), interval plauzibil (`range`); valoarea e în interval | `assumptions` |
| **Rezultat** | formula, scrisă cu cifrele introduse; versiunea motorului | calculat de jobul `impact`, înghețat în `impact_results` |

O companie din analiză nu primește numere „de mână”: câmpurile ei sunt referințe (`{ "ref": "cheie" }`) spre
ipoteze sau fapte. Validatorul (`ingest/impact/schema.mjs`) respinge orice altceva.

## Formulele (motorul `1.0.0`)
```
Buget
  efect net asupra soldului = −cost × (1 − finanțat%)            (negativ = crește deficitul)
  efect anual               = efect net × implementare%
  pondere în PIB            = efect anual / PIB
  efect în anul Y           = efect net × implementare% × luni_în_vigoare(Y) / 12
Companie
  variația veniturilor      = venituri × expunere% × șoc% × (1 − compensare%)
  variația rezultatului     = variația veniturilor × contribuție%
  pondere în rezultat       = variația rezultatului × implementare% / |rezultat din exploatare|   (n/a dacă e 0)
  efect în anul Y           = variația rezultatului × implementare% × luni_în_vigoare(Y) / 12
Portofoliu (pozițiile în lei)
  efect ponderat            = Σ pondere_i × pondere în rezultat_i       (nu e variația valorii portofoliului)
Acuratețe
  eroare = observat − estimat;  eroare relativă = eroare / |estimat|;  direcție corectă = același semn
```
`luni_în_vigoare(Y)`: lunile anului Y dintre data de start + întârziere și data de sfârșit (măsuri
temporare), cu fracții de lună pe zile. Scenarii: **integral** (100%, fără întârziere), **parțial**
(`partial_pct`), **întârziat** (`delay_months`).

## Cum se adaugă o analiză
1. Creează `analyses/<id>/v1.json` după formatul din design. Exemplul real este
   `analyses/lege-162-2026-motorina/v1.json`.
2. Pentru fiecare companie, pune în `config/company-financials.json` cifrele din **ultimul raport anual
   auditat**, cu link spre raport. Ce nu e în raport rămâne `null`; nu se estimează.
3. Rulează `npm run impact:lock` și `npm test`, apoi deschide un PR. Review-ul PR-ului este validarea.
4. După merge, jobul `eod` (sau `--job=impact`) scrie analiza în Supabase și îi calculează rezultatele.

O analiză publicată **nu se modifică**:
- `analyses/LOCK.json` păstrează hash-ul fiecărui fișier, iar testele pică dacă fișierul se schimbă;
- în Supabase, un trigger refuză orice `UPDATE`/`DELETE`.

O corectură înseamnă `v2.json`. Versiunea veche rămâne vizibilă în aplicație.

## Rezultate observate (acuratețea)
`analyses/<id>/outcomes.json`:
```json
[{ "version": 1, "scenario": "full", "subject": "SNP.RO", "metric": "operating_profit_change",
   "period": "2026", "observed": -150000000, "source_url": "https://…raport…" }]
```
Pentru buget: `"subject": "budget", "metric": "budget_effect"`. View-ul `analysis_accuracy` compară valoarea
observată cu estimarea **înghețată** pentru acel an.

## Graful de cunoștințe
View-urile `knowledge_edges` / `knowledge_nodes` (`supabase/impact.sql`) leagă:

| Din | Relație | Spre |
|---|---|---|
| eveniment | `classified_as` | sector |
| eveniment | `affects` | companie |
| politică | `evidenced_by` | eveniment |
| politică | `targets` | sector |
| politică | `modelled_as` | scenariu |
| scenariu | `estimates` | companie |
| companie | `listed_as` | instrument |
| rezultat observat | `observes` | scenariu |

Nu sunt tabele separate: fiecare muchie se citește din rândul care o justifică.

## Alerte de politici
Funcția SQL `policy_alerts_due` stabilește cine primește alertă și pentru ce:
- un eveniment nou sau o schimbare de statut la o companie **menționată**;
- un act **adoptat** la o companie legată prin sector;
- o analiză nouă care include compania.

Se iau în calcul companiile din Following (cu push activ) sau din Portofoliu.

Edge Function `scan` (modul `alerts`) trimite cel mult un push pe utilizator pe rulare, apoi marchează tot ce
aștepta. Jobul `eod` o cheamă după politici și analize, deci rezultă cel mult o alertă pe zi.

Alertele se opresc în două feluri:
- per dispozitiv: comutatorul „Alerte politici” din Setări;
- global: secretul `FLAG_POLICY_ALERTS` al funcției (`true` = pornite).

## AI intern (opțional, prioritate minimă)
`tools/policy-ai-batch.mjs`, pe PC, cu LM Studio local, fără niciun model extern:
- citește titlul și rezumatul evenimentelor deja stocate;
- propune un rezumat pe înțeles, instituțiile și companiile numite, și sectoare;
- salvează totul cu `status = unverified` („generat automat, neverificat”).

Cititorii văd doar ce un administrator a marcat „Verificat” în ecranul Administrare, iar flag-ul
`aiAnnotations` trebuie să fie pornit. Adnotările nu schimbă niciodată clasificarea deterministă.

Variabile, în `~/.config/market-pulse/summarizer.env`:
- `AI_WINDOW=01-06` (ora București; poate fi și peste miezul nopții, de exemplu `22-02`);
- `AI_MAX_MINUTES=30`;
- `AI_LIMIT=20`.

Dacă LM Studio nu răspunde în 5 secunde, rularea se amână fără eroare.

Pornirea (manuală):
```
cp tools/systemd/market-pulse-policy-ai.* ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now market-pulse-policy-ai.timer
```

## Analize automate și fișe (Politici 2.0)
Design: `docs/plans/2026-10-19-politici-automat-design.md`. Comutatoare: `autoImpact` (fișele și analizele
automate în aplicație) și `whoGains` (tab-ul „Cine câștigă”). Ambele sunt oprite până la verificarea pe staging.

**Fluxul:**
1. **Jobul `eod`** (cloud, fără AI):
   - adună actele de la Camera Deputaților, Ministerul Finanțelor, notele Guvernului (`ingest/policy/gov.mjs`)
     și ordonanțele din portalul legislativ (`ingest/policy/just.mjs`);
   - descarcă documentele pe care le poate atinge (`ingest/policy/documents.mjs`: `pdftotext`; PDF-urile
     scanate rămân „necitibile”, fără OCR);
   - scrie o **fișă de bază** pentru fiecare eveniment;
   - citește contractele SEAP noi (`ingest/state/seap.mjs`, doar după cod fiscal, `config/company-entities.json`).
2. **Pe PC, noaptea** (`tools/policy-auto-batch.mjs`, timerul `market-pulse-policy-auto`):
   - citește documentele Camerei, care nu răspunde serverelor GitHub;
   - cere modelului local (LM Studio) o propunere pentru fiecare document necitit.
3. **Validatorul** (`ingest/impact/auto-validate.mjs`) decide:
   - **analiză**, dacă fiecare citat apare exact în document și își conține valoarea, fiecare ipoteză vine din
     `config/impact-assumptions.json` (cu sursă) și în interval, companiile au cifre auditate, tipul măsurii e
     modelat și motorul calculează;
   - altfel, **fișă cu motive**: `no_figures`, `no_financial_sheet`, `type_not_modelled`, `no_company_data`,
     `missing_assumption`, `quote_not_found`, `ai_pending`, `source_unreadable`.

**Unde stau:**
- Analizele automate stau în `impact_analyses` cu `origin = 'auto'`, sunt imuabile ca celelalte (o versiune
  nouă la un text nou al documentului) și au eticheta „Generată automat, verificată pe textul sursă”.
- Un administrator le poate **retrage** din aplicație. Analiza rămâne, ascunsă, cu motivul afișat.

**Biblioteca de ipoteze:**
- Se schimbă doar prin PR. O intrare `data` cere sursă oficială https și dată.
- O intrare `scenario` (implementare parțială, întârziere, compensare, contribuție) e o alegere de metodă și
  își spune motivul.
- Fără o sursă pentru PIB-ul anului unei măsuri (`gdp_<an>`), măsura primește fișă, nu analiză.

**„Cine câștigă”** (view-urile `state_links`, `company_state_exposure`, `sector_state_flows`):
- doar legături cu dovadă: companie numită, sector, contract, ajutor, cost dintr-o analiză;
- fără scor compus și fără recomandări;
- banda legală e fixă în aplicație.

**Pornirea pe PC:**
```
cp tools/systemd/market-pulse-policy-auto.* ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now market-pulse-policy-auto.timer
```
