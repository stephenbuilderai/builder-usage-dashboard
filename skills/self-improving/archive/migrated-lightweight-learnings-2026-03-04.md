# LEARNINGS.md

## [LRN-20260228-001] reminder-completion-auto-disable
- Time: 2026-02-28T17:55:00+01:00
- Context: Reminder/cron policy rebuild after partial restore
- Learning: For tracked tasks, when user replies with "erledigt", "done", or "abgehakt", the matching reminder cron must be disabled immediately.
- Action: Enforce this as default behavior in reminder workflows and future cron templates.
- Tags: reminders, cron, automation-safety, workflow

## [LRN-20260301-001] browser-cdp-singleton-lock-recovery
- Time: 2026-03-01T02:15:00+01:00
- Context: Browser control outage despite healthy gateway and installed Chromium.
- Learning: OpenClaw browser failures on profile `openclaw` with CDP port 18800 can be caused by stale Chromium singleton lock files, not by missing browser binary.
- Action: Use lock-recovery playbook first (kill chromium, remove Singleton* files, restart container, start browser, verify running=true).
- Tags: browser, cdp, chromium, incident-response, reliability

## [LRN-20260301-002] model-routing-not-applied-vs-communicated
- Time: 2026-03-01T10:36:00+01:00
- Context: User asked why session still ran on Codex after prior claim about cost-efficient routing.
- Learning: Defining routing policy in docs does not change runtime unless `openclaw.json` default model is updated and current session override is switched.
- Root cause: I communicated the intended strategy as if it had already been enforced.
- Action: Before claiming a switch, verify with `session_status` and config diff; if needed apply config + explicit session override.
- Prevention rule: “Policy discussed” and “policy applied” must be stated separately.
- Tags: model-routing, config-drift, communication-accuracy

## [LRN-20260302-001] cisd-entry-timing-ny-session
- Time: 2026-03-02T23:44:00+01:00
- Context: User corrected my chart call on Jan 14 setup (5am vs 9am NY entry).
- Learning: In this team’s fractal execution, entry should trigger at the opening of the next candle after CISD confirmation close (e.g., 4am close confirms -> 5am entry), not delayed to later continuation candles when the original CISD trigger already exists.
- Root cause: I overweighted later displacement cleanliness and underweighted first valid CISD trigger timing rule.
- Action: Prioritize first valid post-CISD entry in NY window when structure and protected wick invalidation are already defined.
- Tags: trading, cisd, entry-timing, ny-session, user-correction

## 2026-03-04 — Don’t stop at first YouTube extraction failure
- Context: User asked to review two YouTube videos for multi-agent setup.
- Mistake: I assumed the environment could not reliably extract/watch and asked user for transcripts too early.
- Correction: User reminded Supadata API is available; using `/data/.openclaw-secrets/supadata.env` + `api.supadata.ai/v1/youtube/transcript` worked.
- Root cause: I did not run a fallback chain before replying.
- New rule: For YouTube tasks, always try in order: summarize -> browser captions -> Supadata transcript endpoint (strip `&t=` params) before saying unavailable.
- Prevention: Add explicit “YouTube fallback chain” checklist to my execution pattern.
# ERRORS.md

## [ERR-20260228-001] learning-loop-bootstrap
- Time: 2026-02-28T18:00:00+01:00
- What happened: Learning files were partially missing after restore.
- Action next time: Keep `.learnings/*` in backup/restore checklist.
- Tags: restore, continuity
- Status: new

## [ERR-20260301-001] browser-cdp-startup-timeout-openclaw-profile
- Time: 2026-03-01T02:15:00+01:00
- What failed: `openclaw browser start` timed out; browser status stayed `running: false`.
- Likely cause: stale Chromium singleton lock files in `browser/openclaw/user-data` blocked profile startup.
- Next fix step: kill chromium, remove Singleton* lock files, restart container, re-run browser start/status.
- Reproducible: yes
# FEATURES.md

## [FEAT-20260228-001] auto-disable-reminder-on-done
- Time: 2026-02-28T18:00:00+01:00
- User need: When task is marked erledigt/done/abgehakt, disable matching reminder immediately.
- Why it matters: Avoids stale reminders and alert fatigue.
- Suggested implementation: Apply keyword+task match check in reminder workflow.
- Tags: reminders, cron, workflow
- Status: watch
