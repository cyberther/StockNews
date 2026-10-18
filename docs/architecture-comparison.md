# Comparația de arhitecturi (Faza A)

Data: 2026-10-18. Scop: alegerea platformei pentru Market Pulse după epuizarea creditelor Netlify, cu
monetizare legală mai târziu. **Prețurile sunt cele cunoscute la data scrierii și nu au fost
reverificate pe site-urile furnizorilor; marcate „de verificat” înainte de orice decizie de cost.**

## Ipoteze (afișate, nu măsurate)
- Trafic: 1–50 utilizatori activi în Faza A/B; sute în primul an.
- Watchlist-uri: ~30–150 de simboluri unice în total (reuniunea Following + Portfolio + top BVB).
- Cereri de date: ingestie la 15 min în orele de bursă (≈60 rulări/zi lucrătoare) + un job EOD.
- Cererile per vizitator: doar statice + Supabase (PostgREST), fără funcții per vizitator.

## Variante

| | A. Netlify + Supabase (azi) | B. VPS (ex. Hetzner CX22) | C. PC Ubuntu self-hosted | **D. Cloudflare Pages + GitHub Actions + Supabase** |
|---|---|---|---|---|
| Cost lunar (Faza A) | Free epuizat → plan plătit (~19–20 $/lună, de verificat) | ~4–6 €/lună (de verificat) + timp de administrare | ~0 € direct; curent, internet, risc | **0 €** în limitele gratuite |
| Uz comercial pe planul gratuit | Da, dar creditele limitează funcțiile | Da | Da | Da (Pages Free permite uz comercial) |
| Cost per vizitator | o invocare de funcție per refresh (1–3 s) | CPU propriu | CPU propriu | **zero funcții** pentru cotații/știri; static nelimitat |
| Disponibilitate | bună | bună, dar un singur server | depinde de curent/internet acasă | bună (CDN + Supabase + Actions) |
| Securitate / mentenanță | scăzută | **ridicată** (patch-uri, firewall, TLS, backup) | ridicată + expunerea rețelei de acasă | scăzută |
| Limite relevante | credite (atinse) | resursele VM-ului | upload-ul de acasă | Pages Functions 100k/zi; Supabase Free 500 MB, pauză după 7 zile fără activitate; Actions pe repo public fără limită de minute |
| Lock-in | mediu (funcții Netlify) | mic | mic | mic: build static, funcția e un adaptor subțire peste același gateway |

## Riscuri ale variantei D și ce le acoperă
1. **Cron-ul GitHub întârzie sau sare rulări** la încărcare mare → datele au timestamp și UI-ul spune
   „întârziat”/„piață închisă”, nu „live”; `health.yml` deschide un issue sub 70% din rulări.
2. **Workflow-urile programate sunt dezactivate după 60 de zile fără activitate** → `keepalive.yml`
   lunar; GitHub trimite și un email cu o săptămână înainte (de verificat că API-ul de enable
   resetează contorul — verificare la prima lună).
3. **Supabase Free intră în pauză după 7 zile fără activitate** → ingestia scrie în zilele lucrătoare,
   `health.yml` citește zilnic, inclusiv în weekend.
4. **Yahoo (yahoo-finance2) e neoficial și `dev_only`** → nu e o bază pentru monetizare; flag-ul
   `commercialMode` îl exclude, iar RLS nu-l arată utilizatorilor nelogați. Pentru plată: EODHD
   (BVB, plan custom), Twelve Data sau licență directă BVB — adaptoare pregătite.
5. **Repo public** → secretele doar în GitHub Secrets; clientul REST nu le scrie niciodată în erori.
6. **Pages Functions 100k/zi** → doar acțiuni explicite (grafic, căutare); `_routes.json` exclude
   static; funcția e fail-open.

## Decizie
**D**, pentru că: elimină costul per vizitator (cauza epuizării creditelor), costă 0 € în Faza A,
permite uz comercial, nu adaugă un server de administrat și păstrează Supabase (date, auth, RLS)
care există deja. B rămâne varianta de rezervă dacă limitele gratuite devin o problemă; C (PC-ul
Ubuntu) rămâne doar pentru joburi interne opționale (LM Studio), niciodată în drumul critic.
