# Bug: ops quote tool flickers and blanks prices while typing a leg location

**Status:** OPEN — root-caused, not yet fixed (parked 2026-07-21)
**Area:** `api/src/routes/ops-ui.html` (the ops quote builder, `QuoteView`)
**Reported by:** Roshen, while quoting a multi-day itinerary on staging
**Severity:** medium — cosmetic churn + transient loss of the price panel; no bad data is saved

## Symptom

While typing into a leg's pickup/drop-off location field, the itinerary/summary
sections **flicker** (rapid repaint) and the **prices disappear** from the quote panel.
It settles once the operator stops typing and the leg is complete.

## Reproduction

1. Open a quote, fill trip basics, add a leg with a valid pickup + drop-off + date so it
   prices (panel shows a total).
2. Add another leg; pick/commit its pickup (this schedules an estimate + auto-distance).
3. Immediately start typing into the new leg's drop-off field, character by character.
4. Observe: the sections flicker and the price panel blanks to a "To price…" message
   while typing; repeated `/admin/quote/estimate` (and `/admin/quote/distance`) calls fire.

## Root cause (two compounding defects)

### Defect B — the flicker loop (the primary bug)

Background async completions call `render()` while the operator is typing:

- `runAutoDistance()` → `updateLeg()` → `render()` + `refreshEstimate()`
- `_runEstimate()` → `render()`

`render()` replaces the panel's DOM wholesale (`document.querySelector('#quoteRoot .ch-app').innerHTML = html`)
and then restores focus to the fresh input node. The **old, now-detached input node fires a
delayed `blur`** (a `setTimeout(…, 200)` in the blur handler that `attachAutoComplete()`
wires up). That handler only guards against an *unchanged* value:

```js
var currentVal = input.value;
if (leg[field] !== currentVal) { … commit … scheduleAutoDistance(legId); refreshEstimate(); }
```

Mid-type, the detached node's value differs from the (lagging) state, so the guard passes
and it **commits the half-typed text** as a finished place → schedules auto-distance on
garbage + a re-price → another `render()` → detaches the next node → another delayed blur →
commit → … a self-sustaining loop for as long as the operator keeps typing.

**Fix (root cause):** a detached node must never commit. Add, at the top of the blur
`setTimeout` callback in `attachAutoComplete()`:

```js
// A background re-render (a landing /estimate or auto-distance result swaps the panel's
// innerHTML) detaches this input mid-type while focus is in it; the orphaned old node then
// fires this delayed blur. The live replacement node holds the real value and fires the
// real blur — so an orphaned node must NEVER commit (doing so re-triggered auto-distance +
// a re-price → render → another orphan blur: the typing-flicker loop that blanked the price
// panel).
if (!document.contains(input)) return;
```

Keep the existing value-changed check as a secondary no-op guard for the attached case.
This severs the loop at its source; the live node still handles the real blur when the
operator actually leaves the field, and focus/value are already preserved by
`captureEditorFocus`/`restoreEditorFocus`.

### Defect A — price panel blanks on any transient error (secondary, OUT OF SCOPE)

Server-side, `resolveAndPrice()` throws a 400 for the **whole** estimate the moment any one
leg can't be resolved (`resolveLegKm` in `internalQuote.ts`). The client then sets
`lastEstimate = null` and the money panel renders the error *instead of* the last good
prices (`renderSummaryCardBody` returns early on `lastEstimateError`). So while any leg is
mid-edit/incomplete, every already-priced leg's number vanishes too.

This is arguably correct (you can't total an incomplete itinerary) and fixing it "keep the
priced legs visible while one leg is incomplete" would need **server-side partial pricing** —
a separate, larger change. **Not part of this bug's fix.** Once Defect B is fixed, the panel
stops *flickering*; it may still show a steady "To price…" message until the leg is complete,
which is expected.

## Test approach

An **offline stubbed harness** already exists for the ops builder (no DB) — see
`web-tests/e2e/ops-chauffeur-date.spec.js` and `web-tests/e2e/ops-addleg-date.spec.js`
(register the `**/admin/**` catch-all route FIRST, then the specific stubs). Reuse it to
add a regression spec that:

1. Boots the builder, prices one leg, commits a second leg's pickup.
2. Types a partial place into the second leg's drop-off (no commit).
3. Lets a background `render()` land (e.g. the scheduled estimate/distance completes).
4. Asserts the loop does **not** occur — the observable signature is that the operator's
   in-progress text is preserved and **no** extra `/admin/quote/estimate` /
   `/admin/quote/distance` calls fire from the orphaned blur (count them via `page.route`),
   i.e. the half-typed value is not committed.

Prove it red on current code (spurious commits/calls) → green after the `document.contains`
guard.

## Notes

- `QuoteView` exposes only `{ init, teardown, openQuote, startNew }`; `state`/`render` are
  module-private, so the test must assert on observable DOM/network, not internals.
- Do not "fix" this by re-pricing per keystroke — that was tried and reverted (it re-rendered
  mid-type and popped the suggestion menu open repeatedly; see the comment in
  `attachAutoComplete`).
