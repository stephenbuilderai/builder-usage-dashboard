# ROUTING.md — Builder Worker Routing Contract

## Purpose
This file is the hard routing contract for Builder task execution.
Builder must classify work first, then route to the best ACP worker before execution.

## Worker Roles

### Gemini ACP
Primary for:
- UI design
- UX flow and hierarchy
- visual polish
- component styling
- Tailwind/shadcn presentation work
- frontend-heavy implementation
- landing pages
- dashboard layout and usability improvements

Gemini may make code changes when the task is mostly presentation-layer or frontend implementation.

### Codex ACP
Primary for:
- backend logic
- APIs
- database changes
- auth
- infra/config
- refactors
- debugging
- reliability fixes
- integration hardening
- lint/type/build/test remediation

Codex should own final verification whenever a task touches backend/integration risk or correctness-critical flows.

## Task Classes

### `ui_design`
Examples:
- redesign this screen
- improve hierarchy
- make dashboard cleaner
- fix UX flow

Route: Gemini ACP

### `frontend_impl`
Examples:
- build this page in Next.js
- improve component styling
- implement this dashboard UI
- polish mobile responsiveness

Route: Gemini ACP

### `engineering`
Examples:
- build API endpoint
- connect Supabase
- fix auth
- refactor server logic
- diagnose bug

Route: Codex ACP

### `integration_qa`
Examples:
- wire frontend to backend
- run/fix lint type build tests
- smoke test and harden
- productionize prior UI work

Route: Codex ACP

### `mixed_feature`
Examples:
- ship this feature end to end
- redesign and implement this product flow
- build full-stack dashboard feature

Route sequence:
1. Gemini ACP for UI/design/frontend slice when relevant
2. Codex ACP for integration/hardening/verification

## Routing Decision Rule
Choose worker by the task's center of gravity:
- visual / UX / presentation / frontend feel -> Gemini
- correctness / architecture / backend / integration / debugging -> Codex

If uncertain, prefer:
- Gemini for frontend-facing ambiguity
- Codex for system-risk ambiguity

## Execution Rules
1. Classify task before execution.
2. Use ACP worker by default; do not silently replace ACP with local execution.
3. Retry ACP up to 3 times if worker returns empty/unavailable.
4. If still unavailable, return: `Status: blocked (ACP unavailable)`.
5. For mixed tasks, do not collapse both phases unless one worker can finish the task cleanly with verification.
6. Builder must return one merged result, not raw worker output.

## Output Contract
Builder final report must include:
- shipped
- changed files/artifacts
- verification results
- open risks
- next step

## Examples
- "Make this landing page look premium" -> Gemini
- "Implement Supabase auth and protect routes" -> Codex
- "Redesign dashboard and ship it" -> Gemini first, Codex second
- "Fix failing build after UI refactor" -> Codex
