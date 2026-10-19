# Faza D – ledger

Plan: `2026-10-19-faza-d-plan.md` · Mod: Native · BASE: 98fcd60
Proprietarul: „alege tu valorile și începe faza D” — deciziile [decizia mea] din design sunt de confirmat.

| Task | Stare | Note |
|---|---|---|
| 1 Config | gata | 5/5 teste. Ruling: rândul „Analize de impact” arată „Fapte” la Gratuit și „Complete” la Pro (chei de text, nu simboluri), ca diferența să fie explicită. |
| 2 Entitlements SQL | gata | 5/5 PGlite. Ruling: stub-urile comune în `test/helpers/billing-stubs.js` (un fișier de test importat ar rula din nou). Ruling: un abonament `cancelled` rămâne Pro până la `current_period_end` (cât s-a plătit). |
| 3 Webhook SQL | gata | 6/6 PGlite. Ruling: se aplică doar obiectele `subscriptions`; evenimentele de factură (`subscription_payment_*`) se înregistrează fără aplicare — Lemon Squeezy trimite oricum `subscription_updated` cu noua dată după plată. Ruling: `on_trial` → status 'trialing' cu sursa 'payment' (aceeași subscripție), nu un rând 'trial' separat. Ruling: `paused` → 'expired' (fără acces). |
| 4 Limite și Pro pe server | de făcut | |
| 5 Edge Function billing | de făcut | |
| 6 Gateway licențe | de făcut | |
| 7 Client | de făcut | |
| 8 Legal și docs | de făcut | |
| 9 Livrare | de făcut | |
