# Source repository

repo: cyberther/StockNews
branch: main
host: github.com (GitLab mirror optional — see gitlab-setup.md)

## Last sync

date: 2026-09-02T20:12:13Z

### Updated in this project
- Imported latest repo state (a0fd86646872); earlier local work is now present upstream
- Pulled newer upstream versions of `templates/stock-news-web/StockNewsWeb.dc.html`, `templates/shared/hif-live.js`, `netlify/functions/finnhub.js`, `netlify.toml`, `live-data-setup.md`
- All other files (styles.css, foundations, components, deck/landing/mobile templates) already matched upstream byte-for-byte

## Screen map

| Screen | Built from |
| --- | --- |
| Mobile app (auth, feed, watchlist, screener, detail, paywall, more, account) | templates/stock-news-dark/StockNewsDark.dc.html |
| Web app (feed, detail, watchlist, screener, paywall, account) | templates/stock-news-web/StockNewsWeb.dc.html |
| Headlines, tickers, EN/RO/DE copy (shared) | templates/shared/hif-data.js |
| Light-mode original | templates/stock-news/StockNews.dc.html |
| Live quote proxy | netlify/functions/finnhub.js, templates/shared/hif-live.js |
| Deck, landing page | templates/deck/Deck.dc.html, templates/landing/index.html |
| Design-system loaders | templates/*/ds-base.js |
| Tokens, type, color, components | styles.css |

## Sync history

- 2026-09-02T15:01:00Z — split dark prototype into mobile + web templates; added shared/hif-data.js; deployed both to Netlify
- 2026-09-02T14:59:47Z — re-imported repo; StockNewsDark.dc.html pulled fresh
- 2026-09-02T10:25:56Z — prototype + Heard It First UI kit pushed whole
