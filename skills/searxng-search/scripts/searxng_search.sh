#!/usr/bin/env bash
set -euo pipefail

QUERY="${1:-}"
if [[ -z "$QUERY" ]]; then
  echo "Usage: $0 \"search query\"" >&2
  exit 2
fi

if [[ -z "${SEARXNG_BASE_URL:-}" ]]; then
  echo "SEARXNG_BASE_URL is not set" >&2
  exit 2
fi

LANG="${SEARXNG_DEFAULT_LANGUAGE:-en}"
SAFE="${SEARXNG_DEFAULT_SAFESEARCH:-1}"
BASE="${SEARXNG_BASE_URL%/}"

URL="${BASE}/search"
RESP="$(curl -fsSLG "$URL" \
  -H "User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0" \
  -H "Accept: application/json" \
  -H "Referer: https://searxng/" \
  -H "X-Real-IP: 172.18.0.1" \
  -H "X-Forwarded-For: 172.18.0.1" \
  --data-urlencode "q=${QUERY}" \
  --data-urlencode "format=json" \
  --data-urlencode "language=${LANG}" \
  --data-urlencode "safesearch=${SAFE}")"

# Compact top results for agent consumption (safer jq usage)
echo "$RESP" | jq -r '.results[0:8] // [] | .[] | "- " + (.title // "(no title)") + "\n  " + (.url // "") + "\n  " + ((.content // "") | .[:200])'
