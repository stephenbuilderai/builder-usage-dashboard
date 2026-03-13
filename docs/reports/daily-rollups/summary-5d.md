# 5-day AI Insights

Window: 2026-03-11 → 2026-03-13 (3 day(s))

## Trend narrative
- Estimated tokens moved up by 87,641 across the available window.
- Estimated daily costs track token movement and remain rough heuristics.

## Biggest drivers
- Top models: gpt-5.4 (1,390,311 est tokens) · gpt-5-mini (1,122,064 est tokens) · gpt-5.3-codex (337,038 est tokens)
- Top agents: main (2,224,218 est tokens) · builder (337,038 est tokens) · trading-commander (153,733 est tokens)
- Top attribution buckets: interactive (1,874,885 est tokens) · cron (1,006,526 est tokens) · system/other (0 est tokens)

## Anomalies
- No strong day-over-day anomalies detected (>=15% threshold).

## Recommended actions
- Cap high-churn context files and trim non-essential markdown to reduce prompt footprint.
- Review cron-heavy windows and reduce redundant scheduled runs where possible.
- Keep fallback model usage visible; investigate spikes when model mix changes suddenly.

_Note: generated from local snapshot artifacts using heuristic summarization (LLM-style narrative)._