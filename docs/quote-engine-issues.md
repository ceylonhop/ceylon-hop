# Quote Engine + Internal Tool — Issues Log

**Things found while planning that need a decision or a later fix.** Not blockers for starting the
build unless marked 🔴. Numbers below were computed by a throwaway validator against the locked rate
card + 10% buffer, so they're exact.

---

## ✅ I1 — Buffer vs chauffeur idle-minimum — RESOLVED: option (b), travel km only
The 10% buffer applies to **travel km only**; the synthetic idle-day minimum km are **not** buffered.

| Trip | Team (historical) | Engine, no buffer | Engine (final: buffer on travel only) |
|---|---|---|---|
| **Emma** (9 days, 4 idle) | $690 | $867 | **$903.80** |
| **Ayan** (3 days, 1 idle) | $235 | $323.50 | **$340.98** |

Chauffeur still runs above the historical hand-quotes (intended — idle days bill + 25% markup), but
the buffer no longer compounds on the idle minimums. Baked into plan **Task 12**.

## 🟠 I2 — Buffer pushes every per-km quote ~10% above the validated examples
The worked-examples doc validated `km × rate` *without* buffer (Tatia 80 km = $36.80 ≈ team $37). With
the buffer, the **quote total** for that leg is **$40.48**. The per-km **rate** still validates
(`legPriceCents` is unchanged and buffer-free); the buffer is a deliberate new uplift on top, like the
idle-day rule. **Confirm** it's intended across the board (it is, per your "keep 10% buffer" — logged
so it's explicit, and so the worked-examples "team actual" comparisons are understood as *historical*,
pre-buffer).

**⚠️ Magnitude (do not skim):** this is a **~10% uplift on every per-km quote on every surface**,
stacking on the 25% markup. Example: Airport→Sigiriya was **$69** on the ops sheet → **$75.90** unbuffered
→ **~$83.50** buffered. If the website-display follow-up ever wires the engine to the public site, that's
a visible **~20% price increase vs the live frozen formula** — make a conscious taper decision before
doing so. Founder's call, but logged at full magnitude.

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

## 🟠 I10 — Engine result lacks `bufferKm` / `billableKm` fields the tool UI needs
The tool's headline "distance → +10% → billable" breakdown needs the result to expose `bufferKm` and
`billableKm`, but the base engine plan only puts `distanceKm` in a `LineItem.meta`. **Add these fields**
to the private/chauffeur result in Phase 0 (engine), or the tool's pricing summary can't render the
breakdown. (Found by review; reflected in the tool plan.)

## 🟠 I11 — `opsAuth` has no reusable middleware to mount the tool behind
The tool plan says `/admin/quote` mounts "behind the `opsAuth` middleware," but `opsAuth.ts` only
exports pure functions — the actual cookie/key check is **inline** in `ops.ts` (~lines 38–44). **Phase 1
must first extract** a `requireOps(auth)` middleware factory (and refactor `ops.ts` to use it), or inline
the same check in `internalQuote.ts`. The auth config it needs is `{ supportKey, founderKey,
sessionSecret, adminApiKey }`, not a single key.

## 🟠 I12 — Typed-leg → `QuoteRequest` mapping is unspecified
A trip is a timeline of mixed typed legs (Transfer / Stay day / Sightseeing / Safari / Airport), but the
engine takes **one product per call** (private XOR chauffeur). The tool plan doesn't say how a mixed
itinerary (some "keep car+driver" days, some plain transfers) collapses into request(s). **Needs a
worked rule before Phase 1** — e.g. "any keep-car-driver day → the whole trip is one chauffeur request;
otherwise N independent private legs."

## 🟡 I13 — FX rate is a hardcoded const, not ops-editable
`fxUsdToLkr` lives in `rateCard.ts`, and tool-plan Phase 2 defers rate-card editing — so "ops updates it
occasionally" actually means **a PR + deploy each time**. Either make it an env var / config value now,
or accept that the LKR figure is engineer-maintained in v1.

## 🟡 I14 — Out-of-order execution caveat
Task 4 asserts the unbuffered `quotePrivateLegs` subtotal (6350); Task 11 supersedes it to 6718. If tasks
run **out of order** (parallel), Task 4's test goes red after Task 11. Execute Tasks 1–14 **in order**;
the changelog table lists every superseded value.

## ✅ I15 — Floor-warning strings hardcoded `$29`/`$50` — **RESOLVED** (now `$${floorCents[vehicle]/100}`)
The floor-warning text derives `$29`/`$50` from a literal (`vehicle === 'car' ? '$29' : '$50'`) instead
of `RATE_CARD.floorCents[vehicle] / 100`. If a floor ever changes, the warning copy silently drifts.
One-line follow-up; not merge-blocking (flagged in the whole-branch review).

## ✅ I16 — Shared `marginEstimateCents` = total — **RESOLVED** (field is now `number | null`, null for shared)
Shared cost isn't modelled, so `marginEstimateCents === totalCents` for shared quotes (mitigated by a
`"margin not modelled for shared"` warning). The internal tool must not present a shared margin as real;
a cleaner follow-up would omit/null the field for shared rather than report 100%.

## ✅ I17 — End-to-end review (architect + QA, post-build) — findings RESOLVED
After the engine was built, run live over HTTP, and reviewed end-to-end, the following were fixed (fix
wave, re-reviewed Approved):
- **Van bag cap enforced** — `selectVehicle` now returns `too_big` when `bags > 6` (your decision:
  "contact us").
- **`/quote` rate-limited** (spec §9); **CORS allows `x-internal-key`**; `INTERNAL_QUOTE_KEY` via `config`.
- **Extras single-source** (`EXTRA_CODES` drives both the type and the Zod enum — no more drift).
- **Shared margin → `null`** (I16); **floor-warning copy from the rate card** (I15).
- **Tests added (21):** wrong-key margin strip (security), unknown-extra→400, empty-legs→400, chauffeur
  margin value, deposit-cap boundary, and invariants (integer totals, deposit ≤ cap, due ≤ total). 242 green.

**Still deferred to the tool phase (not fixed now):** relocate `billableKm` to a neutral module
(cosmetic); expose top-level `bufferKm`/`billableKm` on the result (I10 — the tool needs it).

---

_Last updated: 2026-06-29. Add new issues as they surface; tick/strike when resolved._
