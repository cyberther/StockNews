# Putting Heard It First into GitLab

Nothing needs building — every file is plain HTML/CSS/JS.

## What's in it

- `templates/stock-news-web/StockNewsWeb.dc.html` — the web app
- `templates/stock-news-dark/StockNewsDark.dc.html` — the mobile app
- `templates/stock-news/StockNews.dc.html` — the light-mode original
- `templates/shared/` — shared headline data and live-quote client
- `styles.css` — tokens and component classes (the source of truth for the look)
- `readme.md` — the style guide
- `components/`, `foundations/`, `thumbnail.html` — reference pages

## Push it

```bash
git init
git add .
git commit -m "Heard It First"
git branch -M main
git remote add origin git@gitlab.com:<you>/<project>.git
git push -u origin main
```

## Optional: GitLab Pages

`.gitlab-ci.yml` at the repo root:

```yaml
pages:
  stage: deploy
  script:
    - mkdir -p public
    - cp -r . public/ 2>/dev/null || true
  artifacts:
    paths: [public]
  only: [main]
```

## Mirroring GitLab → GitHub (`cyberther/StockNews`)

1. GitHub → create a Personal Access Token (classic) with `repo` scope.
2. GitLab project → **Settings → Repository → Mirroring repositories**.
3. Git repository URL: `https://github.com/cyberther/StockNews.git`
4. Mirror direction: **Push**
5. Authentication: **Password** — username `cyberther`, password = the PAT.
6. Save, then **Update now**.
