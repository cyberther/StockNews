# Faza D – configurare și comutatoare

Design: `docs/plans/2026-10-19-faza-d-design.md`. Nimic din acest ghid nu încasează bani: magazinul rămâne în
**Test mode** până la decizia proprietarului.

## Comutatoarele

| Comutator | Unde | Implicit | Când e pornit |
|---|---|---|---|
| `commercialMode` | `config/flags.json` (aplicația, ingestia, gateway-ul) | `false` | intră în vigoare limitele planului Gratuit și funcțiile Pro; furnizorii de date `dev_only` (Yahoo) nu mai sunt folosiți |
| `commercial_mode` | tabelul `app_config` din Supabase | `false` | aceleași reguli, pe server: RLS, limite, alerte |
| `legalReviewed` | `config/flags.json` | `false` | apare butonul de plată în aplicație |
| `LEGAL_REVIEWED` | secret al funcției `billing` | lipsă | funcția acceptă crearea unui checkout |
| `LEMONSQUEEZY_TEST_MODE` | secret al funcției `billing` | `true` | checkout-urile sunt de test |

Cele două comutatoare `commercial` se pornesc **împreună**:
- primul prin PR și deploy;
- al doilea în SQL: `update public.app_config set value = 'true' where key = 'commercial_mode';`.

Cât timp sunt oprite, orice cont aprobat are acces complet, ca înainte.

## Lemon Squeezy, în Test mode (fără costuri)
1. Cont pe [lemonsqueezy.com](https://www.lemonsqueezy.com), magazin nou. Comutatorul **Test mode** rămâne pornit.
2. **Products → New product** „Market Pulse Pro”, abonament, cu două variante:
   - **Lunar:** 29 RON (sau 6 €, dacă magazinul nu are RON), cu perioadă de probă de 14 zile;
   - **Anual:** 290 RON (sau 60 €), cu aceeași perioadă de probă.

   Notează **ID-ul magazinului** și **ID-urile celor două variante** (Settings → Stores; în pagina variantei).
3. **Settings → API → New key**. Cheia de test se afișează o singură dată.
4. **Settings → Webhooks → New webhook**:
   - URL: `https://vadfmyqdpkddsobbmgsr.supabase.co/functions/v1/billing?action=webhook`;
   - un **signing secret** inventat de tine (20–40 de caractere aleatoare);
   - evenimentele: `subscription_created`, `subscription_updated`, `subscription_cancelled`, `subscription_resumed`,
     `subscription_expired`, `subscription_paused`, `subscription_unpaused`, `subscription_payment_success`,
     `subscription_payment_failed`, `subscription_payment_recovered`.
5. Secretele în Supabase, cu scriptul primit în conversație. Acesta citește cheia și secretul fără să le afișeze și
   setează:
   - `LEMONSQUEEZY_API_KEY`, `LEMONSQUEEZY_WEBHOOK_SECRET`, `LEMONSQUEEZY_STORE_ID`;
   - `LEMONSQUEEZY_VARIANT_MONTH`, `LEMONSQUEEZY_VARIANT_YEAR`;
   - `LEMONSQUEEZY_TEST_MODE=true`.

## Încercarea cap-coadă (tot în test)
Merge doar pe staging, cu ambele comutatoare `commercial` pornite, plus `legalReviewed` / `LEGAL_REVIEWED`. Doar
pentru încercare; după test se opresc la loc.

1. Paywall → „Începe perioada de probă” → checkout Lemon Squeezy cu cardul de test `4242 4242 4242 4242`.
2. În Supabase, `select * from billing_events order by received_at desc` arată `subscription_created` aplicat.
   `select public.current_plan('<id-ul tău>')` dă `pro`.
3. Contul arată „Perioadă de probă până la …” și butonul „Gestionează abonamentul”.
4. Anularea din portal duce la „Activ până la …”, apoi la planul Gratuit la data respectivă.

## Ce rămâne înainte de lansarea comercială
- Verificarea juridică a secțiunii „Abonamente și plăți”, marcată acum „ciornă”, și a surselor.
- Un furnizor de date cu licență de afișare comercială: Twelve Data sau EODHD pentru prețuri și grafice, licența BVB
  pentru timp real. Fără el, cu `commercialMode` pornit, graficele răspund „no licensed provider”. Un plan plătit se
  declară cu `MARKET_LICENSE_<NUME>=commercial_display` în variabilele Cloudflare.
- Formularul de contact folosește Netlify Forms; pe Cloudflare are nevoie de alt mecanism.
