---
name: qmd
description: Local markdown retrieval with QMD for low-token, high-recall context lookup across many .md files. Use when searching decisions, notes, configs, runbooks, or project docs across multiple markdown files, especially when memory_search confidence is low or query scope is broader than agent memory.
---

# QMD

Use QMD as the primary retrieval layer for multi-file markdown lookup.

## Defaults (token-efficient)

1. Run BM25 first:

```bash
qmd search "<query>" -c workspace-md -n 5
```

2. If BM25 misses relevant results, run semantic fallback:

```bash
qmd vsearch "<query>" -c workspace-md -n 5
```

3. Use hybrid rerank only for hard synthesis tasks:

```bash
qmd query "<query>" -c workspace-md -n 5
```

Avoid `qmd query` by default (higher latency/cost).

## Output policy

- Return top 3-5 hits only.
- Include source path for every hit.
- Keep snippets short (roughly 400-800 chars each).
- Do not paste full files unless explicitly requested.

## Retrieval routing

- If request is clearly multi-file doc lookup -> use QMD first.
- If request is prior chat-memory recall -> use `memory_search` first.
- If confidence is low -> run both and merge evidence.

## Maintenance

Refresh lexical index frequently:

```bash
qmd update
```

Run embeddings only when semantic retrieval quality is needed and time allows:

```bash
qmd embed
```

## Current local collection

Primary collection in this workspace:

- `workspace-md` -> `/data/.openclaw/workspace` with mask `**/*.md`

## Quick checks

```bash
qmd status
qmd search "Supadata" -c workspace-md -n 5
```

If results are empty, verify collection exists and re-run `qmd update`.
