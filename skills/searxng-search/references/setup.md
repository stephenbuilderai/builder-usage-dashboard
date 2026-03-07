# SearXNG setup notes

## API endpoint

SearXNG supports:
- `GET /search?q=<query>&format=json`

If `format=json` is disabled in SearXNG `settings.yml`, requests return 403.

## Minimal SearXNG search settings

```yaml
search:
  safe_search: 1
  formats:
    - html
    - json
```

## Example test

```bash
curl -G "${SEARXNG_BASE_URL}/search" \
  --data-urlencode "q=openclaw" \
  --data-urlencode "format=json"
```

## Operational recommendations

- Keep a stable small engine set (quality > quantity).
- Add short caching at reverse-proxy layer.
- Restrict instance access if private (auth/IP allowlist).
