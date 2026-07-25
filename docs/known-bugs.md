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
| 2026-07-25 | `ops-chauffeur-date.spec.js:49` fails and `ops-addleg-date.spec.js:51` / `ops-autocomplete.spec.js:85` are flaky on clean `main` | `api/src/routes/ops-ui.html` — render race, NOT a date bomb (both date specs use dynamic dates since 7b93b4e). The leg-date `change` fires `render()`, which replaces the `Add leg` button between Playwright's mousedown and mouseup ~140 ms later; the delegated `[data-action]` handler then no-ops and the second leg is never created. Same mechanism re-attaches basics inputs mid-type in the autocomplete spec | Open |
| 2026-07-25 | Live date bombs in the Playwright suite — will start failing ~2026-08-08 | `web-tests/e2e/plan-dates.spec.js:77-295`, `ops-itin-map.spec.js:125`, `date-correctness.spec.js:51,125` hard-code `2026-08-0x` literals. The `api/src/testSupport/dates.ts` helper migration (`nextIsoWeekday`/`futureIsoDate`) never reached `web-tests/`, which has no equivalent module | Open |
| 2026-07-25 | `<image-slot>` ignores author `aspect-ratio` — ~15 slots collapse to a 160px-tall letterbox instead of their intended box (e.g. `about-gal-*`, `about-team-*`, `blog-post-*`, `why-jetty`, `why-driver`) | `image-slot.js` `:host{...width:240px;height:160px}` — pages set `width:100%;aspect-ratio:…` inline but never override `height`, and an explicit height beats `aspect-ratio` (which only ever computes a *missing* dimension). Fix is either `height:auto` at each call site or dropping the fixed `height` from `:host` when an aspect-ratio is set | Open — the 3 slots filled in PR (why-photo, about-train, about-tea) got `height:auto`; the rest still collapse |
| 2026-07-25 | `plan-dates.spec.js:247` flaky under parallel load — `.place-option` click fails "element was detached from the DOM"; passes on a clean single-spec run | `plan.js` — same render-race class as the ops row above, now on the customer planner: a `render()` replaces the autocomplete option between Playwright's mousedown and mouseup | Open |
| 2026-07-25 | Playwright e2e (200+ tests) gates nothing — it is not in `ci.yml`, whose 3 required checks are api tests, codegen parity, and web-tests **unit** only | `.github/workflows/ci.yml` — this is why #150 could rename `#pax` → `.pax-pill` and silently break 2 e2e tests from #147 on a green main. Owner chose 2026-07-25 to add e2e to CI as its own later PR | Open |
| 2026-07-25 | `plan-dates.spec.js:157` fails on clean `main` — expects the over-10h hint to say /too much for one day/i, UI now says "more than is safe or enjoyable in one go" | Copy drift: the `#dates-drive-hint` wording changed without updating the assertion. Verified failing on pristine `origin/main` (stash-bisected). NOT fixed here because it's unclear whether the reword was intended or the assertion was the guard — owner to confirm which is canonical | Open |
