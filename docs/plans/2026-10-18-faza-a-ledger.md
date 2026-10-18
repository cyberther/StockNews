# Faza A – ledger de execuție

Plan: `2026-10-18-faza-a-plan.md` · Mod: Native (executing-plans) · BASE: c469702 (main)

| Task | Stare | Commit | Note |
|---|---|---|---|
| 1 Feature flags | gata | 9695048 | Ruling: `/us-news` cu `names=` rămâne pornit (e feed-ul Following al scan-ului) — fără el, știrile US urmărite dispar; cost dacă e greșit: un feed RSS în plus/ciclu. Testul EU Market rulează cu `flags.euMarket=true`. |
| 2 Program burse | gata | (vezi git) | Sărbători nemodelate (design D2). |
| 3 Smart refresh | gata | (vezi git) | Ruling: refolosește `_lastAct` (urmărirea activității pentru blocarea automată) în loc de un al doilea set de listener-e. Tick la 60 s, doar verificare locală, fără request. |
