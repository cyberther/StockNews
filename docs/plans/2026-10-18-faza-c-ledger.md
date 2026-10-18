# Faza C – ledger

Plan: `2026-10-18-faza-c-plan.md` · Mod: Native · BASE: 63a7dd7

| Task | Stare | Note |
|---|---|---|
| 1 Motor | gata | 12/12 teste. Ruling: `monthsInForce('2026-08-01',6,2027)` = 11, nu 10 (aug+6 = feb, feb–dec = 11 luni; planul greșise calculul) — cost dacă e greșit: un test. Ruling: `company()` aplică formula direct (baza = profitul operațional raportat, nu venit × marjă), refolosind `fmt` și `LIMITS` din `hif-scenario.js` — aceeași formulă, verificată de exemplul PR #82. Ruling: `resolve()` stă în `hif-impact.js` (browserul are nevoie de ea), nu în `schema.mjs`. |
| 2 Format + validator | gata | 7/7 teste. Ruling: analizele greșite se construiesc în test prin mutarea fixture-ului valid, nu ca fișiere `bad-*.json` — aceleași cazuri, mai puține fișiere. Ruling: `cost`, `gdp`, `start` sunt ipoteze obligatorii; `funded_pct` implicit 0. Ruling: adăugat `validateOutcomes`/`loadOutcomes` aici (Task 4 le consumă). |
| 3 SQL | gata | 11/11 teste PGlite. Ruling: `policy_alerts_mark(p_until)` marchează tot ce aștepta până la momentul calculului (în loc de liste de id-uri) — fără rânduri rămase nemarcate; cost dacă e greșit: un rând apărut între calcul și marcare e marcat doar dacă e mai vechi decât p_until (nu e). Ruling: coloana de rezultate se numește `vals` (`values` e cuvânt rezervat). Ruling: `ai_annotations_save` e executabil de anon/authenticated ca `summaries_save` (protejat de secret), pentru că jobul de pe PC folosește cheia anon. Ruling: backfill-ul `alerted_at` rulează doar când coloana e adăugată, ca o re-rulare a scriptului să nu înghită alertele în așteptare. |
| 4 Job impact | gata | 8/8 teste; suita 261/261; dry-run real: 0 analize, 0 erori. Ruling: rezultatele lipsă (cifre adăugate ulterior sau motor nou) se adaugă ca rânduri noi; cele existente nu se ating — înghețarea rămâne, istoricul crește. Ruling: după politici și impact, jobul cere încă o dată `scan?mode=alerts`, altfel alertele zilei ar pleca abia a doua zi lucrătoare (vineri seara → luni). Ruling: un fișier neblocat/invalid nu oprește celelalte analize. |
| 5 Alerte scan | de făcut | |
| 6 Conținut real | de făcut | |
| 7 UI | de făcut | |
| 8 AI intern | de făcut | |
| 9 Livrare | de făcut | |
