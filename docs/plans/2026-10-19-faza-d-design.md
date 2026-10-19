# Faza D – design: pregătirea monetizării

Data: 2026-10-19 · Branch: `phase-d/monetization` · Cerințe: MASTER PROMPT, Faza D (+ 8–10).
Proprietarul a cerut: „alege tu valorile și începe faza D”. Tot ce e marcat **[decizia mea]** e o alegere a lui
Claude, de confirmat de proprietar înainte de lansarea comercială.

## De ce
Aplicația merge acum gratuit, pentru conturi aprobate manual, cu acces complet pentru toată lumea
(`ALL_ACCESS = true`). Ca să poată fi vândută mai târziu e nevoie de patru lucruri, construite acum, dar
**oprite**:
1. Un plan pe cont, verificat **pe server**, nu în browser.
2. Plata unui abonament, testată cap-coadă în modul de test al furnizorului.
3. Un singur comutator, `COMMERCIAL_MODE`, care pornește limitele și ascunde datele fără licență comercială.
4. Textele legale pentru abonamente și un flag care blochează vânzarea până la verificarea juridică.

Cât timp `COMMERCIAL_MODE` e oprit, **nimic nu se schimbă** pentru utilizatori: toți conturile aprobate au acces
complet, ca acum.

## Obiective
1. **Entitlements în Supabase.**
   - Tabelul `entitlements` ține dreptul fiecărui cont: `plan`, `source` (`payment`, `trial`, `manual`), `status`,
     `current_period_end`.
   - `public.current_plan(uid)` și `public.is_pro()` sunt singura sursă de adevăr; RLS, triggerele și funcțiile
     le folosesc.
2. **Plăți prin Lemon Squeezy, în modul de test.**
   - Checkout-ul e creat de o Edge Function `billing`, cu cheia API pe server.
   - Webhook-ul e verificat prin semnătura HMAC și aplicat printr-o funcție SQL idempotentă.
   - Abonamentul se gestionează din portalul clientului Lemon Squeezy.
3. **`COMMERCIAL_MODE`.** Un singur comutator, în `config/flags.json` (aplicația, ingestia, gateway-ul) și în
   `app_config` (baza de date). Când e pornit:
   - limitele planului Gratuit se aplică pe server;
   - funcțiile Pro cer abonament;
   - furnizorii `dev_only` (Yahoo) nu mai sunt folosiți, nici în ingestie, nici în gateway.
4. **Pregătire legală.**
   - Termenii pentru abonamente: dreptul de retragere, rambursări, procesatorul de plăți.
   - Flag-ul `legalReviewed: false` blochează checkout-ul chiar și cu `COMMERCIAL_MODE` pornit.

## Non-obiective
- Plăți reale, prețuri publicate, conturi la furnizori de date. Le face proprietarul, după decizie.
- Furnizor comercial de date implementat (EODHD / Twelve Data). Rămân stub-uri, cum sunt din Faza A; adaptorul
  se scrie când există cheie și licență.
- Facturare proprie, TVA, contabilitate: le face furnizorul de plăți, ca „merchant of record”.
- Cupoane, referral, planuri pentru echipe.

## Anti-obiective (eșec chiar dacă „merge”)
- O funcție Pro deschisă din browser, pentru că verificarea era doar în interfață.
- Un webhook acceptat fără semnătură validă sau aplicat de două ori (de exemplu, două luni prelungite).
- Un utilizator existent care pierde acces cât `COMMERCIAL_MODE` e oprit.
- Chei (API, webhook) în browser sau în repo-ul public.
- Date Yahoo afișate într-un produs plătit.

## Decizii

| # | Decizie | Motiv |
|---|---|---|
| D1 | **[decizia mea]** **Lemon Squeezy** ca furnizor. Adaptorul e izolat (`supabase/functions/billing/lemon.js`), ca Paddle să poată fi pus în loc fără schimbări în SQL sau în aplicație. | E „merchant of record”: încasează, se ocupă de TVA-ul UE, facturi și rambursări. Are mod de test, webhook-uri semnate HMAC-SHA256 și portal de client gata făcut. E cel mai simplu pentru o persoană sau o firmă mică din RO. |
| D2 | **[decizia mea]** Două planuri: **Gratuit** și **Pro**. Pro costă **29 lei/lună** sau **290 lei/an** (2 luni gratuite), cu **14 zile de probă**. Moneda e RON; dacă magazinul nu acceptă RON, se folosesc 6 € și 60 €. | Publicul e român. Prețul e sub un abonament de presă financiară; anualul recompensează fidelitatea. |
| D3 | **[decizia mea]** **Gratuit:** 5 tickere urmărite, 5 poziții, fluxul de știri, rezumatele `.RO`, ecranul Politici (toate evenimentele, sursele, „Te afectează”), faptele și ipotezele analizelor, grafic până la 6 luni. **Pro:** 100 de tickere și poziții, alerte push (știri și politici), rezultatele analizelor (scenarii, efect pe companii și portofoliu, formule), calculatorul precompletat, rezumatul zilei, grafic YTD / 1 an / 5 ani, istoricul de acuratețe. | Informația oficială rămâne gratuită (încredere, misiune). Plătit e ce costă de rulat (alerte, model local) sau cere muncă de analiză. |
| D4 | `public.is_pro()` întoarce **true** pentru orice cont aprobat cât `app_config.commercial_mode = false`. | Un singur comutator. Fără pierderi de acces până la lansare; `ALL_ACCESS` din client dispare. |
| D5 | Logica webhook-ului e în **SQL** (`billing_apply(payload)`, doar `service_role`), testată în PGlite. Edge Function doar verifică semnătura și o cheamă. | Ca la alertele de politici (Faza C): logica importantă e testabilă; funcția Deno rămâne subțire. |
| D6 | Idempotență: `billing_events` cu hash-ul corpului (sha256) ca cheie primară, iar un eveniment mai vechi decât ultimul aplicat (`updated_at` al abonamentului) e ignorat. | Lemon Squeezy reîncearcă webhook-urile și le poate trimite în altă ordine. |
| D7 | Checkout-ul e creat prin API, de Edge Function, cu `custom_data.user_id` din JWT-ul verificat, nu din browser. Clientul primește doar URL-ul de checkout. | Un utilizator nu poate plăti în contul altcuiva și nu vede cheia API. |
| D8 | Gateway-ul primește câmpul `license` pe furnizori (ca ingestia). Cu `commercialMode`, furnizorii `dev_only` sunt excluși; fără un furnizor licențiat, răspunsul e 503 „no licensed provider”. | Aceeași regulă ca în Faza A, acum și pentru grafice și căutare. |
| D9 | Flag-ul `legalReviewed` (implicit `false`) ascunde butonul de plată și face Edge Function să refuze crearea checkout-ului. | Nicio vânzare înainte de verificarea juridică. |

## Date (Supabase, `supabase/billing.sql`)
- **`app_config`** (key, value jsonb), cu cheia `commercial_mode` = false. Se citește prin
  `public.commercial_mode()`; doar `service_role` scrie.
- **`entitlements`**, cu cheia primară (user_id, source):
  - `plan` ('pro'), `status` ('active' | 'trialing' | 'past_due' | 'cancelled' | 'expired'), `current_period_end`;
  - `provider`, `customer_id`, `subscription_id`, `portal_url`, `provider_updated_at`.
  - Citire: proprii; scriere: doar `service_role` și funcțiile admin.
- **`billing_events`**: (hash pk, event_name, subscription_id, received_at, applied bool, note). Doar `service_role`.
- **`current_plan(uid)`**: 'pro' dacă există un drept activ — `status in ('active','trialing','past_due')` și
  `current_period_end > now()`, sau `source = 'manual'` fără dată de sfârșit. Altfel 'free'.
- **`is_pro()`**: `not commercial_mode() or current_plan(auth.uid()) = 'pro'`, pentru conturi aprobate.
- **`my_plan()`**: întoarce browserului {plan, source, status, period_end, portal_url, commercial, limits}.
- **`admin_grant_pro(user, until)` / `admin_revoke_pro(user)`**: verifică `is_admin()`; pentru acces dat manual.
- **Limite pe server, active doar cu `commercial_mode`:** triggerele `watchlist_cap` și `holdings_cap` folosesc
  5 pentru Gratuit și 100 pentru Pro.
- **Funcții Pro pe server, active doar cu `commercial_mode`:**
  - RLS pe `impact_results` și `analysis_accuracy` cere `is_pro()`;
  - `policy_alerts_due` și alertele de știri (scan) se trimit doar conturilor Pro;
  - `ticker_digests` cere `is_pro()`.
- **Cache:** `account_status.plan` se actualizează din `entitlements`, printr-un trigger, pentru afișare.

## Webhook (Lemon Squeezy → `billing_apply`)
| Eveniment | Efect |
|---|---|
| `subscription_created`, `subscription_updated`, `subscription_resumed`, `subscription_unpaused` | upsert `entitlements(source='payment')` cu status, `renews_at`/`ends_at` → `current_period_end` și `portal_url` |
| `subscription_cancelled` | status 'cancelled'; accesul rămâne până la `ends_at` |
| `subscription_expired` | status 'expired', iar `current_period_end` = acum |
| `subscription_payment_failed` | status 'past_due'; accesul rămâne până la `current_period_end` (grație) |
| `subscription_payment_success`, `subscription_payment_recovered` | status 'active' |
| altele | înregistrate în `billing_events`, `applied = false` |

Contul se identifică prin `meta.custom_data.user_id`, care trebuie să existe în `auth.users`. Altfel evenimentul
e înregistrat cu nota „unknown user” și nu se aplică. Probele (`trial_ends_at`) se mapează la status 'trialing'.

## UI
- **Planul vine din `my_plan()`, nu din `ALL_ACCESS`.** Cu `commercial: false`, eticheta rămâne „Acces anticipat” și
  nimic nu e blocat.
- **Paywall:**
  - tabelul Gratuit / Pro din `config/billing.json` (aceeași sursă ca limitele);
  - prețurile lunar și anual, plus perioada de probă;
  - butonul „Începe proba de 14 zile” cheamă `billing?action=checkout&interval=month|year` și deschide URL-ul primit;
  - banda „Mod de test – nu se încasează bani” când furnizorul e în test;
  - butonul e ascuns dacă `legalReviewed` e false.
- **Cont:** planul, sursa, data reînnoirii sau a expirării și butonul „Gestionează abonamentul” (`portal_url`).
- **Admin:** pe lângă cereri, „Dă Pro” și „Retrage Pro” pentru un cont, cu durată.
- **Textele** sunt în RO, EN și DE.

## Legal (`templates/stock-news-web/legal.html`)
Secțiuni noi:
- „Abonamente și plăți”: Lemon Squeezy, ca merchant of record, emite factura și încasează TVA-ul.
- „Dreptul de retragere”: 14 zile; renunțarea expresă la conținut digital furnizat imediat, cu bifa la checkout.
- „Rambursări”.
- „Procesatori de date”: Lemon Squeezy, Supabase, Cloudflare.

Fiecare e marcată „de verificat juridic” până la `legalReviewed: true`.

## Flag-uri
| Flag | Valoare | Ce face |
|---|---|---|
| `commercialMode` | false (există) | limite, funcții Pro, fără furnizori `dev_only`; în DB: `app_config.commercial_mode` |
| `billing` | true | paywall-ul real, contul cu abonament (fără efect cât `commercialMode` e false, în afara afișării) |
| `legalReviewed` | false | permite checkout-ul |

## Configurare (de făcut de proprietar, fără costuri în test)
1. Cont Lemon Squeezy și magazin în **Test mode**.
2. Produsul „Market Pulse Pro”, cu două variante (lunar, anual) și probă de 14 zile.
3. Webhook spre `https://<proiect>.supabase.co/functions/v1/billing?action=webhook`, cu evenimentele din tabel și
   un secret de semnare.
4. Secretele în Supabase, setate cu un script fără afișare: `LEMONSQUEEZY_API_KEY` (test),
   `LEMONSQUEEZY_WEBHOOK_SECRET`, `LEMONSQUEEZY_STORE_ID`.
5. ID-urile variantelor în `config/billing.json`.

## Constrângeri
Cele din fazele anterioare:
- TDD pentru entitlements, webhook și limite (fazele cer TDD pentru entitlements);
- PGlite pentru SQL;
- fără chei în browser sau în repo;
- staging întâi, iar producția doar la cerere;
- `/security-review` obligatoriu, pentru că faza atinge plăți, acces și RLS.

## Rollback
`commercialMode: false` (implicit) și `app_config.commercial_mode = false` readuc comportamentul de azi.
`billing: false` ascunde paywall-ul real. Tabelele noi nu ating datele existente.
