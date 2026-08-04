# Website per-leg rides — bringing the ops leg model to the customer site

**Status:** A2 (server) built 2026-08-03. Everything else open.

The ops quote builder holds a trip as a list of leg OBJECTS, each its own ride with its own
stops, distances, date, fees and route choice. The website holds a trip as one flat chain of
stop names, where legs are implied by adjacency — so there is nothing to hang a stop, a fee or
a route choice on. This closes that gap one piece at a time.

## Decisions made (A2)

**D1 — `legs` is a GROUPING of `stops`, not a replacement.**
It says which consecutive hops are one day's ride, and nothing else. `stops`, `nights` and
`dates` keep their exact existing meaning. This is what lets the confirmation email, the ops
queue and the booking card render a grouped trip with zero changes: they all read the flat
chain, which is still there and still correct.

The alternative — legs as the source of truth, with `stops` derived — would have re-indexed
`dates` per leg, and `journey()` in `notifications.ts` pairs `dates[i]` with `stops[i]` to
print "depart <date>" under each stop. That pairing would have silently moved dates onto the
wrong stops.

**D2 — the client never sends distances.**
The ops tool sends `segmentKms` because an operator may override them. A customer may not: leg
distance is a pricing input, so a client-supplied km lets the payer choose their own price. The
server resolves every segment, as it already does for the flat chain. `TripRide` is
`{ stops }` and is `.strict()`, so a km can't be smuggled in.

**D3 — `dates` stays indexed by the stop chain.**
`dates[i]` is still "the day you depart `stops[i]`". A ride takes the date of the stop it sets
off from; hops it passes through mid-day contribute no date of their own, which is truthful —
a multi-stop leg IS one day's journey.

**D4 — a mismatch is refused, not reconciled.**
If `legs` doesn't flatten back to `stops`, the route 400s with `legs_stops_mismatch`. A booking
whose displayed route and priced route disagree is how a quote→booking conversion silently lost
its middle stops once already.

**D5 — 8 stops per ride**, matching the ops tool, so the two can't disagree about what fits in
a day.

## Why the grouping changes the price

The engine buffers km and applies the vehicle floor per RIDE, not per segment, and the
chauffeur model counts idle days as `span − travelDays.length`. So `[A,B,C]` as one ride is
buffered and floored once; as two rides, twice. Grouping is a pricing decision, not a display
one — which is exactly why it has to reach the server rather than living in the UI.

## Open decisions (owner)

**O1 — should a customer group hops at all?**
A2 makes the wire capable of it. It does not decide whether the booking UI should expose
"these two hops are one day" as a control, or whether grouping should be derived automatically
(e.g. legs sharing a date become one ride). Automatic is less rope; explicit matches ops.
This decides the shape of the UI slice.

**O2 — website "stay" legs.**
`plan.js` models a stay as a leg (`{type:'stay'}`), but stays are sent as `nights[]`, not as
stops. Ops has a `stay_day` category on the leg itself. Whether the two models converge is
undecided, and it only matters once the UI holds leg objects.

**O3 — which of the ops per-leg controls are customer-facing at all.**
Manual distance override, `customRatePerKmCents`, margin and leg category (`airport` /
`train_support`) are operator tools. Recommendation: none of them ship to the website.
"Confirm location" should become automatic server-side (stage 2 of positive location
identification), not a customer chore.

## Not built yet

Per-leg extras with `legIndex` (server already supports it; the website sends bare codes and
sends none at all on trips), a public route-variants endpoint (`/admin/quote/distance?compare`
is behind `quote:manage`), wider vehicle tiers in the generated front-end mirror, and the leg
card UI itself.
