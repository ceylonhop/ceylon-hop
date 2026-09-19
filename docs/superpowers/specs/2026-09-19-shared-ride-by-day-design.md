# Shared ride by day — design

**Status:** approved by owner 2026-09-19 (mockup: https://claude.ai/artifact/VTjPrQDVmePpMbbxrub7Bk)

## Why
The scheduled shared seat runs **Wed & Sat** only, but the search page ignores the date: a
traveller who searches Negombo → Sigiriya for a Thursday sees a price, pickup times and "Book a
seat", with nothing saying the van does not run that day. Five days a week that search is a dead
end or a wrong booking. The ride board can fill those days — if search sends people there, and if
the two products are kept from emptying each other's vans.

The scheduled seat itself does not change: guaranteed departure, paid at booking. (The owner
intends to retire it later, once the board has run a real cutoff charge. This work does not
depend on that.)

## Stories
1. Off-day search tells the truth: "No shared ride on Thu 24 Sep — it runs Wed & Sat".
2. Flexible traveller switches to the nearest guaranteed date in one tap.
3. Fixed-date traveller starts their own ride for that date ($0 now, runs if 3 join).
4. The two products are always labelled by certainty and payment, and never borrow each other's
   promise: *guaranteed · pay at booking* vs *runs if 3 join · $0 until it's confirmed*.
5. With no date, the card says "Runs Wed & Sat" + a quiet "Other days? Start a ride".
6. If someone already started that route and date, search offers "Hop on" instead of "Start".
7. The board refuses a new ride on a route and day the scheduled van already runs.

## Design
### Search results — the shared card has three states (`search.js`)
Let `runs = shared.days.includes(weekday(date))`.
- **A · date is a service day** — today's card; line reads "✓ Runs Sat 26 Sep · guaranteed
  departure · pay at booking"; CTA "Book a seat".
- **B · date is NOT a service day** — ribbon becomes a muted "Runs Wed & Sat"; body is:
  "No shared ride on <date>" → the nearest service day **before** (if not in the past) and
  **after**, each "Switch date →" → "or keep <weekday>" → **Start a ride for <date>** (outlined,
  secondary). "Book a seat" is replaced, not disabled.
- **C · no date** — today's card + "Runs Wed & Sat" + quiet link "Other days? Start a ride".
- Phone jump link (from #631) reads "Shared ride: Wed & Sat · from $27.49 ↓" in state B.
- **Switch date** = same search URL with `date` replaced, plus `#shared` so the page lands back
  on the card.
- **Already going (story 6):** in state B, ask the public `GET /board/dupe?from&to&date`. A hit
  swaps "Start a ride" for "N of M going <date> — Hop on" → `board.html#/<code>`. A miss, an
  error, or a slow answer leaves "Start a ride" — the lookup only ever upgrades the card.

### Board — a way in that opens the start form (`board.js`)
`board.html?from=<name>&to=<name>&date=<iso>&start=1` filters the board (as `from`/`to` already
do) **and** opens the start form pre-filled with route and date. Fields stay editable. `start=1`
is removed from the address once consumed so a reload does not re-open the form. The existing
"X's list already goes there — join it instead?" nudge still runs.

### Board API — no second van on a scheduled day (`api/src/routes/rideBoard.ts`)
`POST /board`: when the leg is a scheduled product (`sharedProductFor`) **and** the date's
weekday is one of the corridor's `serviceDays` → `409 { error: 'scheduled_day', scheduled:
{ date, time, pickup, seatPrice } }`. **Whole day, not only the van's slot**: a traveller who can
flex between 7:30am and the afternoon is exactly the passenger the scheduled van needs. Legs we
do not sell as a scheduled seat are never blocked.
The start form shows this inline — "We already run this on Saturdays…" + **Book the guaranteed
seat →** (the search page for that route and date) — and, before submitting, whenever the chosen
route and date already meet the rule, so the traveller is not sent through sign-in to be refused.

## Out of scope
Retiring the scheduled seat · guaranteed rides on the board · route pages (`trip/*`, generated) ·
the booking flow and checkout · pricing.

## Delivery (one PR each)
1. **API rule** — reaches staging on merge, prod on a promote (note: `main` also carries #618
   promo codes + migration 0050, so the promote is the owner's call).
2. **Board deep link + the inline stop** — front-end, live on merge.
3. **Search card states + "already going"** — front-end; builds on #631 (same card), so it
   follows that PR's merge.
