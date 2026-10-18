# Surse pentru Political Intelligence și termenii lor de reutilizare

Verificat: 2026-10-18. **Nu e consultanță juridică.** Rândurile marcate „de verificat juridic” trebuie
confirmate de un avocat înainte de lansarea comercială (vezi și `LEGAL-SOURCES.md`).

## Ce păstrăm din fiecare sursă
Doar: titlul, numărul documentului, stadiul (în formularea sursei), datele, un rezumat scurt (≤ 600
caractere, doar la comunicate) și **linkul spre pagina oficială**. Nu copiem textul integral al actelor.
Fiecare eveniment din aplicație afișează sursa și duce la ea.

## Cadrul general
- **Legea 179/2022** privind datele deschise și reutilizarea informațiilor din sectorul public
  (transpune Directiva (UE) 2019/1024): documentele deținute de instituțiile publice pot fi reutilizate,
  inclusiv comercial, în condițiile publicate de fiecare instituție. — de verificat juridic: condițiile
  concrete ale fiecărei instituții de mai jos.
- **Legea 8/1996, art. 9**: textele oficiale de natură politică, legislativă, administrativă și judiciară
  nu sunt protejate de dreptul de autor. Titlurile proiectelor și ale legilor intră aici. — de verificat
  juridic: dacă se aplică și comunicatelor de presă ale ministerelor.

## Surse folosite în Faza B

| Sursă | URL | Ce citim | Termeni găsiți | Stare |
|---|---|---|---|---|
| Camera Deputaților – inițiative înregistrate | `https://www.cdep.ro/ords/pls/proiecte/upl_pck2015.lista?anp=AN` | nr. PL-x/Pl-x, titlu, stadiu, link fișă | nicio pagină de termeni legată de pe prima pagină | texte oficiale (L. 8/1996 art. 9); de verificat juridic |
| Camera Deputaților – legi promulgate | `…upl_pck2015.lista?anl=AN` | nr. proiect, titlu, „Lege N/AN”, data, link | idem | idem |
| Ministerul Finanțelor – comunicate de presă (RSS) | `mfinante.gov.ro … INSTANCE_uwgr … getRSS` | titlu, rezumat scurt, dată, link | feed RSS public oferit de minister; nicio pagină de termeni legată | de verificat juridic (comunicatele) |

Acces tehnic: o cerere pe pagină pe zi (jobul `eod`), user-agent identificabil
(`MarketPulsePolicy/1.0`), timeout 20 s, fără reîncercări.

## Surse amânate și motivul
| Sursă | Motiv (2026-10-18) |
|---|---|
| BNR – decizii de politică monetară | paginile se încarcă prin JavaScript; de găsit un feed sau un API |
| INS | certificatul TLS al `insse.ro` e respins (curl, eroare 60) |
| Senat | stadiul „la Senat” apare deja în lista Camerei; fișa Senatului, ulterior |
| Monitorul Oficial | condiții de reutilizare restrictive; legăm spre repertoriul legislativ al Camerei |
| Eurostat | feed-ul RSS anunță actualizări de seturi de date, nu evenimente |
| BVB – rapoarte curente | există deja în aplicație (tabelul `filings`, crawler pe PC); nu se duplică |

## Neutralitate (reguli aplicate în cod)
- Statutul vine doar din forma sursei (listă, stadiu), niciodată din cuvintele titlului: un comunicat care
  spune „legea a fost adoptată” rămâne „Declarație / comunicat”.
- Inițiatorul e „Guvern” (PL-x) sau „Parlamentari” (Pl-x); fără nume de partide.
- Etichetele de statut și certitudine sunt texte fixe pe valoare; fără adjective evaluative.
- Fiecare legătură cu o companie spune motivul: „menționată” în text sau „prin sectorul …”.
