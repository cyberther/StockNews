# Faza A – ledger de execuție

Plan: `2026-10-18-faza-a-plan.md` · Mod: Native (executing-plans) · BASE: c469702 (main)

| Task | Stare | Commit | Note |
|---|---|---|---|
| 1 Feature flags | gata | 9695048 | Ruling: `/us-news` cu `names=` rămâne pornit (e feed-ul Following al scan-ului) — fără el, știrile US urmărite dispar; cost dacă e greșit: un feed RSS în plus/ciclu. Testul EU Market rulează cu `flags.euMarket=true`. |
| 2 Program burse | gata | (vezi git) | Sărbători nemodelate (design D2). |
| 3 Smart refresh | gata | (vezi git) | Ruling: refolosește `_lastAct` (urmărirea activității pentru blocarea automată) în loc de un al doilea set de listener-e. Tick la 60 s, doar verificare locală, fără request. |
| 4 Schema Supabase | gata | ba67bf3 | Testat pe PGlite cu rolurile/grant-urile Supabase. Ruling (D5): `anon` nu vede `dev_only`. |
| 5 Furnizori/breaker/buget | gata | a7ba8f3 | `yahoo-finance2@4.0.3` fixat (4.0.4 avea 3 zile). |
| 6 Runner ingestie | gata | 4e1f1d5 | Ruling: CLI-ul e `ingest/main.mjs` (planul spunea `run.mjs`), ca `run.mjs` să rămână testabil fără rețea. Ruling: știri la 30 min și doar pentru regiunea cu bursa deschisă — la 15 min proiecția dădea ~1.500 citiri RSS/zi. Dry-run real: 27 simboluri, 9 cereri Yahoo, 29 RSS. |
| 7 scan alerts | gata | 56097bc | Deno indisponibil: sintaxă verificată prin `stripTypeScriptTypes`; comportament de verificat după deploy. |
| 8 Client Supabase | gata | a681a3f | Fără fallback la gateway în modul supabase. |
| 9 Actions | gata | 03eec47 | Toate oprite până la `INGEST_ENABLED=true`. YAML validat cu parser; actionlint indisponibil. |
| 10 Cloudflare Pages | gata | 854bc9d | Verificat local în workerd (`wrangler pages dev`): static, config.json, funcție, „feature on hold”, CSP. Ruling: pagină de forward pentru URL-ul cu litere mici în loc de regulă `_redirects` (risc de buclă cu redirect-ul `.html`). |
| 11 Măsurare/verificare | gata | 4502b62 | Măsurarea în browser a găsit cereri repetate `profile2`/`chart` și refresh imediat după deschidere → corectate. Verificare vizuală desktop + 390 px. /security-review: 0 constatări ≥ 8/10. |
