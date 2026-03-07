# Builder Usage Dashboard — Design Overhaul Plan

## Goal
Upgrade the dashboard from “functional/internal” to “operator-grade control center”: clearer hierarchy, faster scan, cleaner visuals, and better mobile readability.

## Scope (V1)
1. **Visual system refresh**
   - New color tokens (background, panel, accent, semantic colors)
   - Stronger typographic hierarchy
   - Unified spacing/radius/shadows

2. **Layout refresh**
   - Better top header with title, status badges, and last update
   - KPI cards redesigned for immediate readability
   - Tabs redesigned as modern segmented navigation

3. **Data readability improvements**
   - Improved table density and contrast
   - Better chip/badge styles
   - More obvious section separation

4. **Mobile/Responsive polish**
   - Better card wrapping and compact paddings
   - Cleaner tab behavior on small screens

5. **No data-model change**
   - Keep existing metrics and logic intact
   - Pure UI/UX overhaul

## Implementation Steps
1. Update dashboard CSS design tokens + components in `openclaw-usage.js`.
2. Adjust header + KPI markup for new visual hierarchy.
3. Keep all existing tabs/data sections; restyle only.
4. Rebuild dashboard artifacts via `node openclaw-usage.js capture`.
5. Commit + push to `master` for immediate deploy.

## Acceptance Criteria
- Dashboard feels materially different at first glance.
- Key metrics are visible without hunting.
- No broken data sections or JS tab/filter behavior.
- Deployed and visible after cache refresh.
