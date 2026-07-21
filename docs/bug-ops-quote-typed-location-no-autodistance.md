# Bug (parked): typed leg location never triggers auto-distance in the ops quote tool

**Status:** OPEN, parked (captured 2026-07-21; not yet worked on)
**Area:** `api/src/routes/ops-ui.html` — quote tool leg editor
**Related:** [bug-ops-quote-typing-flicker.md](bug-ops-quote-typing-flicker.md) (same
change/blur handler tangle, different symptom); route-choice PR 3
(`feat/route-choice-ui`) also touches the generic change handler.

## Symptom

When an operator **types** a leg pick-up/drop-off location manually and tabs away —
never clicking an autocomplete suggestion — auto-distance never runs. The leg shows
"No distance" plus the `distCheck` flag, and ops must enter km by hand.

Went unnoticed because real ops usually click a suggestion, and the `acPick` path
schedules auto-distance correctly.

## Root cause (diagnosed 2026-07-21 during route-choice PR 3)

Two handlers race on blur, and the wrong one wins:

1. The browser fires a native `change` event on blur. The **generic delegated change
   handler** (`app.addEventListener('change', ...)`, which matches any
   `[data-leg][data-field]` element and commits via `updateLeg(legId, {field: val})`)
   commits the location **first** — without deleting `_distCache` and without calling
   `scheduleAutoDistance`.
2. The **dedicated per-input blur handler** (the one meant to trigger auto-distance
   "when the user finishes typing manually", per its comment) runs ~200 ms later, sees
   `leg[field] === input.value` (already committed by step 1), and skips.

## Suggested fix

Either:

- In the generic change handler, when the field is `pickupLocation`/`dropoffLocation`,
  mirror the blur handler's full commit path: delete `_distCache[legId]`, reset
  `manualDistance`/`autoMatched`, call `scheduleAutoDistance`, plus the
  `routeVariant`/`routeOptions`/`_sameRoute` resets already present after route-choice
  PR 3 merges; **or**
- Make the generic change handler skip location fields entirely and let the blur
  handler own them.

## Repro / test plan

Playwright offline harness (see `web-tests/e2e/ops-quote-route-choice.spec.js`'s
`stubOps` after route-choice PR 3, or `ops-autocomplete.spec.js`):

1. Type into `.ch-tl-title[data-field="pickupLocation"]`.
2. Press Tab (no suggestion click).
3. Observe **no** `/admin/quote/distance` request fires.

Fix should ship with an e2e regression test for exactly that sequence; run
`npm run test:all`.

## Coordination

The generic change handler is also modified by route-choice PR 3
(`feat/route-choice-ui`, stacked PRs #83→#85→#88). If that stack isn't merged yet when
this is picked up, coordinate so the two changes don't conflict — the fix's reset list
depends on whether PR 3's `routeVariant`/`routeOptions`/`_sameRoute` fields exist yet.
