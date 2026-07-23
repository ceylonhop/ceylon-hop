# Known bugs — running log

Quick-capture log for **one-off bugs discovered while doing other work**, so they get
recorded instead of derailing the task in hand. This is the home for "I noticed X is broken
but it's not what I'm here to fix."

**Process (refines the maintenance rule "surface adjacent issues, don't fix them inline"):**
when you find a bug that's out of scope for the current change —

1. **Do not fix it inline.** Stay on the current task.
2. **Append a row below** — date, one-line symptom, `file:line` (or area), and a one-line
   root-cause guess if you have one. Keep it terse; the point is to not get distracted.
3. **Tell the owner** in a one-line note (and/or drop a task chip) so it's visible.
4. For a bug we deliberately **park with a full analysis**, give it its own
   `docs/bug-<slug>.md` and link it from the row here.
5. When it's fixed, mark the row **DONE** (with the PR) or delete it.

| Date | Symptom | Where / root-cause guess | Status |
|---|---|---|---|
| 2026-07-21 | Ops quote tool flickers and blanks the price panel while typing a leg location | `api/src/routes/ops-ui.html` — background `render()` orphans the focused input; its delayed `blur` commits half-typed text → re-price → render → loop. Full report → [bug-ops-quote-typing-flicker.md](bug-ops-quote-typing-flicker.md) | **DONE** — PR #97 (guards) + PR #99 (morphdom diff-render); in prod via #101 |
| 2026-07-21 | Typed (not clicked) leg location never triggers auto-distance — "No distance" + `distCheck`, ops enter km by hand | `api/src/routes/ops-ui.html` — generic delegated `change` handler commits the location on blur before the per-input blur handler runs, so the blur handler sees no diff and skips `scheduleAutoDistance`. Full report → [bug-ops-quote-typed-location-no-autodistance.md](bug-ops-quote-typed-location-no-autodistance.md) | **DONE** — PR #103 (D3 fix, typed commit schedules auto-distance; regression spec `ops-typed-distance.spec.js`) |
