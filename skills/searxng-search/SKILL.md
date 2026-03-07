---
name: searxng-search
description: Query a self-hosted SearXNG instance via JSON API for low-cost web search. Use when web_search key is missing/costly, when privacy-first search is required, or when the user asks for SearXNG-backed search.
---

# SearXNG Search

Use this skill to run web search through SearXNG instead of paid API providers.

## Required env

- `SEARXNG_BASE_URL` (example: `https://search.example.com`)

Optional:
- `SEARXNG_DEFAULT_LANGUAGE` (default: `en`)
- `SEARXNG_DEFAULT_SAFESEARCH` (`0|1|2`, default: `1`)

## Workflow

1. Run `scripts/searxng_search.sh "<query>"`.
2. If results are sparse, retry with broader query or different language.
3. For top hits, use `web_fetch` or browser for deeper extraction.
4. Cite URLs in final answer.

## Notes

- Keeps browser controls untouched.
- Uses SearXNG `/search?format=json` endpoint.
- If SearXNG is unavailable, fall back to `web_fetch` + browser search.
