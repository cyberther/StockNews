# Faza C – ledger

Plan: `2026-10-18-faza-c-plan.md` · Mod: Native · BASE: 63a7dd7

| Task | Stare | Note |
|---|---|---|
| 1 Motor | gata | 12/12 teste. Ruling: `monthsInForce('2026-08-01',6,2027)` = 11, nu 10 (aug+6 = feb, feb–dec = 11 luni; planul greșise calculul) — cost dacă e greșit: un test. Ruling: `company()` aplică formula direct (baza = profitul operațional raportat, nu venit × marjă), refolosind `fmt` și `LIMITS` din `hif-scenario.js` — aceeași formulă, verificată de exemplul PR #82. Ruling: `resolve()` stă în `hif-impact.js` (browserul are nevoie de ea), nu în `schema.mjs`. |
| 2 Format + validator | gata | 7/7 teste. Ruling: analizele greșite se construiesc în test prin mutarea fixture-ului valid, nu ca fișiere `bad-*.json` — aceleași cazuri, mai puține fișiere. Ruling: `cost`, `gdp`, `start` sunt ipoteze obligatorii; `funded_pct` implicit 0. Ruling: adăugat `validateOutcomes`/`loadOutcomes` aici (Task 4 le consumă). |
| 3 SQL | de făcut | |
| 4 Job impact | de făcut | |
| 5 Alerte scan | de făcut | |
| 6 Conținut real | de făcut | |
| 7 UI | de făcut | |
| 8 AI intern | de făcut | |
| 9 Livrare | de făcut | |
