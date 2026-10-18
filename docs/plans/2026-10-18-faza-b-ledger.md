# Faza B – ledger

Plan: `2026-10-18-faza-b-plan.md` · Mod: Native · BASE: 4f55c4a

| Task | Stare | Note |
|---|---|---|
| 1 Schema | gata | PGlite; helper comun `test/helpers/supabase-pg.js`. Aplicat în Supabase 2026-10-18 (RLS verificat din afară: anon refuzat). |
| 2 Parsere | gata | Ruling: stadiile reale „Lege N/AN”, „adoptat”, „la promulgare” → `adopted` (cu/ fără act); „sesizare de neconstituționalitate” → `draft`. Verificat pe 679 + 203 rânduri reale. |
| 3 Clasificator | gata | Ruling: cuvinte prea generale scoase după rularea pe date reale (asigurarea, terenuri, vin, asf). Acoperire: 28% din inițiativele 2026. |
| 4 Runner | gata | Ruling: comparație cu chei sortate (jsonb reordonează). Dry-run real: 1.483 evenimente, 5 cereri. |
| 5 Ecran Politici | gata | Ruling: Registrul trece în „Mai mult” pe telefon. Verificat în Chromium desktop + 390 px, fără erori. |
| 6 PR #82 | gata | Formula în `hif-scenario.js`, testată; pagina verificată în browser. |
| 7 Documentare | gata | `docs/policy-sources.md`; termeni neidentificați pe site-uri → „de verificat juridic”. |
