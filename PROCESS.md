# Full Process: Token + Usage + Dashboard

## 1) Context/Token Audit

```bash
node token-audit.js --root . --top 25 --out reports/token-audit.json --html reports/token-audit.html
```

## 2) OpenClaw Usage Snapshot + Trend

```bash
node openclaw-usage.js capture
```

Writes:
- `reports/openclaw-status.txt` (raw source)
- `reports/usage-latest.json` (parsed latest snapshot)
- `reports/usage-history.json` (rolling history, max 50 points)
- `reports/usage-dashboard.html` (trend dashboard)

## 3) Run both in one shot

```bash
node token-audit.js --root . --top 25 --out reports/token-audit.json --html reports/token-audit.html && node openclaw-usage.js capture
```

## 4) Optional cron (twice/week)

```cron
0 9 * * 1,4 cd /data/.openclaw/workspace/agents/builder && /usr/bin/node token-audit.js --root . --top 25 --out reports/token-audit.json --html reports/token-audit.html && /usr/bin/node openclaw-usage.js capture
```

## Notes
- Usage token numbers are estimated from `openclaw status` table (`xk/yk` parser).
- Good for trend + optimization decisions, not exact billing reconciliation.
