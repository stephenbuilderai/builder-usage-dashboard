# 5-day AI Insights

Window: 2026-03-14 → 2026-03-16 (3 day(s))

## Trend narrative
- Estimated tokens moved down by 1,365 across the available window.
- Estimated daily costs track token movement and remain rough heuristics.

## Biggest drivers
- Top models: gpt-5.4 (1,322,943 est tokens) · gpt-5-mini (1,137,150 est tokens) · gpt-5.2 (400,523 est tokens)
- Top agents: main (2,489,790 est tokens) · builder (337,038 est tokens) · trading-commander (333,574 est tokens)
- Top attribution buckets: interactive (1,951,760 est tokens) · cron (1,375,064 est tokens) · system/other (0 est tokens)

## Anomalies
- 2026-03-15: -21.9% token shift vs previous day
- 2026-03-16: +28.0% token shift vs previous day

## Recommended actions
- Cap high-churn context files and trim non-essential markdown to reduce prompt footprint.
- Review cron-heavy windows and reduce redundant scheduled runs where possible.
- Keep fallback model usage visible; investigate spikes when model mix changes suddenly.

_Note: generated from local snapshot artifacts using heuristic summarization (LLM-style narrative)._