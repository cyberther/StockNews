# Putting Openbell into GitLab

The download contains the whole project. Nothing needs building — every file is plain HTML/CSS/JS.

## What's in it

- `templates/stock-news/StockNews.dc.html` — the app prototype (all 8 screens + desktop frame)
- `templates/stock-news/ds-base.js` — loads the design system for that page
- `styles.css` — Modernist tokens and component classes (the source of truth for the look)
- `readme.md`, `theme.json` — the design system's guide and parameters
- `components/`, `foundations/`, `theme.html`, `thumbnail.html` — the design-system reference pages
- `templates/deck/`, `templates/landing/` — the other starting points
- `_ds_bundle.js`, `_ds_manifest.json`, `_adherence.oxlintrc.json` — generated; safe to commit or ignore

## Push it

```bash
# 1. Create an empty project in GitLab (no README, no .gitignore)
# 2. Unzip the download, then from inside the folder:

git init
git add .
git commit -m "Openbell stock news prototype on the Modernist design system"
git branch -M main
git remote add origin git@gitlab.com:<you>/<project>.git
git push -u origin main
```

## Optional: preview it from GitLab Pages

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

The prototype then lives at `https://<you>.gitlab.io/<project>/templates/stock-news/StockNews.dc.html`.

## Keeping versions in step

I can read GitHub repositories but not write to them, so every commit is yours to make. The loop:

1. Ask me for a download at any checkpoint (I'll flag turns where files changed).
2. Unzip over your working copy, `git add -A`, commit, push to GitLab.
3. The diff shows exactly what changed since the last checkpoint.

## Mirroring GitLab → GitHub (`cyberther/StockNews`)

GitLab is the writable source; GitHub gets a copy automatically.

1. GitHub → create a Personal Access Token (classic) with `repo` scope.
2. GitLab project → **Settings → Repository → Mirroring repositories**.
3. Git repository URL: `https://github.com/cyberther/StockNews.git`
4. Mirror direction: **Push**
5. Authentication: **Password** — username `cyberther`, password = the PAT.
6. Tick *Keep divergent refs* off, save, then **Update now**.

Every push to GitLab now replays into GitHub. If you'd rather run it the other way (GitHub as source, GitLab pulling), use direction **Pull** and the same credentials — but then the GitLab copy is read-only.
