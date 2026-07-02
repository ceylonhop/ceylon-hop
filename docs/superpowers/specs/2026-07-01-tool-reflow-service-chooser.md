# Quote Tool Re-flow — Customer-Journey Parity (explicit service chooser)

**Date:** 2026-07-01
**Status:** approved for build
**Milestone:** M11 (follows the fix campaign on PR #4)

## Why

The ops tool derived point-to-point vs chauffeur-guide *implicitly* from per-leg driver/car-stay
toggles, and offered sightseeing/waiting as leg *types* — diverging from the customer journey and
letting an operator add day-of add-ons to a chauffeur trip (overcharge; the customer keeps the
vehicle). Re-flow the tool to mirror the live site: **build the itinerary + dates, then choose the
service, seeing both prices side-by-side.**

## Decisions (owner, 2026-07-01)

| # | Decision |
|---|---|
| R1 | **Explicit service chooser** — Point-to-point vs Chauffeur-guide — replaces leg-derived product. Both totals shown **side-by-side**. |
| R2 | **Chauffeur-guide includes** sightseeing / waiting / safari-wait (car kept all day). The engine **refuses to charge** these on a chauffeur quote (done separately); the UI hides the toggles under chauffeur. |
| R3 | **Stay days only under Chauffeur-guide.** Point-to-point has no stay days (no vehicle being kept). |
| R4 | **Slim leg types** to movement kinds: Transfer · Airport pickup/drop-off · Train/luggage support · Stay day. Sightseeing & Safari-waiting are no longer leg types — they become per-leg **add-on toggles** available only in point-to-point. |
| R5 | **Drop per-leg Driver-stays / Car-stays toggles** — the explicit service choice replaces the derivation. |
| R6 | **Chauffeur hidden for single-day trips** (can't keep the car for days), mirroring `booking.js`. |

## Backend

### Engine rule (separate task, landing first)
Chauffeur quote never charges `sightseeing`/`waiting`/`safari-wait`; a warning notes each as included.

### `internalQuote.ts`
- **`service?: 'private' | 'chauffeur'`** added to the tool request (Zod enum, optional). When present it
  overrides the derivation; when absent, keep the current derive-from-legs fallback (back-compat).
- **Leg categories** slim to `['transfer','airport','train_support','stay_day']`. Add-on toggles:
  `addSightseeingFee`, `addWaitingFee`, and a new **`addSafariWait`** boolean. `collectExtras` maps the
  three toggles → `sightseeing`/`waiting`/`safari-wait`; the `safari_wait` *category* no longer exists.
- **`/estimate` prices the selected service** for the detailed response (breakdown/lineItems/summary/
  templates) exactly as today, and additionally returns a **`services`** object for the chooser:
  `{ pointToPoint: { total, deposit, amountDueNow } | { error }, chauffeur: { total, deposit, amountDueNow } | { error } }`.
  Chauffeur prices only when every leg has a date; otherwise `{ error: 'add a date to every leg' }`.
  Single-day trips → chauffeur `{ error: 'single-day — point-to-point only' }`.
- **Replace the car/van `comparison`** with `services` (the decision the operator actually makes is the
  service, not the vehicle; vehicle is chosen explicitly in the request). This also caps the hot path at
  two pricing passes (both services) instead of the prior four.

## Front-end (`quote-tool.html`)

- **Itinerary:** leg category `<select>` offers Transfer / Airport / Train-luggage / Stay day only.
  Stay day appears/counts only when `service === 'chauffeur'`.
- **Service card** (new, between Itinerary and Summary): a segmented Point-to-point | Chauffeur-guide
  control bound to `state.service`, each option showing its total from `services` (chauffeur option
  disabled + reason when its side returns `{error}` or the trip is single-day). Selecting one drives the
  Summary / Flags / Output tabs.
- **Per-leg add-ons** (`addSightseeingFee`/`addWaitingFee`/`addSafariWait`) render only when
  `service === 'private'`.
- **Remove** the per-leg Driver-stays / Car-stays toggles and the `hasDriver`/`hasCarStay` state.
- `state.service` defaults to `'private'`; if the itinerary spans multiple dates the chauffeur option
  becomes available.
- Save persists `service` in the tool payload so a reopened quote restores the chosen service.

## Testing

- **Engine/route:** service override respected; `services` object shape (both feasible; chauffeur error
  when undated / single-day); add-on toggles map to extras; chauffeur ignores the three included extras
  even if toggles somehow arrive; slim category enum rejects `sightseeing`/`safari_wait` as categories.
- **e2e:** choose chauffeur → add-on toggles gone, stay day available, both prices shown; choose
  point-to-point → add-ons available, no stay day; single-day trip → chauffeur disabled.

## Out of scope / preserved

All fix-campaign fixes stay. Vehicle tiers, lifecycle, rate card, auth unchanged. The car/van comparison
is removed from the UI (operator changes the vehicle dropdown to compare vehicles).
