# 5-day AI Insights

Window: 2026-03-13 → 2026-03-15 (3 day(s))

## Trend narrative
- Estimated tokens moved down by 83,013 across the available window.
- Estimated daily costs track token movement and remain rough heuristics.

## Biggest drivers
- Top models: gpt-5-mini (1,721,141 est tokens) · gpt-5.4 (1,423,424 est tokens) · gpt-5.3-codex (337,038 est tokens)
- Top agents: main (2,663,607 est tokens) · trading-commander (346,534 est tokens) · builder (337,038 est tokens)
- Top attribution buckets: interactive (2,174,772 est tokens) · cron (1,338,829 est tokens) · system/other (0 est tokens)

## Anomalies
- No strong day-over-day anomalies detected (>=15% threshold).

## Recommended actions
- Cap high-churn context files and trim non-essential markdown to reduce prompt footprint.
- Review cron-heavy windows and reduce redundant scheduled runs where possible.
- Keep fallback model usage visible; investigate spikes when model mix changes suddenly.

_Note: generated from local snapshot artifacts using heuristic summarization (LLM-style narrative)._