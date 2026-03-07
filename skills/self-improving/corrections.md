# Corrections Log — Template

> This file is created in `~/self-improving/corrections.md` when you first use the skill.
> Keeps the last 50 corrections. Older entries are evaluated for promotion or archived.

## Example Entries

```markdown
## 2026-02-19

### 14:32 — Code style
- **Correction:** "Use 2-space indentation, not 4"
- **Context:** Editing TypeScript file
- **Count:** 1 (first occurrence)

### 16:15 — Communication
- **Correction:** "Don't start responses with 'Great question!'"
- **Context:** Chat response
- **Count:** 3 → **PROMOTED to memory.md**

## 2026-02-18

### 09:00 — Project: website
- **Correction:** "For this project, always use Tailwind"
- **Context:** CSS discussion
- **Action:** Added to projects/website.md
```

## Log Format

Each entry includes:
- **Timestamp** — When the correction happened
- **Correction** — What the user said
- **Context** — What triggered it
- **Count** — How many times (for promotion tracking)
- **Action** — Where it was stored (if promoted)

## 2026-03-04 — Migrated from lightweight-learning-log

### 2026-03-01 — Browser CDP startup timeout
- **Correction/learning:** OpenClaw browser failures on profile `openclaw` can come from stale Chromium `Singleton*` locks (not missing browser).
- **Context:** Browser control outage.
- **Action:** Kill chromium, remove `SingletonLock/Socket/Cookie`, restart container, restart browser.
- **Source:** `.learnings/LEARNINGS.md`, `.learnings/ERRORS.md`

### 2026-03-01 — Model routing communication drift
- **Correction/learning:** Never claim model routing is applied before verifying config/session state.
- **Context:** Cost-routing discussion mismatch.
- **Action:** Verify with `session_status` + config diff before stating switched.
- **Source:** `.learnings/LEARNINGS.md`

### 2026-03-04 — YouTube ingestion order
- **Correction/learning:** YouTube extraction order must be Supadata first; fallbacks only on failure.
- **Context:** Video analysis workflow.
- **Action:** Enforce fixed runbook ordering.
- **Source:** `.learnings/LEARNINGS.md`

### 2026-02-28 — Reminder completion behavior
- **Correction/learning:** If user marks task done (`erledigt/done/abgehakt`), disable matching reminder immediately.
- **Context:** Reminder workflow.
- **Action:** Keep as persistent rule for reminder automation.
- **Source:** `.learnings/LEARNINGS.md`, `.learnings/FEATURES.md`
