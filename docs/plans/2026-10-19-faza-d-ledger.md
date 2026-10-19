# Faza D – ledger

Plan: `2026-10-19-faza-d-plan.md` · Mod: Native · BASE: 98fcd60
Proprietarul: „alege tu valorile și începe faza D” — deciziile [decizia mea] din design sunt de confirmat.

| Task | Stare | Note |
|---|---|---|
| 1 Config | gata | 5/5 teste. Ruling: rândul „Analize de impact” arată „Fapte” la Gratuit și „Complete” la Pro (chei de text, nu simboluri), ca diferența să fie explicită. |
| 2 Entitlements SQL | gata | 5/5 PGlite. Ruling: stub-urile comune în `test/helpers/billing-stubs.js` (un fișier de test importat ar rula din nou). Ruling: un abonament `cancelled` rămâne Pro până la `current_period_end` (cât s-a plătit). |
| 3 Webhook SQL | gata | 6/6 PGlite. Ruling: se aplică doar obiectele `subscriptions`; evenimentele de factură (`subscription_payment_*`) se înregistrează fără aplicare — Lemon Squeezy trimite oricum `subscription_updated` cu noua dată după plată. Ruling: `on_trial` → status 'trialing' cu sursa 'payment' (aceeași subscripție), nu un rând 'trial' separat. Ruling: `paused` → 'expired' (fără acces). |
| 4 Limite și Pro pe server | gata | 4/4 PGlite + scan 7/7; suita 315/315. Ruling: filtrul Pro al alertelor e în `scan` (`onlyPro` → `pro_users`), nu în `policy_alerts_due`, ca logica de alertă să nu fie copiată în billing.sql. Ruling: dacă `pro_users` eșuează, nimeni nu e scos (o alertă în plus e mai bună decât un abonat fără alertă). Ruling: politicile pe `impact_results`/`ticker_digests` se aplică doar dacă tabelele există; `approval.sql`/`impact.sql` rulate din nou le recreează fără Pro — de rulat billing.sql după ele (scris în fișier). |
| 5 Edge Function billing | gata | 6/6; suita 321/321. Ruling: ID-urile variantelor stau în secretele funcției (`LEMONSQUEEZY_VARIANT_MONTH/YEAR`), nu în `config/billing.json` — se schimbă fără deploy și fără commit. Ruling: checkout-ul cere și cont aprobat (nu doar logat). Ruling: o eroare a bazei de date la webhook întoarce 500, ca Lemon Squeezy să reîncerce. |
| 6 Gateway licențe | gata | 16/16 gateway; suita. Ruling: licențele planurilor gratuite (Finnhub, Twelve Data, FMP, Alpha Vantage) sunt și ele `dev_only`; un plan plătit se declară prin `MARKET_LICENSE_<NUME>=commercial_display` (env), fără cod. Ruling: fluxurile RSS de presă și raportările companiilor = `headlines` (titlu + link spre sursă), rămân disponibile — de confirmat juridic. |
| 7 Client | gata | client 3/3; suita 326/326. Chromium: oprit → „Acces anticipat”, 100; Gratuit → „5 / 5”, paywall 29/290 lei, 14 zile, „Mod de test”, fără buton de plată (legalReviewed false); Pro → „Se reînnoiește pe …” + „Gestionează abonamentul”; 390 px fără scroll orizontal; 0 erori. Ruling: `ALL_ACCESS` înlocuit de `commercialMode` (flag + răspunsul serverului). Ruling: texte vechi care promiteau „întârziere 24h” pentru Gratuit corectate — nu există întârziere. |
| 8 Legal și docs | de făcut | |
| 9 Livrare | de făcut | |
