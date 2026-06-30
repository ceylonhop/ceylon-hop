# Quote Engine + Internal Tool — Issues Log

**Things found while planning that need a decision or a later fix.** Not blockers for starting the
build unless marked 🔴. Numbers below were computed by a throwaway validator against the locked rate
card + 10% buffer, so they're exact.

---

## 🔴 I1 — The 10% buffer STACKS on the chauffeur idle-minimum (and the 25% markup)
For chauffeur, buffer applies to *all* billable km, including the synthetic idle-day minimums. Effect:

| Trip | Team (historical) | Engine, no buffer | Engine, +10% buffer |
|---|---|---|---|
| **Emma** (9 days, 4 idle) | $690 | $867 (+26%) | **$922.20 (+34%)** |
| **Ayan** (3 days, 1 idle) | $235 | $323.50 (+38%) | **$345.58 (+47%)** |

This is three uplifts compounding (markup × idle-min × buffer). **Decision needed:** should the buffer
apply to chauffeur billable km **(a)** including idle minimums (current plan), **(b)** only to actual
travel km, or **(c)** not to chauffeur at all? The plan currently does (a); easy to change.

## 🟠 I2 — Buffer pushes every per-km quote ~10% above the validated examples
The worked-examples doc validated `km × rate` *without* buffer (Tatia 80 km = $36.80 ≈ team $37). With
the buffer, the **quote total** for that leg is **$40.48**. The per-km **rate** still validates
(`legPriceCents` is unchanged and buffer-free); the buffer is a deliberate new uplift on top, like the
idle-day rule. **Confirm** it's intended across the board (it is, per your "keep 10% buffer" — logged
so it's explicit, and so the worked-examples "team actual" comparisons are understood as *historical*,
pre-buffer).

## 🟠 I3 — FX rate value is not set, and LKR display drifts with it
`fxUsdToLkr` is a manual config (placeholder **320**). Two things: (1) set the real rate before use;
(2) because the engine is USD-canonical and LKR is converted, the LKR figure shifts whenever ops edits
the rate — fine for a quote, but ops must keep it current. Live auto-refresh is deferred.

## 🟠 I4 — USD-canonical vs LKR settlement (payment path, not this tool)
PayHere settles LKR; the engine prices USD. If the LKR quote ever becomes the charge, FX drift between
quote-time and charge-time is unhandled. Out of scope here (the booking/charge path is the engine's
separate follow-up), but logged so it isn't forgotten.

## 🟡 I5 — Per-leg rounding vs total reconciliation (the design's "heads up" note)
Your design surfaces "sum of per-leg line items ≠ rounded quote total." Our engine sums per-leg with
no separate buffered-total line, so it doesn't reproduce that exact reconciliation. Decide in Phase 2
whether the UI needs the "send line items or the single total" note.

## 🟡 I6 — Shared pricing model still open
Per-corridor (flat) vs per-leg-pair, plus the canonical seat prices and flat-vs-tiered. Gates only the
shared path; the `quoteSharedLegs` function is correct regardless. (You're providing this later.)

## 🟡 I7 — Buffer rounding is half-up
`billableKm = Math.round(km × 1.10)` → `billableKm(75) = 83`, `billableKm(35) = 39`. Deterministic and
documented; just noting the half-up behaviour so nobody is surprised.

## 🟡 I8 — The UI (Phase 2) is verified by rendering, not unit tests
The pricing engine + API are fully TDD'd. The page itself is verified via the preview (render →
introspect → match the hand-calc quotes from this session), not unit tests. Lighter assurance on the
UI layer — flagged.

## 🟡 I9 — Vehicle auto-upgrade must be shown, not hidden
The engine prices the *larger* of requested/required vehicle (a car request for 6 pax is priced as a
van, with a warning). The UI must surface that warning, not present a fake cheaper "car" price.

---

_Last updated: 2026-06-28. Add new issues as they surface; tick/strike when resolved._
