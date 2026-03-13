# 5-day AI Insights

Window: 2026-03-11 → 2026-03-13 (3 day(s))

## Trend narrative
- Estimated tokens moved up by 20,835 across the available window.
- Estimated daily costs track token movement and remain rough heuristics.

## Biggest drivers
- Top models: gpt-5.4 (1,304,268 est tokens) · gpt-5-mini (1,141,301 est tokens) · gpt-5.3-codex (337,038 est tokens)
- Top agents: main (2,222,178 est tokens) · builder (337,038 est tokens) · trading-commander (88,967 est tokens)
- Top attribution buckets: interactive (1,807,545 est tokens) · cron (1,007,060 est tokens) · system/other (0 est tokens)

## Anomalies
- No strong day-over-day anomalies detected (>=15% threshold).

## Recommended actions
- Cap high-churn context files and trim non-essential markdown to reduce prompt footprint.
- Review cron-heavy windows and reduce redundant scheduled runs where possible.
- Keep fallback model usage visible; investigate spikes when model mix changes suddenly.

_Note: generated from local snapshot artifacts using heuristic summarization (LLM-style narrative)._