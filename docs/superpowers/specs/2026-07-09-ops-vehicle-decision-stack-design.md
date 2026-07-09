# Ops quote tool: vehicle as part of the pricing decision stack — design

**Date:** 2026-07-09 · **Owner direction:** Roshen ("people price without picking a vehicle;
don't be afraid to change things up") · **Scope:** api/src/routes/ops-ui.html + web-tests.

## Problem

Operators build the itinerary, look right for the price, and see "—". The vehicle select sits
at the end of the customer header row (skimmed past), the instruction renders as quiet mid-pane
text, and the warnings area says "✓ No warnings. This itinerary looks clean to send." while the
quote is unpriceable — a contradiction. Root cause: vehicle is a PRICING decision presented as a
customer detail, physically separated from its sibling decisions (service, price).

## Design — the money pane is the full pricing decision stack

1. **Vehicle chips move into the money card**, above the service chooser:
   `[Car · 3] [Van 6 · 6] [Van 9 · 9] [Van 14 · 14] [Custom]` — seat caps from the live rate
   card (`vehicleCaps`). Selected chip = active. Click → the existing
   `mutate({ vehicleType, customRatePerKm: null })` (GL-1d rate-clear preserved) via the
   existing data-action delegation (`data-action="setVehicle" data-veh="<toolId>"`).
2. **Pax-aware**: a chip whose pax cap < current pax renders with a warn tint + "seats N" hint,
   still clickable (the existing capacity-warning framework flags an over-cap selection).
3. **No-vehicle state is loud and local**: chip row gets an amber highlight + caption
   "Pick a vehicle to price this trip"; the estimate-error line points at the chips; the
   warnings pane shows a real "Vehicle not set" warning card instead of the false all-clear.
4. **Rate $/km input** (van_14/custom, `#f-customRate`, unchanged id/handler) renders directly
   under the chips.
5. **Header card** loses the Vehicle + Rate fields: Name, WhatsApp/Email, Pax, Bags only.
6. No pricing/payload/save changes; `state.vehicleType` and all consumers untouched.

## Test impact
- New standalone `ops-vehicle-chips.spec.js` (offline, stubbed API): chips render in the money
  pane with the selected state; no-vehicle shows the warning card and NOT the all-clear;
  clicking a chip prices (stubbed estimate) and clears the warning; pax 5 warn-tints Car;
  van_14 reveals the Rate $/km input under the chips; header has no `#f-vehicleType`.
- DB-gated `quote-tool.spec.js` (CH_E2E_API): `chooseVehicle` helper + the direct
  `#f-vehicleType` selectOption switch to chip clicks — updated blind (cannot run locally),
  flagged in the commit.
