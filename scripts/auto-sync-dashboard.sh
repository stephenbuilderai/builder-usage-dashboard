#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="/data/.openclaw/workspace/agents/builder"
LOG_DIR="$REPO_DIR/reports"
LOG_FILE="$LOG_DIR/auto-sync.log"

mkdir -p "$LOG_DIR"

cd "$REPO_DIR"

{
  echo "[$(date -Is)] auto-sync start"

  # 1) refresh dashboard artifacts
  node token-audit.js --root . --top 25 --out reports/token-audit.json --html reports/token-audit.html
  node openclaw-usage.js capture

  # 2) stage only publish/data artifacts (avoid unrelated workspace noise)
  git add docs/index.html docs/version.json docs/reports/daily-rollups/*.json docs/reports/daily-rollups/summary-5d.md \
          reports/usage-dashboard.html reports/usage-history.json reports/usage-latest.json reports/openclaw-status.txt \
          reports/daily-rollups/*.json reports/daily-rollups/summary-5d.md reports/token-audit.json reports/token-audit.html

  # 3) commit only if there are staged changes
  if git diff --cached --quiet; then
    echo "[$(date -Is)] no changes"
    exit 0
  fi

  git commit -m "chore: auto-sync dashboard $(date -Is)"
  CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  if git push origin "$CURRENT_BRANCH"; then
    echo "[$(date -Is)] pushed"
  else
    echo "[$(date -Is)] push failed (likely missing GitHub credentials)"
    exit 0
  fi
} >> "$LOG_FILE" 2>&1
