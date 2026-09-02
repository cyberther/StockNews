# Source repository

repo: cyberther/StockNews
branch: main
host: github.com (GitLab mirror optional — see gitlab-setup.md)

## Last sync

date: 2026-09-02T15:01:00Z

### Updated in this project
- Split the dark prototype into two templates: `templates/stock-news-dark/` (mobile only) and `templates/stock-news-web/` (desktop/web app)
- Added `templates/shared/hif-data.js` — single source for headlines, tickers and EN/RO/DE copy, read by both templates
- Both templates deployed to Netlify (web: heard-it-first-web-app-dark-terminal, mobile: heard-it-first-stock-news-dark-terminal-cd-1210e6cc11)
- Not yet committed to GitHub — needs a push from the local clone (I can read repos, not write to them)

## Screen map

| Screen | Built from |
| --- | --- |
| Mobile app (auth, feed, watchlist, screener, detail, paywall, more, account) | templates/stock-news-dark/StockNewsDark.dc.html |
| Web app (feed, detail, watchlist, screener, paywall, account) | templates/stock-news-web/StockNewsWeb.dc.html |
| Headlines, tickers, EN/RO/DE copy (shared) | templates/shared/hif-data.js |
| Light-mode original | templates/stock-news/StockNews.dc.html |
| Design-system loaders | templates/*/ds-base.js |
| Tokens, type, color, components | styles.css |

## Sync history

- 2026-09-02T14:59:47Z — re-imported repo; StockNewsDark.dc.html pulled fresh
- 2026-09-02T10:25:56Z — prototype + Modernist design system pushed whole
