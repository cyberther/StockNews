# Faza B – design: Political Intelligence

Data: 2026-10-18 · Branch: `phase-b/policy-intelligence` · Cerințe: MASTER PROMPT secțiunea 5 (+ 8–10).
Proprietarul a ales să sară peste întrebări; tot ce e marcat **[decizia mea]** e alegerea lui Claude.

## De ce
Investitorul care urmărește acțiuni BVB află de măsuri fiscale sau legi din presă, amestecate cu
declarații și zvonuri. Produsul de lansare arată, din **surse oficiale**, ce s-a întâmplat (cu statutul
legislativ exact), ce sectoare și companii BVB ating, și dacă îl privesc pe el (Following / Portfolio).

## Obiective
1. Schema de evenimente din spec: titlu, dată, țară, instituție, inițiator/emitent, URL sursă, statut
   (declarație · proiect · adoptată · în vigoare · implementată), sectoare, date cuantificabile,
   istoric al actualizărilor, nivel de certitudine.
2. Ingestie zilnică în GitHub Actions din surse oficiale, cu clasificare **deterministă** (reguli,
   cuvinte-cheie, mapări sector → CAEN → companii BVB). Fără AI.
3. Ecran „Politici” în aplicație: cronologie, filtre pe sector și companie BVB, sursa și certitudinea
   vizibile, „Te afectează?” legat de Following și Portfolio.
4. PR #82 verificat și continuat: formula calculatorului mutată într-un modul testat.
5. Termenii de reutilizare ai fiecărei surse documentați.

## Non-obiective
- Analiza de impact economic, scenarii de buget, knowledge graph (Faza C).
- Text integral al actelor normative: se păstrează doar titlu, număr, stadiu, dată și link.
- Notificări push pentru evenimente (Faza C: „alerte când apare un eveniment legat de…”).

## Anti-obiective (eșec chiar dacă „merge”)
- O declarație sau un proiect prezentat ca lege adoptată.
- Limbaj partizan: nume de partide, adjective evaluative, „bine/rău pentru economie”.
- Legături companie–eveniment fără motiv vizibil (fiecare legătură spune „menționată” sau „prin sector X”).

## Surse (verificate pe 2026-10-18)

| Sursă | Ce citim | Acces | Fază |
|---|---|---|---|
| Camera Deputaților – inițiative înregistrate (`upl_pck2015.lista?anp=AN`) | nr. (PL-x = Guvern, Pl-x = parlamentari), titlu, stadiu („la Senat…”, „procedura încetată…”), link fișă | HTML tabelar, ~300 KB | **B** |
| Camera Deputaților – legi promulgate (`upl_pck2015.lista?anl=AN`) | nr. proiect, titlu, „Lege N/AN dată”, link lege (repertoriul cdep) | HTML tabelar, ~140 KB | **B** |
| Ministerul Finanțelor – comunicate de presă (RSS Liferay `INSTANCE_uwgr`) | titlu, rezumat, dată, link | RSS 2.0 | **B** |
| BVB – rapoarte curente | există deja: tabelul `filings` (crawler pe PC) | – | legat în UI |
| BNR – decizii de politică monetară | paginile se încarcă prin JavaScript | de găsit API/feed | ulterior |
| INS | certificat TLS invalid la 2026-10-18 (curl 60) | – | ulterior |
| Senat | stadiul apare deja în lista Camerei („la Senat”) | – | ulterior |
| Monitorul Oficial | termeni restrictivi; link spre repertoriul Camerei/legislatie.just.ro | – | ulterior |
| Eurostat | RSS „statistics update” = actualizări de seturi, nu evenimente | API | ulterior |

Termenii de reutilizare: `docs/policy-sources.md` (Legea 179/2022 + ce spune fiecare site; ce nu e clar
e marcat „de verificat juridic”).

## Model de date (Supabase, `supabase/policy.sql`)
`policy_events`: `id` text (stabil: `cdep:<idp>`, `mf:<id>`), `title`, `event_date`, `country` ('RO'),
`institution`, `initiator` ('Guvern' | 'Parlamentari' | 'Ministerul Finanțelor'), `doc_number`,
`source_url`, `status` (`statement | draft | adopted | in_force | implemented | stopped`), `stage`
(textul brut al stadiului), `sectors` text[], `caen` text[], `companies` jsonb
(`[{ticker, why:'mentioned'|'sector', sector?}]`), `figures` jsonb (`[{kind:'percent'|'amount', value,
unit, text}]`), `certainty` (`official_act | official_procedure | official_statement`), `first_seen`,
`updated_at`.
`policy_event_history`: append-only, `(event_id, changed_at, field, old_value, new_value)` – scris doar
când statusul/stadiul se schimbă.

**[decizia mea]** `stopped` (procedură încetată, respins, retras) adăugat la cele 5 statuturi din spec:
datele Camerei îl au și altfel ar trebui ascuns sau prezentat greșit.
**[decizia mea]** Citire doar pentru conturi aprobate (`is_approved()`), ca `stories`; scriere doar service role.

## Statut și certitudine (deterministe, niciodată din text liber)
| Sursa/forma | status | certainty |
|---|---|---|
| Listă „legi promulgate” cu „Lege N/AN” | `adopted` (promulgată; „în vigoare” doar când se va citi data intrării în vigoare) | `official_act` |
| Inițiativă înregistrată, în procedură | `draft` | `official_procedure` |
| Inițiativă cu „încetat/respins/retras/clasat” | `stopped` | `official_procedure` |
| Comunicat MF | `statement` | `official_statement` |
`in_force` / `implemented` există în schemă, dar nicio sursă din Faza B nu le setează (nu ghicim).
Un eveniment nu urcă niciodată în statut pe baza cuvintelor din titlu.

## Clasificare (`config/policy-taxonomy.json` + `ingest/policy/classify.mjs`)
- Text normalizat (fără diacritice, litere mici); reguli = listă de cuvinte/expresii per sector.
- Sectoare [decizia mea]: energie, petrol-gaze, utilități, bănci-financiar, asigurări-pensii, telecom,
  sănătate-farma, imobiliare-construcții, agricultură-alimentar, transport-logistică, IT,
  industrie, apărare, fiscal-general (TVA, impozit pe profit, accize — atinge toate companiile).
- Sector → secțiuni CAEN (ex. energie → D35, petrol-gaze → B06/C19, bănci → K64).
- Sector → tickere BVB (hartă statică în taxonomie, doar companiile cu activitate principală în sector).
- Companii menționate explicit: potrivirea numelor din catalogul BVB (`bvb-symbols.js` + alias-uri).
- Cifre: procente, sume (lei/euro/mil./mld.), „% din PIB” — extrase prin regex, cu textul sursă.

## UI
- Ecran „Politici” (flag `policy`, pornit), în meniul existent; păstrează tema și componentele.
- Cronologie pe zile; card: badge de statut (text fix pe statut), instituție · inițiator · nr., titlu,
  cifre extrase, sectoare, companii („menționată” / „prin sector”), certitudine, „Sursa oficială ↗”.
- Filtre: sector (chips), companie BVB (listă), „Doar ce mă afectează”.
- „Te afectează?”: intersecția companiilor evenimentului cu Following ∪ Portfolio, cu motivul.
- Link spre calculatorul de scenarii (PR #82) din ecran, sub același flag.

## Constrângeri
Tot ce e în Faza A: Node 22, `node --test`, TDD pentru parsere, clasificare, runner, logica „te afectează”;
fără chei în browser; repo public; staging întâi (fără deploy de producție); /security-review la final.

## Rollback
Flag `policy: false` ascunde ecranul; jobul de politici e un pas separat din workflow (se poate opri);
tabelele noi nu ating nimic existent.
