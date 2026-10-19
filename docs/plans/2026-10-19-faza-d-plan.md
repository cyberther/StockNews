# Faza D – plan de implementare

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (Native, ca în fazele A–C).
> Progres: `docs/plans/2026-10-19-faza-d-ledger.md`. Steps use checkbox (`- [ ]`) syntax.

**Goal:** planuri verificate pe server, abonament Lemon Squeezy în modul de test și comutatorul `COMMERCIAL_MODE`.
Cât timp comutatorul e oprit, nimic nu se schimbă pentru utilizatori.

**Architecture:**
- Dreptul de acces e în `entitlements`; `current_plan` / `is_pro()` sunt singura sursă de adevăr.
- Webhook-ul e verificat în Edge Function `billing` și aplicat de `billing_apply` (SQL).
- Limitele și funcțiile Pro sunt aplicate pe server doar când `commercial_mode()` e true.
- Clientul citește planul din `my_plan()`.

**Tech Stack:** Node 22, `node --test`, PGlite 0.5.8, Supabase Edge (Deno), Web Crypto, Lemon Squeezy API (test).
**Spec:** `docs/plans/2026-10-19-faza-d-design.md`

## Global Constraints
- **Prețuri și limite** stau într-o singură sursă, `config/billing.json`: Pro 29 lei/lună, 290 lei/an, 14 zile de probă;
  limite Gratuit 5 / Pro 100 (tickere, poziții).
- **`COMMERCIAL_MODE` implicit oprit**, atât în `config/flags.json`, cât și în `app_config`. Oprit înseamnă că orice cont
  aprobat e Pro.
- **Chei:** niciuna în browser sau în repo. Secretele Lemon Squeezy stau doar în secretele Supabase.
- **Webhook:**
  - semnătura `X-Signature` = HMAC-SHA256 hex al corpului brut, cu `LEMONSQUEEZY_WEBHOOK_SECRET`, comparată în timp
    constant;
  - un webhook nesemnat sau semnat greșit primește 401 și nu se aplică.
- **Idempotență:** cheia e hash-ul sha256 al corpului; un eveniment cu `updated_at` mai vechi decât cel aplicat e ignorat.
- **Contul plătitor:** checkout-ul primește `user_id` doar din JWT-ul verificat de Edge Function.

## Review Focus
1. **Același webhook trimis de două ori**, sau unul vechi venit după unul nou → o singură aplicare, starea cea mai
   nouă rămâne. (Task 3)
2. **`COMMERCIAL_MODE` oprit** → utilizatorii existenți păstrează tot: 100 de tickere, alerte, rezultatele analizelor.
   (Task 2, 4)
3. **Abonament anulat** → acces până la `ends_at`, apoi Gratuit; tickerele peste limită rămân, dar nu se pot adăuga
   altele. (Task 3, 4)
4. **`user_id` necunoscut** în `custom_data` → evenimentul e înregistrat și nu se aplică nimănui. (Task 3)
5. **Checkout cerut fără login, fără `legalReviewed` sau fără cheie configurată** → refuz clar, fără URL. (Task 5)

---

### Task 1: Configurare (`config/billing.json`, flag-uri)
**Files:**
- create `config/billing.json`, `templates/shared/hif-billing.js` (copia pentru browser, ca `hif-flags.js`),
  `test/billing-config.test.js`;
- modify `config/flags.json`, `templates/shared/hif-flags.js` (`billing: true`, `legalReviewed: false`), `test/flags.test.js`.

**Interfaces:** `HIFBilling.CONFIG` = { provider, testMode, currency, trialDays, prices:{month, year}, limits:{free:{tickers,
positions}, pro:{…}}, features:[{key, free, pro}], variants:{month:null, year:null} }; `HIFBilling.limits(plan)`.

- [ ] **Teste:**
  - copia din browser e identică cu `config/billing.json`;
  - prețurile sunt pozitive, iar anualul e < 12 × lunarul;
  - limita Gratuit < limita Pro ≤ 100 (plafonul din triggerele existente);
  - fiecare funcție are etichete RO/EN/DE în `hif-data.js`.
- [ ] Commit.

### Task 2: Entitlements în SQL (`supabase/billing.sql`)
**Files:** `supabase/billing.sql`, `test/billing-sql.test.js`, folosind stub-urile din `test/impact-sql.test.js`
(`is_admin`, `watchlist`, `holdings`, `auth.users`).

**Interfaces:**
- `commercial_mode() → bool`
- `current_plan(uid) → text`
- `is_pro() → bool`
- `my_plan() → jsonb`
- `admin_grant_pro(p_user uuid, p_until timestamptz) → int`
- `admin_revoke_pro(p_user uuid) → int`

- [ ] **Teste:**
  - cu `commercial_mode` oprit, `is_pro()` e true pentru aprobat și false pentru neaprobat;
  - cu modul pornit:
    - fără drept → 'free';
    - `active` cu `period_end` în viitor → 'pro';
    - `period_end` trecut → 'free';
    - `past_due` în perioadă → 'pro';
    - `manual` fără dată → 'pro';
  - `my_plan()` întoarce limitele planului;
  - browserul nu scrie în `entitlements` / `app_config`;
  - admin_grant/revoke cer `is_admin()`;
  - `account_status.plan` urmează dreptul (trigger);
  - scriptul se poate rula de două ori.
- [ ] Commit.

### Task 3: Webhook în SQL (`billing_apply`)
**Files:** `supabase/billing.sql`, `test/billing-webhook-sql.test.js`, fixture-uri `test/fixtures/billing/*.json`
(forma payload-urilor Lemon Squeezy: `meta.event_name`, `meta.custom_data.user_id`, `data.id`,
`data.attributes.{status, renews_at, ends_at, trial_ends_at, updated_at, customer_id, urls.customer_portal}`).

**Interfaces:** `billing_apply(p_hash text, p_payload jsonb) → jsonb {applied, note}`, doar `service_role`.

- [ ] **Teste:**
  - created (trial) → 'trialing' până la `trial_ends_at`;
  - payment_success → 'active' până la `renews_at`;
  - cancelled → acces până la `ends_at`; expired → 'free';
  - payment_failed → 'past_due', dar tot Pro până la sfârșitul perioadei;
  - același hash de două ori → a doua oară `applied: false, note: 'duplicate'`;
  - un `updated_at` mai vechi → 'stale', fără schimbări;
  - user necunoscut → 'unknown user';
  - un eveniment nemapat → înregistrat, neaplicat;
  - `authenticated` nu poate chema funcția.
- [ ] Commit.

### Task 4: Limite și funcții Pro pe server (doar cu `commercial_mode`)
**Files:** `supabase/billing.sql` (redefinește `watchlist_cap`, `holdings_cap`, politicile pe `impact_results` /
`ticker_digests`, filtrul Pro în `policy_alerts_due`, funcția nouă `pro_users(uuid[])` pentru scan),
`supabase/functions/scan/index.ts` (alertele de știri doar spre `pro_users` când e modul comercial),
`test/billing-gates-sql.test.js`, `test/scan-alerts.test.js`.

- [ ] **Teste:**
  - cu modul oprit: 100 de tickere pentru oricine, iar rezultatele analizelor se văd;
  - cu modul pornit:
    - gratuitul poate avea 5 tickere și e refuzat la al 6-lea;
    - un Pro poate avea până la 100;
    - gratuitul nu vede `impact_results` / `ticker_digests`, Pro le vede;
    - `policy_alerts_due` omite gratuitul;
  - `pro_users` returnează toți utilizatorii primiți cât modul e oprit;
  - scan: alertele de știri trec prin `pro_users` (test de structură, ca la Faza C).
- [ ] Commit.

### Task 5: Edge Function `billing`
**Files:** `supabase/functions/billing/lemon.js` (logică pură, importabilă din Deno și Node),
`supabase/functions/billing/index.ts`, `test/billing-lemon.test.js`.

**Interfaces:**
- `verifySignature(rawBody, header, secret) → Promise<bool>`
- `bodyHash(rawBody) → Promise<hex>`
- `checkoutRequest({storeId, variantId, userId, email, testMode, redirectUrl}) → {url, init}`
- `checkoutUrl(json) → string|null`

**Rute:**
- `POST ?action=webhook`: semnătura, apoi `billing_apply`; 200 sau 401.
- `POST ?action=checkout&interval=month|year`, cu JWT: verifică userul prin `auth.getUser`, refuză fără
  `LEGAL_REVIEWED=true` sau fără cheie, cheamă API-ul Lemon Squeezy și întoarce {url}.

- [ ] **Teste:**
  - semnătura corectă trece, una greșită, una lipsă și un corp modificat sunt refuzate;
  - hash-ul e stabil;
  - cererea de checkout:
    - poartă `custom.user_id` și `test_mode`;
    - nu poartă alte date ale userului în afară de email;
    - conține variantele din config;
  - sintaxa TS e validă;
  - fără `LEGAL_REVIEWED` → 403 (test de structură);
  - nicio cheie nu apare în răspunsuri sau în log-uri (test de structură).
- [ ] Commit. Deploy-ul se face în Task 9.

### Task 6: Gateway cu licențe
**Files:** `netlify/functions/_shared/market/gateway.js` (câmpul `license` pe furnizori, filtrul în `fetchCapability` cu
`commercialMode`), `test/market-gateway.test.js`.

- [ ] **Teste:**
  - cu modul oprit, Yahoo răspunde ca acum;
  - cu modul pornit, Yahoo nu e folosit, iar fără furnizor licențiat răspunsul e 503 „no licensed provider”;
  - flag-ul vine din `hif-flags.js` (ca `onHold`).
- [ ] Commit.

### Task 7: Client: plan, paywall, cont, admin
**Files:**
- `templates/shared/hif-billing.js` (`load()` → `my_plan()`, `checkout(interval)`);
- `templates/stock-news-web/StockNewsWeb.dc.html`: planul vine din `my_plan`, se înlocuiește `ALL_ACCESS`; paywall
  real, cont, admin grant / revoke;
- `templates/shared/hif-data.js` (texte RO/EN/DE);
- `test/billing-client.test.js`.

- [ ] **Teste:**
  - `load` face un singur RPC;
  - `checkout` cheamă funcția cu JWT și întoarce URL-ul sau eroarea;
  - limita de tickere din client vine din config.
- [ ] **Browser** (desktop și 390 px, Supabase simulat):
  - cu modul oprit: „Acces anticipat” și nimic blocat;
  - cu modul pornit și Gratuit: limita 5, paywall cu prețuri și banda „Mod de test”, fără buton de plată cât
    `legalReviewed` e false;
  - Pro: data reînnoirii și „Gestionează abonamentul”;
  - 0 erori.
- [ ] Commit.

### Task 8: Legal și documentație
**Files:**
- `templates/stock-news-web/legal.html` (abonamente, retragere, rambursări, procesatori; marcate „de verificat juridic”);
- `docs/phase-d-setup.md` (pașii din Lemon Squeezy, webhook, secrete, variante, ce face fiecare comutator);
- un script pentru secrete, fără afișare (scratchpad, ca la tokenul GitHub).
- [ ] Testul existent al paginii legale trece, iar textele noi apar în RO/EN/DE. Commit.

### Task 9: Livrare
- [ ] `npm test`.
- [ ] `billing.sql` aplicat în Supabase, cu `commercial_mode` = false. Verificare:
  - `my_plan()` pentru contul proprietarului dă 'pro', sursa „early access”;
  - anon e refuzat.
- [ ] Edge Function `billing` deployată, fără secrete Lemon Squeezy: webhook-ul fără semnătură primește 401, iar
  checkout-ul primește 403 / 503 clar.
- [ ] `scan` redeployată.
- [ ] Staging actualizat și verificat.
- [ ] `/security-review`, apoi PR fără merge.
