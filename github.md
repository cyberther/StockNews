# Source repository

repo: cyberther/StockNews
branch: main
path: templates/

## Last sync

date: 2026-09-07T11:40:00Z

### Updated in this project
- Appearance setting in Account: System (follows the OS), Light or Dark — surfaces, rules, type and charts all follow it; persisted with the rest of the settings
- Light mobile template removed; the dark web + dark mobile pair now carries both schemes
- Accounts: one-screen sign-in / sign-up with Google, iCloud and email + password (live strength meter and breach warning), on web and mobile dark
- First-time signup picks three tickers before the feed opens; sign-out and "sign out everywhere" clear the session
- New Security screen (reached from Account, and from the web rail): 2FA setup with recovery codes, login alerts, configurable inactivity lock, active-session revoke, connected accounts
- Settings, watchlist, plan, languages, push toggles, screener filter, chart range and last screen now survive a reload (templates/shared/hif-store.js, one record per template)
- Light mobile template got persistence only, per request
- Local only — these edits are NOT yet on GitHub; push them from a local clone

## Screen map

| Screen | Built from |
| --- | --- |
| Web app — dark terminal (auth, onboarding, feed, detail, watchlist, screener, paywall, account, security, lock) | templates/stock-news-web/StockNewsWeb.dc.html |
| Mobile app — dark terminal (auth, onboarding, feed, watchlist, screener, detail, paywall, more, account, security, lock) | templates/stock-news-dark/StockNewsDark.dc.html |
| Shared headlines, tickers, EN/RO/DE copy incl. auth + security strings | templates/shared/hif-data.js, templates/shared/hif-live.js |
| Local persistence, password strength, 2FA key + recovery codes | templates/shared/hif-store.js |
| Theme tokens (--s-bg / --s-ink / --s-rule / --color-accent per scheme) | inline in each .dc.html helmet |
| Design-system loaders | templates/*/ds-base.js |
| Tokens, type, color, components | _ds/modernist-a9cc4863-5c6f-4243-8321-e1618f3a965c/styles.css |

## Sync history

- 2026-09-07T09:15:00Z — auth (Google / iCloud / email), onboarding, security screen, local persistence (local only)
- 2026-09-04T11:20:00Z — chart unification, analyst sentiment bar, volume sorting, sparklines, screener chips (local only)
- 2026-09-04T10:05:50Z — imported templates/ from cyberther/StockNews@main (web, mobile dark, light original, shared data)
