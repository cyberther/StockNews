# Analizele de impact

Fiecare analiză stă în `analyses/<id>/v<N>.json`. Formatul și formulele sunt în
`docs/plans/2026-10-18-faza-c-design.md` și `docs/impact-model.md`.

- **Fapte** (`facts`) au link `https://` spre sursa oficială și data sursei.
- **Ipoteze** (`assumptions`) au motiv (`why`) și interval (`range`); valoarea e în interval.
- **Rezultatele** nu se scriu de mână: jobul `impact` le calculează cu `templates/shared/hif-impact.js` și le
  îngheață în Supabase cu versiunea motorului.
- O analiză publicată **nu se modifică**: `analyses/LOCK.json` păstrează hash-ul fiecărui fișier, iar testele
  pică dacă se schimbă. O corectură înseamnă `v<N+1>.json`.
- Rezultatele observate ulterior merg în `analyses/<id>/outcomes.json` (cu sursă) și servesc la măsurarea
  acurateței.

După ce adaugi o versiune nouă: `npm run impact:lock`, `npm test`, PR.

## Analizele automate
Analizele generate noaptea din documentele oficiale (`docs/impact-model.md`, „Analize automate”) **nu** stau
aici, ci doar în Supabase (`impact_analyses.origin = 'auto'`). Ele trec prin validatorul automat în loc de
review, și au eticheta și avertismentul lor în aplicație. Analizele din acest folder rămân cele revizuite prin PR.
