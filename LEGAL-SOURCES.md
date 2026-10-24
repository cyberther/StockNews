# Surse de date și licențe

Inventarul a tot ce folosește Market Pulse din afară: date de piață, știri, documente, servicii.
Pentru fiecare: la ce îl folosim, unde e în cod, ce spun termenii furnizorului și ce trebuie
făcut înainte ca site-ul să fie monetizat.

Starea la 16 octombrie 2026. Nu e o opinie juridică: e punctul de plecare pentru discuția cu un
avocat. Termenii se schimbă, deci se verifică din nou înainte de lansare. Paginile publice pentru
utilizatori sunt în `templates/stock-news-web/legal.html` (link `/legal`).

**Legendă risc:** 🟢 în regulă · 🟡 de clarificat · 🔴 trebuie rezolvat înainte de bani.
„Acum” înseamnă site privat, gratuit, conturi aprobate manual. „Monetizat” înseamnă abonament
plătit sau reclame.

## 1. Date de piață (prețuri, grafice, profiluri)

Gateway-ul (`netlify/functions/_shared/market/gateway.js`) alege furnizorul după capabilitate
(`PROVIDERS`, `RO_ROUTES`, `EU_ROUTES`).

| Furnizor | Ce ne dă | Ce spun termenii | Acum | Monetizat |
| --- | --- | --- | --- | --- |
| **Yahoo Finance** (`providers/yahoo.js`, `query1/query2.finance.yahoo.com`) | grafice și lumânări pentru toate bursele; prețuri, nume și profiluri pentru .RO, .DE, .L | Nu există un API public Yahoo Finance; endpoint-urile sunt neoficiale. Termenii pentru dezvoltatori Yahoo interzic veniturile din API fără acord scris. robots.txt interzice `/` pe `query1/query2`. | 🟡 | 🔴 |
| **Finnhub** (`providers/finnhub.js`) | prețuri, profiluri, știri, căutare, câștiguri, recomandări analiști, tranzacții insideri (SUA) | Planurile sunt pentru uz personal dacă nu se spune altfel. Datele nu se redistribuie și accesul nu se împarte cu terți fără acord scris. | 🟡 deja împărțim cu alți utilizatori aprobați | 🔴 |
| **Twelve Data** (`providers/twelvedata.js`) | rezervă pentru preț și grafic | Planul gratuit nu se folosește comercial. Afișarea externă cere „Redistribution Rights Add-On” sau un acord separat. | 🟡 | 🔴 |
| **Financial Modeling Prep** (`providers/fmp.js`) | rezervă pentru preț, profil, istoric câștiguri | Licență personală. Afișarea pe site-uri sau aplicații pentru mai multe persoane, gratuite sau plătite, cere acord specific. | 🟡 | 🔴 |
| **Alpha Vantage** (`providers/alphavantage.js`) | ultima rezervă (25 apeluri/zi) | Uz personal, necomercial. Comercial înseamnă inclusiv să lași alte persoane să acceseze informația. Pentru comercial: premium@alphavantage.co. | 🟡 | 🔴 |
| **SEC EDGAR** (link-uri în `gateway.js`; lista `company_tickers_exchange.json` în `templates/shared/us-tickers.json`, scrisă de `tools/update-us-catalog.mjs`; datele XBRL `companyfacts` citite de `tools/financials-batch.mjs`) | link-uri către rapoartele companiilor americane; lista simbolurilor Nasdaq, NYSE și Cboe pentru căutare (de la 2026-10-24, în locul căutării Finnhub, nefolosită pe Cloudflare); situațiile financiare anuale și trimestriale din tab-ul Financiar (de la 2026-10-24) | Date publice ale guvernului SUA; trebuie respectate politica de acces corect și limita de cereri. | 🟢 | 🟢 |

**Prețurile bursei în sine.** Dincolo de furnizor, bursele (BVB, LSE, Deutsche Börse, NYSE/Nasdaq)
își licențiază datele. Afișarea către clienți plătitori cere de obicei un contract de vendor sau
afișare, chiar și pentru date întârziate. Pentru BVB: departamentul Market Data al BVB. Nu am
cerut și nu cerem nimic de la bvb.ro.

**Recomandare.** Înainte de primul client plătitor, un singur furnizor cu drept de
redistribuire și afișare, pe toate bursele de care ai nevoie, apoi scos Yahoo din `RO_ROUTES`,
`EU_ROUTES` și `chart`/`candles`. Variante de cerut ofertă: planul comercial Finnhub, Twelve
Data cu add-on de redistribuire, EODHD, Polygon pentru SUA. Aproape toate oferă prețuri
mai mici pentru date întârziate (15 min) sau de la închidere. Prețul licenței stabilește prețul
abonamentului.

## 2. Știri (fluxuri RSS)

Ce afișăm: titlu, fragmentul din RSS, numele sursei, link. Codul e în
`netlify/functions/_shared/market/ro-news.js`, `eu-news.js`, `us-news.js` și în funcția de
scanare `supabase/functions/scan/`. Știrile se salvează în tabelul `stories`.

| Sursă | Fluxuri | Termeni găsiți | Acum | Monetizat |
| --- | --- | --- | --- | --- |
| Ziarul Financiar, Profit.ro, Economica.net, Financial Intelligence, InvestEnergy | `ro-news.js` | negăsiți; de cerut acord, mai ales ZF | 🟡 | 🔴 |
| tagesschau, Handelsblatt, WirtschaftsWoche, manager magazin, Spiegel, FAZ, n-tv | `eu-news.js` | negăsiți. La editorii germani obișnuit e „fluxuri doar necomercial” | 🟡 | 🔴 |
| BBC, The Guardian, City AM, This is Money | `eu-news.js` | BBC permite afișarea fluxurilor cu atribuire, dar nu și să încasezi bani pentru acces la conținutul lor. Guardian: de verificat | 🟡 | 🔴 |
| CNBC (NBCUniversal) | `us-news.js` | negăsiți pentru RSS; termenii generali NBCU | 🟡 | 🔴 |
| MarketWatch (Dow Jones) | `us-news.js` | uz individual, personal, necomercial, inclusiv RSS; comercial doar cu permisiune scrisă | 🟡 | 🔴 |
| PR Newswire, Business Wire | `us-news.js` | comunicate de presă făcute pentru distribuire | 🟢 | 🟢 |
| Site-urile emitenților BVB (Petrom, Antibiotice, Electrica etc.) | `ro-filings.js` | comunicate publice ale companiilor | 🟢 | 🟢 |

**Legea.** Directiva UE 2019/790, art. 15, preluată în România prin Legea 69/2022, care modifică
Legea 8/1996, dă editorilor de presă drepturi asupra folosirii online a articolelor lor.
Excepții: hyperlink-urile și „cuvintele individuale sau extrasele foarte scurte”. Titlu plus
link e în zona sigură. Fragmentul din RSS e de obicei scurt, dar e mai sigur să-l limităm, de
exemplu la o propoziție.

**Recomandare pentru varianta plătită:**
1. Pentru editorii fără acord: doar titlu, sursă și link, fără fragment și fără rezumat AI.
2. Rezumatele AI complete rămân pentru comunicate (PR Newswire, Business Wire), documentele
   emitenților și editorii cu care ai acord.
3. Cere acord sau licență de la 2–3 surse românești importante (ZF, Profit). Pentru un public de
   nișă, de obicei se poate negocia.

## 3. Rezumate AI

`tools/summarize-batch.mjs` rulează pe PC cu LM Studio (`openai/gpt-oss-20b`). Citește articolul
doar unde robots.txt permite și nu e paywall, nu salvează textul, salvează doar rezumatul.

- **Modelul** gpt-oss-20b are licență Apache 2.0, deci se poate folosi comercial. 🟢
- **Excepția de text and data mining** (art. 4 din directivă, preluat tot prin Legea 69/2022) se
  aplică numai dacă editorul nu și-a rezervat drepturile „într-un mod adecvat, cum ar fi prin
  mijloace care pot fi citite automat”. Respectăm robots.txt, dar unii editori folosesc și alte
  semnale: `TDM-Reservation`, `ai.txt`, meta `noai`, sau mențiuni în termeni. 🟡
- **Rezumatul unui articol întreg**, oferit contra cost, poate fi considerat folosire a operei
  dacă e prea detaliat. Rezumatele sunt scurte (câteva fraze), cu link vizibil către sursă. Pentru
  varianta plătită, vezi recomandarea de la punctul 2. 🟡 → 🔴

## 4. Calendarul financiar BVB și cifrele din rapoarte

`tools/filings-crawl.mjs`, `tools/calendar-extract.mjs`, `tools/filings-extract.mjs`. Datele de
raportare și cifrele sunt fapte publicate de emitenți; faptele nu au drept de autor. Le citim de
pe site-urile companiilor, cu robots.txt respectat, nu de pe bvb.ro. 🟢

## 5. Servicii care prelucrează date personale (GDPR)

| Serviciu | Rol | Ce trebuie |
| --- | --- | --- |
| **Supabase** | baza de date, autentificare, cron, funcția de scanare | Acceptat DPA-ul Supabase (include clauzele contractuale standard). Regiunea proiectului: West EU (Ireland), eu-west-1, trecută în `legal.html`. |
| **Netlify** | găzduire, funcții (gateway), formularul de contact (Netlify Forms, cu filtru antispam) | Acceptat DPA-ul Netlify. Jurnalele funcțiilor conțin IP-uri. Mesajele din formular se șterg după rezolvare, cel târziu după 12 luni. |
| **Serviciile push** ale browserelor (Apple, Google, Mozilla) | livrarea alertelor | Nimic de semnat; menționat în politică. |
| **Google / Apple sign-in**, dacă sunt pornite | autentificare | Menționat în politică; la Google, ecranul de consimțământ OAuth cere link spre politica de confidențialitate. |
| **LM Studio** (local, pe PC) | rezumate | Nu prelucrează date personale. |

Ce s-a făcut în aplicație:
- Termenii, Politica de confidențialitate, Avertismentul și Sursele sunt în `legal.html`, cu
  link-uri în landing page, în formularul de creare cont și în Cont.
- Utilizatorul își poate șterge singur contul (Cont → Șterge contul): `supabase/account.sql`,
  `delete_my_account()`. Toate tabelele cu date de utilizator au `on delete cascade`.
- Nu există cookies de urmărire sau analytics, deci nu e nevoie de banner de cookies. Dacă se
  adaugă analytics sau reclame, banner-ul devine obligatoriu.

## 6. Ce rămâne de făcut

1. ~~Datele operatorului~~: completate (ADALIT DATA SRL, CUI 49586191, sediul, regiunea
   Supabase). Pe site nu apare nicio adresă de e-mail: contactul se face prin formularul de pe
   `/legal#contact` (Netlify Forms). Netlify trimite mesajele pe e-mailul operatorului, setat doar
   în Netlify → Project configuration → Notifications, nu în cod (repo-ul e public).
2. ~~Rulat `supabase/account.sql` în SQL Editor~~: rulat pe 16 octombrie 2026.
3. Acceptate DPA-urile Supabase și Netlify.
4. Pentru monetizare: licența de date (punctul 1), acordurile cu editorii sau varianta „doar
   titlu” (punctul 2), firma (SRL/PFA) și procesatorul de plăți, apoi avocatul citește
   `legal.html`. La planurile plătite se adaugă în termeni prețul, reînnoirea, dreptul de
   retragere de 14 zile (OUG 34/2014) și renunțarea expresă la el pentru conținut digital
   furnizat imediat.

## Surse consultate

- [Finnhub – Terms of Service](https://finnhub.io/terms-of-service)
- [Yahoo Developer API Terms of Use](https://legal.yahoo.com/us/en/yahoo/terms/product-atos/apiforydn/index.html)
- [Twelve Data – Terms](https://twelvedata.com/terms)
- [Financial Modeling Prep – Terms of Service](https://site.financialmodelingprep.com/terms-of-service) și [ghidul FMP despre afișarea în aplicații publice](https://site.financialmodelingprep.com/insights/platform/can-you-use-fmp-data-in-a-public-app-website-or-client-dashboard)
- [Alpha Vantage – Terms of Service](https://www.alphavantage.co/terms_of_service/)
- [Dow Jones – Terms of Use](https://www.dowjones.com/terms-of-use/) (citat prin [ghidul bibliotecii SCU](https://libguides.scu.edu/az/wsjcom))
- BBC, despre deschiderea fluxurilor RSS: [digital-lifestyles.info](https://digital-lifestyles.info/2005/05/11/bbc-opens-up-rss-news-feeds) și [clagnut.com](https://clagnut.com/blog/1450/), ambele vechi; de verificat pe bbc.co.uk
- Directiva (UE) 2019/790, art. 4 și 15; Legea 8/1996 modificată prin Legea 69/2022

## 6. Surse de politici și bani publici (Politici 2.0)
Verificate pe 19 octombrie 2026, pentru `docs/plans/2026-10-19-politici-automat-design.md`. Clientul se identifică
cinstit: `MarketPulse/1.0 (+https://www.marketpulse.ro)`. Fixture-urile sunt în `test/fixtures/policy/`.

| Sursă | Ce luăm | Termeni / acces | Verdict |
|---|---|---|---|
| **Portalul legislativ** (`legislatie.just.ro`, serviciul SOAP `apiws/FreeWebService.svc`: `GetToken`, `Search`) | actele publicate în Monitorul Oficial: număr, emitent, data intrării în vigoare, text complet | Serviciu web public, pentru reutilizare. Fără robots.txt. Refuză (403) cererile fără User-Agent sau cu cel implicit al curl, dar acceptă un client care se identifică. Textul nu are valoare oficială în instanță: sursa juridică rămâne Monitorul Oficial. | 🟢 |
| **Guvernul: note de fundamentare** (`gov.ro/ro/guvernul/procesul-legislativ/note-de-fundamentare`) | nota fiecărei hotărâri și ordonanțe, inclusiv secțiunea despre impactul financiar | Site public al Guvernului. Fără robots.txt. Documente publicate pentru transparență (Legea 52/2003). | 🟢 |
| **SEAP: date deschise** (`data.gov.ro/dataset/achizitii-publice-2026`, publicate de ADR) | contractele trimestriale: autoritate, CPV, valoare RON, data, **CUI-ul câștigătorului** | Licență CC BY 4.0 (cere atribuire: „Sursa: SEAP / data.gov.ro”). robots.txt cere 10 s între cereri și interzice `/api/`, de aceea descărcăm fișierele direct. Format: xlsx sau ods (~22 MB, foaia ~200 MB necomprimată). | 🟢 |
| **Senatul** (`senat.ro/legis/lista.aspx`) | proiectele aflate la Senat | Pagina ASP.NET merge doar cu postback-uri. Proiectele trec oricum prin Camera Deputaților, pe care o citim deja. | 🟡 amânat |
| **Ajutoare de stat** (RegAS `ajutordestat.ro`; registrul de transparență al Comisiei Europene) | beneficiarii ajutoarelor | RegAS are certificatul TLS invalid (curl exit 60). Registrul Comisiei are doar căutare manuală, fără export sau API (o cerere AskTheEU confirmă că nu există acces în bloc). | 🔴 deocamdată |

Consecințe pentru plan:
- Task 7 implementează portalul legislativ și notele de fundamentare de la Guvern; Senatul rămâne amânat.
- Task 8 implementează SEAP.
- Ajutoarele de stat rămân în schema bazei (tabelul `state_aid`), fără parser, până apare o sursă cu export.
- Schemele de ajutor anunțate de Ministerul Finanțelor intră oricum ca documente.
