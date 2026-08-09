# Ops leg card: two-zone layout

**Date:** 2026-08-08 · **Status:** built (this PR) · **Owner report:** itinerary cards
"crowded and overrun" — route inputs truncated to "Colo…", date input clipped to an
"mm" sliver in the ops quote builder.

## Problem

The leg card laid out ~11 controls on one 56px flex row: reorder, number, From→To
inputs, date, ± steppers, Day-N tag, same/next-day chips, distance pill, price,
duplicate/✕. The row's only overflow protection was a container-query rescue tuned
**before** the trip calendar (2026-07-30) added the steppers/tag/chips, so a band of
pane widths (~620–1000px, exactly where a normal laptop lands) crushed the route
inputs to their 60px `min-width` floor and clipped the date off the card edge.

Third recurrence of this failure mode: the retired CSS comments record the chauffeur
"/09/" date-clip band, and the 620px rescue itself was the fix before that. Every new
control reopened the band because the one-row layout degrades by **clipping**.

## Decision (owner-picked from three options, mockup approved)

Compact (2-stop and stay) legs become **two-zone**:

- **Row 1 — identity:** reorder + number + From→To at the card's full width. The
  route inputs effectively never hit their minimum again.
- **Row 2 — `.ch-leg-sched`:** date/steppers/Day-N/chips left; `.ch-leg-money`
  (distance · price · duplicate/✕) right via `margin-left:auto`. `flex-wrap: wrap` —
  when space runs out the money group drops to its own line. **Wrap, never clip** is
  the card's overflow contract now.
- Tools row (+ Stop / Return to start / + Fees) gains a `--line-soft` hairline: the
  card reads as three quiet bands — *where → when·how-much → add-things*.
- **Multi-stop legs unchanged** — their header-band + stop-rail layout is already
  two-zone and doesn't crowd (route lives outside the main row). The band keeps the
  base row's new `flex-wrap` as its own safety valve.
- The 620px/720px container-query rescues and the `@supports` viewport fallback are
  **deleted** — they existed only to save the one-row layout.

Cost: compact cards ~28px taller. Accepted by owner (clipped controls are worse
than scroll).

## Toolbelt collapse (owner follow-up, same day)

The quiet-cards fade (2026-07-31) reserved the toolbelt's height at rest, and that blank
band read as wasted space at the foot of every card. Owner call: the **actions-only**
toolbelt now **collapses** at rest (height 0, padding/border/hairline gone) and expands on
hover / focus-within / `.is-revealed` — `height: 0 ↔ auto`, animated in Chrome via
`interpolate-size: allow-keywords`, an instant snap elsewhere. Expansion is always
downward, so the hovered card never shifts under the pointer; cards below move, animated.
The exceptions are unchanged and load-bearing: a row holding an **applied fee** or a
**route chip** never carries `.is-actions-only`, so money and state stay expanded at rest
(end-to-end pinned by `ops-fee-chips.spec.js`); touch devices keep everything visible.

## Submitted quotes don't react (owner follow-up, same day)

Once a quote leaves draft, `isEditableNow()` is false and `applyContentLock()` puts
`.ch-locked` on the editor, disabling every input, chip and button in the itinerary. The
hover reveal was still firing there — animating controls into view that cannot be pressed,
which is motion promising an affordance the quote no longer has. A locked quote's cards now
sit still: the actions-only toolbelt stays collapsed and the reorder / duplicate / remove
controls stay hidden, on hover **and** on focus-within.

The override sits last in the `@media (hover: hover)` block and at higher specificity
(`.ch-app.ch-locked …`) than the reveal rules, so it wins however those are later edited.
Applied fees and route chips are untouched: those rows never carry `.is-actions-only`, so a
locked quote still shows the money and state on its legs — only the dead controls go.

Note (unchanged, deliberate): touch devices have no hover, so the existing "everything
visible" fallback still applies there, on locked quotes as on drafts.

## Verification

`web-tests/e2e/ops-leg-card-layout.spec.js` (offline stub harness, no DB):

1. **Mid-band guard** (1240px viewport → pane in the historical band, premise
   asserted): no in-flow descendant may cross the card's right edge (±1px), and
   every route input must exceed 120px. RED on the old layout (inputs at 60px),
   GREEN on this one.
2. **Narrow guard** (1060px viewport): same invariants where the old wrap rescue
   used to fire — pins that the redesign doesn't trade the mid band's bug for a
   narrow-band one.

Full suites green at build time: 617 unit · 384 offline e2e · quote-tool/ops-ui
DB-backed suites (the known addleg flake passed 3/3 in isolation).

If a future control makes these specs fail, the card needs another row or a wrap —
not a higher breakpoint.
