#!/usr/bin/env bash
# Monthly refresh of the US ticker list the apps search (templates/shared/us-tickers.json, from
# the SEC: tools/update-us-catalog.mjs). Runs on the PC (the SEC contact is read there), in a
# throwaway worktree, so ~/StockNews (the checkout the other jobs run from) is never touched.
# When a listing changed it opens a pull request; merging and deploying stay with the owner.
# Systemd: tools/systemd/market-pulse-us-catalog.{service,timer}.
set -euo pipefail
REPO="${REPO:-$HOME/StockNews}"
MONTH="$(date +%Y-%m)"
BRANCH="data/us-catalog-$MONTH"
TMP="$(mktemp -d)"
WT="$TMP/us-catalog"
FILE=templates/shared/us-tickers.json
cleanup() {
  cd /
  git -C "$REPO" worktree remove --force "$WT" 2>/dev/null || true
  # The branch only lives on if it was pushed.
  git -C "$REPO" ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1 || git -C "$REPO" branch -q -D "$BRANCH" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

git -C "$REPO" fetch -q origin main
if git -C "$REPO" ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
  echo "$BRANCH is already on GitHub: nothing to do this month"; exit 0
fi
git -C "$REPO" worktree add -q -b "$BRANCH" "$WT" origin/main
cd "$WT"
node tools/update-us-catalog.mjs

# Compare the listings only (the "updated" date always changes): added and removed tickers.
SUMMARY="$(python3 - "$FILE" <<'PY'
import json, subprocess, sys
f = sys.argv[1]
old = json.loads(subprocess.run(['git', 'show', 'HEAD:' + f], capture_output=True, text=True, check=True).stdout)['rows']
new = json.load(open(f))['rows']
if old == new: sys.exit(0)
o, n = {r[0] for r in old}, {r[0] for r in new}
added, removed = sorted(n - o), sorted(o - n)
renamed = sum(1 for r in new if r[0] in o and r not in old)
print(f"{len(new)} listings: {len(added)} added, {len(removed)} removed, {renamed} with a new name or exchange.\n")
print('Added: ' + (', '.join(added[:80]) + (' …' if len(added) > 80 else '') if added else '-'))
print('Removed: ' + (', '.join(removed[:80]) + (' …' if len(removed) > 80 else '') if removed else '-'))
PY
)"
if [ -z "$SUMMARY" ]; then echo "no listing changed: no pull request"; exit 0; fi

node --test test/us-catalog.test.js >/dev/null
git add "$FILE"
git -c user.name="$(git -C "$REPO" config user.name)" -c user.email="$(git -C "$REPO" config user.email)" \
  commit -q -m "US ticker list from the SEC, $MONTH (monthly refresh)" -m "$SUMMARY" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -q -u origin "$BRANCH"
gh pr create --base main --head "$BRANCH" --title "US ticker list from the SEC, $MONTH" --body "$SUMMARY

Monthly refresh by tools/refresh-us-catalog.sh (PC timer market-pulse-us-catalog). The search reads the new list after the next deploy.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
