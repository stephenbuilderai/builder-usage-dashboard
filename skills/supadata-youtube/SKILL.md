---
name: supadata-youtube
description: Fetch and analyze YouTube videos via Supadata transcript API first, with strict fallback only if Supadata is unavailable. Use for any request to watch/summarize/extract insights from YouTube links.
---

# Supadata YouTube

## Workflow (mandatory order)
1. Extract YouTube video ID from the URL.
2. Try Supadata transcript API first.
3. If Supadata returns no transcript or hard error, use fallback methods.
4. State clearly which source was used (Supadata or fallback).

## Supadata-first request
Use authenticated request first (Supadata requires API key).

Preferred execution:

```bash
KEY=$(cat /data/.openclaw/workspace/.secrets/supadata.key)
curl -sS -H "x-api-key: $KEY" "https://api.supadata.ai/v1/youtube/transcript?videoId=<VIDEO_ID>"
```

Alternative URL pattern:
- `https://api.supadata.ai/v1/youtube/transcript?url=<ENCODED_YOUTUBE_URL>`

If key file is missing, report configuration issue clearly and request key setup.

## Output contract
Always return:
- Core summary (what the video is about)
- Reproducible blueprint (how to duplicate the setup)
- Risks/constraints (cost, reliability, policy limits)
- Next 3 concrete actions

## Fallback chain (only after Supadata fails)
1. YouTube captions/subtitles extraction
2. Other transcript extraction path
3. Last resort: metadata-only analysis + explicit limitation note

Never skip straight to metadata-only if transcript extraction is still feasible.

## Notes
- Prefer concise execution-first summaries.
- Do not claim full video understanding without transcript access.
- Preserve exact user intent (e.g., "duplicate this") as the main deliverable.